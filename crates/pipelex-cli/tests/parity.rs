//! Parity tests: the in-process `pipelex_tools` library must agree with the
//! shipped `plxt` CLI on the same inputs, so the library and the binary can't
//! drift. This is testing-strategy level #2 from the bindings plan — the bridge
//! between the Rust unit tests (level #1) and the Python e2e wheel smoke test
//! (level #3).
//!
//! **Why this lives in `pipelex-cli`, not `pipelex-py`.** Cargo only sets
//! `CARGO_BIN_EXE_plxt` for the crate that owns the `plxt` bin (this one). The
//! `pipelex_tools` library is pulled in as a *dev-dependency* (`pipelex-py`,
//! `python` feature off → pure Rust, no PyO3), so the test can call the same
//! `format_mthds_impl` / `lint_mthds_impl` the wheel exposes.
//!
//! **How parity is asserted.**
//! - **format:** `plxt fmt -` is driven through the repo's `plxt.toml`
//!   `**/*.mthds` rule (CWD = repo root, synthetic `parity.mthds` stdin path) so
//!   the CLI applies exactly the options the binding bakes in. Byte-identical
//!   output is required — so editing the baked struct *or* `plxt.toml`'s MTHDS
//!   rule without the other drifts and fails here.
//! - **lint:** `plxt lint --schema pipelex://mthds.schema.json -` validates stdin
//!   against the same embedded MTHDS schema the binding uses, fully offline. The
//!   CLI's compact one-line diagnostics (`-:L:C: error[kind]: msg (in loc)`) are
//!   parsed back into structured form and compared as a sorted multiset against
//!   the binding's diagnostics — coordinates, kind, message, and instance
//!   location. This also pins the shared dedup semantics (syntax by range, schema
//!   by coords+msg+location, semantic not deduped).
//!
//!   The CLI is pointed at the **builtin URL**, not at the schema *file* via
//!   `--schema-path`. That matters: loading the schema from a `file://` path
//!   resolves its internal `$ref`s under a different base URI, which collapses an
//!   MTHDS pipe's `oneOf` branch errors into a single "does not match any of the
//!   allowed schemas". The binding (and the extension/hook in production) validate
//!   against the builtin `pipelex://mthds.schema.json`, so the parity probe must
//!   too — otherwise it would compare two genuinely different error sets.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use pipelex_tools::diagnostic::{Diagnostic, DiagnosticKind};
use pipelex_tools::format::format_mthds_impl;
use pipelex_tools::lint::lint_mthds_impl;
use taplo_common::schema::builtins::MTHDS_SCHEMA_URL;

/// Repo root, resolved from this crate's manifest dir (`<root>/crates/pipelex-cli`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should resolve")
}

/// Every `.mthds` fixture under `test-data/mthds/`, discovered by recursing the
/// whole tree (not a hardcoded dir list) so a fixture added in any current or
/// future subdirectory — `lint/`, `hover/`, `goto-definition/`, … — is
/// parity-checked automatically.
fn mthds_fixtures() -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_mthds_fixtures(&repo_root().join("test-data/mthds"), &mut files);
    files.sort();
    files
}

/// Recursively collect every `.mthds` file under `dir` into `files`.
fn collect_mthds_fixtures(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("fixture dir should be readable") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_mthds_fixtures(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("mthds") {
            files.push(path);
        }
    }
}

/// Spawn `plxt` with `args` (optionally in `current_dir`), feed it `content` on
/// stdin **from a writer thread**, and return the captured output. The writer
/// thread is what keeps this deadlock-free: writing the whole input inline and
/// only then draining the child would wedge on any fixture whose `plxt` output
/// overflows the OS pipe buffer (~64 KiB) mid-write — child blocked writing
/// output, parent blocked writing input. Draining stdout/stderr (via
/// `wait_with_output`) concurrently with the write avoids that.
fn run_plxt(current_dir: Option<&Path>, args: &[&str], content: &str) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_plxt"));
    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }
    let mut child = command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn plxt");
    let mut stdin = child.stdin.take().expect("plxt stdin");
    let content = content.to_owned();
    let writer = std::thread::spawn(move || stdin.write_all(content.as_bytes()));
    let output = child.wait_with_output().expect("wait for plxt");
    // A `BrokenPipe` here just means `plxt` closed stdin early (e.g. it bailed on
    // a parse error before consuming all input); the real diagnostic is on stderr,
    // so it is not a harness failure. Any other write error is a genuine fault.
    match writer.join().expect("stdin writer thread panicked") {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => {}
        Err(err) => panic!("write plxt stdin: {err}"),
    }
    output
}

