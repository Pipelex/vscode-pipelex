//! The vendored MTHDS Test Corpus must still be *accepted* by this toolchain —
//! not merely handled consistently by it.
//!
//! **Why this is a separate suite from `parity.rs`.** Parity asserts that the
//! in-process `pipelex_tools` library and the shipped `plxt` binary agree on the
//! same input. That is a real property, and it is deliberately *not* a
//! correctness property: two identical **non-empty** diagnostic sets satisfy it
//! exactly as well as two empty ones. So parity stays green when the toolchain
//! rejects a corpus entry, as long as it rejects it the same way twice — which is
//! precisely the regression the vendoring exists to catch. `test-data/mthds/`
//! makes that concrete: most of its fixtures are curated bad MTHDS that `plxt`
//! rejects, and parity is green over them.
//!
//! **The failure this closes.** `pipelex` adds a pipe kind or a field, the
//! `mthds.schema.json` vendored here goes stale, a corpus re-sync lands, and CI
//! stays green while the toolchain has silently stopped accepting the canonical
//! corpus. Requiring the corpus to lint clean turns that into a red build in the
//! same commit that syncs it.
//!
//! **What this does not prove.** `plxt lint` is TOML syntax plus JSON Schema
//! validation, so this checks that every entry is *structurally acceptable* MTHDS.
//! It does not resolve concept or pipe references — a bundle whose `output` names
//! a concept that exists nowhere lints clean — and it says nothing about whether
//! an entry produces the verdict the corpus declares for it. That second half
//! needs the `pipelex` runtime rather than this toolchain; see
//! `wip/corpus-conformance-gap.md`.
//!
//! **Why the library and not the binary.** `parity.rs` already pins the two
//! together over this same tree, so spawning `plxt` once per entry would re-prove
//! that at the cost of a process per file. `lint_mthds_impl` validates against the
//! same embedded MTHDS schema the CLI is pointed at there.

use std::path::{Path, PathBuf};

use pipelex_tools::lint::lint_mthds_impl;

/// Repo root, resolved from this crate's manifest dir (`<root>/crates/pipelex-cli`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should resolve")
}

/// Every `.mthds` file in the vendored corpus, discovered by recursing the tree
/// rather than from a list, so a newly synced entry is swept with no wiring here.
///
/// Scoped to `test-data/mthds-corpus/` alone. The repo's own `test-data/mthds/`
/// is deliberately excluded: it holds negative fixtures whose whole purpose is to
/// be rejected, so sweeping both trees would assert the opposite of what each one
/// is for.
fn corpus_fixtures() -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_mthds_fixtures(&repo_root().join("test-data/mthds-corpus"), &mut files);
    files.sort();
    files
}

/// Recursively collect every `.mthds` file under `dir` into `files`.
fn collect_mthds_fixtures(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("corpus dir should be readable") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_mthds_fixtures(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("mthds") {
            files.push(path);
        }
    }
}

#[test]
fn every_corpus_bundle_lints_clean() {
    let fixtures = corpus_fixtures();
    // A sweep that discovers nothing passes trivially, which would hide exactly
    // the situation worth knowing about: the corpus moved, or a sync emptied it.
    assert!(
        !fixtures.is_empty(),
        "no .mthds files found under test-data/mthds-corpus — the vendored corpus \
         is missing or empty, so this gate would pass without checking anything"
    );

    for fixture in fixtures {
        let content = std::fs::read_to_string(&fixture).expect("read corpus fixture");
        let diagnostics = lint_mthds_impl(&content).expect("binding lint should not raise");
        // Every vendored entry declares `validity = "valid"` today. When the
        // corpus grows curated invalid entries, this must read the entry's
        // `entry.toml` and require a diagnostic for those instead of none.
        assert!(
            diagnostics.is_empty(),
            "corpus entry {} no longer lints clean — the vendored mthds.schema.json \
             has most likely gone stale against the corpus: {diagnostics:?}",
            fixture.display()
        );
    }
}