/// Run `plxt fmt -` on `content` through the repo `plxt.toml` MTHDS rule and
/// return the formatted stdout. Panics if the CLI exits non-zero.
fn plxt_fmt(content: &str) -> String {
    // CWD = repo root so the config's rule globs (which taplo resolves against the
    // CWD, not the config file's dir) match the synthetic stdin path.
    let root = repo_root();
    let output = run_plxt(
        Some(&root),
        &[
            "fmt",
            "--config",
            "plxt.toml",
            "--stdin-filepath",
            "parity.mthds",
            "-",
        ],
        content,
    );
    assert!(
        output.status.success(),
        "plxt fmt exited {:?}; stderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("plxt fmt stdout is utf-8")
}

/// A diagnostic in the CLI's compact projection: position, kind keyword, and the
/// trailing text (`msg` plus the schema `(in location)` suffix). Both the parsed
/// CLI output and the binding's diagnostics are normalized into this shape so
/// they can be compared directly.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct CompactDiag {
    line: usize,
    col: usize,
    kind: String,
    rest: String,
}

/// Parse one compact line `-:L:C: error[kind]: rest`. Returns `None` for the
/// trailing `Found N error(s) in -` summary and any non-diagnostic line.
fn parse_compact_line(line: &str) -> Option<CompactDiag> {
    let marker = ": error[";
    let marker_at = line.find(marker)?;
    let (location, after) = line.split_at(marker_at);
    let after = &after[marker.len()..];
    let kind_end = after.find("]: ")?;
    let kind = after[..kind_end].to_owned();
    let rest = after[kind_end + "]: ".len()..].to_owned();

    // `location` is `-:L:C` — the `-` is the stdin display path.
    let coords = location.strip_prefix("-:")?;
    let mut parts = coords.splitn(2, ':');
    let line_no = parts.next()?.parse().ok()?;
    let col_no = parts.next()?.parse().ok()?;

    Some(CompactDiag {
        line: line_no,
        col: col_no,
        kind,
        rest,
    })
}

/// Parse every compact diagnostic out of `plxt lint`'s stderr. Each diagnostic
/// opens with a `-:L:C: error[kind]: ` prefix; a message that itself spans
/// multiple lines is emitted across several physical lines, so any line that
/// neither opens a new diagnostic nor is the `Found N error(s)` trailer is folded
/// back into the previous diagnostic's `rest` — keeping it equal to the binding's
/// single-string message rather than silently dropping the continuation. (`plxt
/// lint --quiet` emits only diagnostics and that trailer on stderr, so there is no
/// log noise to mis-fold.)
fn parse_compact_diags(stderr: &str) -> Vec<CompactDiag> {
    let mut diags: Vec<CompactDiag> = Vec::new();
    for line in stderr.lines() {
        if let Some(diag) = parse_compact_line(line) {
            diags.push(diag);
        } else if is_summary_line(line) {
            // The `Found N error(s) in -` trailer closes the stream; not a message.
        } else if let Some(last) = diags.last_mut() {
            last.rest.push('\n');
            last.rest.push_str(line);
        }
        // A stray line before the first diagnostic has nothing to attach to; drop.
    }
    diags
}

/// The compact trailer `Found N error(s) in <path>`, which must not be folded
/// into the preceding diagnostic's message.
fn is_summary_line(line: &str) -> bool {
    line.starts_with("Found ") && line.contains(" error(s) in ")
}

/// Run `plxt lint --schema <builtin URL> -` on `content`, offline, and return the
/// parsed compact diagnostics (empty == clean). Sorted for set comparison.
///
/// The CLI is pinned to the builtin schema URL (its command-line priority outranks
/// any in-document `#:schema` directive) so it validates against exactly the
/// embedded MTHDS schema the binding hardcodes: the binding skips the CLI's
/// schema-association step by design (see `lint.rs`), so the probe removes
/// association as a variable rather than relying on it implicitly.
fn plxt_lint(content: &str) -> Vec<CompactDiag> {
    let output = run_plxt(
        None,
        &[
            "lint",
            "--quiet",
            "--no-auto-config",
            "--schema",
            MTHDS_SCHEMA_URL,
            "-",
        ],
        content,
    );

    let stderr = String::from_utf8(output.stderr).expect("plxt lint stderr is utf-8");
    let mut diags = parse_compact_diags(&stderr);
    // A clean lint exits 0 with no diagnostics; any diagnostic means a non-zero
    // exit. If the CLI exits non-zero yet we parsed nothing, the fault is in the
    // CLI itself (the schema waterfall erroring out, a log line leaking past
    // `--quiet`, …), not a lint-parity diff — surface its stderr verbatim instead
    // of a bare boolean mismatch that would mask the cause.
    if diags.is_empty() && !output.status.success() {
        panic!(
            "plxt lint exited {:?} without emitting a parseable diagnostic; stderr:\n{stderr}",
            output.status.code()
        );
    }
    assert_eq!(
        diags.is_empty(),
        output.status.success(),
        "plxt lint exit/diagnostic mismatch (exit {:?}); stderr:\n{stderr}",
        output.status.code()
    );
    diags.sort();
    diags
}

/// Project a binding [`Diagnostic`] into the CLI's compact shape so the two can
/// be compared. Mirrors the compact printers in `taplo-cli/src/printing.rs`:
/// rangeless errors render at `1:1` (the CLI fabricates that coordinate), and
/// schema errors append ` (in <location>)`.
fn binding_to_compact(diag: &Diagnostic) -> CompactDiag {
    let (line, col) = match &diag.range {
        Some(range) => (range.start_line, range.start_col),
        None => (1, 1),
    };
    let kind = match diag.kind {
        DiagnosticKind::Syntax => "syntax",
        DiagnosticKind::Semantic => "semantic",
        DiagnosticKind::Schema => "schema",
    }
    .to_owned();
    let rest = match &diag.location {
        Some(location) => format!("{} (in {})", diag.message, location),
        None => diag.message.clone(),
    };
    CompactDiag {
        line,
        col,
        kind,
        rest,
    }
}

fn binding_lint_compact(content: &str) -> Vec<CompactDiag> {
    let mut diags: Vec<CompactDiag> = lint_mthds_impl(content)
        .expect("binding lint should not raise")
        .iter()
        .map(binding_to_compact)
        .collect();
    diags.sort();
    diags
}

#[test]
fn format_matches_cli_on_every_fixture() {
    for fixture in mthds_fixtures() {
        let content = std::fs::read_to_string(&fixture).expect("read fixture");
        let outcome =
            format_mthds_impl(&content, &[]).expect("binding format should not raise on a fixture");
        // The whole corpus is syntactically clean; guard anyway so a future
        // syntax-error fixture (where the CLI errors and emits no stdout) is
        // skipped rather than spuriously failing.
        if !outcome.diagnostics.is_empty() {
            continue;
        }
        let cli = plxt_fmt(&content);
        assert_eq!(
            outcome.formatted,
            cli,
            "format drift on {}: the baked MTHDS options no longer match `plxt fmt` (plxt.toml)",
            fixture.display()
        );
    }
}

#[test]
fn lint_matches_cli_on_every_fixture() {
    for fixture in mthds_fixtures() {
        let content = std::fs::read_to_string(&fixture).expect("read fixture");
        assert_eq!(
            binding_lint_compact(&content),
            plxt_lint(&content),
            "lint drift on {}",
            fixture.display()
        );
    }
}

#[test]
fn lint_matches_cli_on_inline_syntax_error() {
    // An incomplete entry never reaches semantic/schema staging on either side.
    let content = "key = ";
    let binding = binding_lint_compact(content);
    assert_eq!(binding, plxt_lint(content));
    assert!(binding.iter().all(|diag| diag.kind == "syntax"));
    assert!(!binding.is_empty());
}

#[test]
fn lint_matches_cli_on_inline_semantic_error() {
    // Duplicate keys parse cleanly but fail DOM validation — semantic stage.
    let content = "a = 1\na = 2\n";
    let binding = binding_lint_compact(content);
    assert_eq!(binding, plxt_lint(content));
    assert!(binding.iter().all(|diag| diag.kind == "semantic"));
    assert!(!binding.is_empty());
}

#[test]
fn format_matches_cli_when_canonicalizing_unformatted_input() {
    // A hermetic case independent of the fixtures: an unaligned pair becomes the
    // canonical aligned MTHDS form, identically on both sides.
    let content = "a = 1\nbb = 2\n";
    let outcome = format_mthds_impl(content, &[]).expect("binding format");
    assert_eq!(outcome.formatted, plxt_fmt(content));
    assert_eq!(outcome.formatted, "a  = 1\nbb = 2\n");
}
