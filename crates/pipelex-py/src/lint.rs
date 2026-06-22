//! Staged, offline `lint_mthds` implementation.
//!
//! Mirrors the CLI's `lint_source` (`taplo-cli/src/commands/lint.rs`) staging
//! and the wasm crate's `lint` (`pipelex-wasm/src/lib.rs`), short-circuiting at
//! the **first** failing stage: syntax → semantic → schema. Per-stage
//! diagnostics are deduped exactly as the CLI prints them (syntax by range,
//! schema by coords + message + location; semantic is not deduped).
//!
//! Like `format_mthds`, this **never raises on bad content** (decision #2):
//! malformed input — including the schema stage's "errors that couldn't be
//! mapped to document positions" bail-out — is surfaced as diagnostics, not as a
//! `ValueError`.
//!
//! The schema stage validates against the embedded official MTHDS schema only
//! (`pipelex://mthds.schema.json`), fully offline: it constructs `Schemas` with
//! `http: None` and calls `validate_root` with the hardcoded builtin URL
//! directly — deliberately skipping the association machinery the CLI/wasm use
//! to *choose* a schema. There is no code path that can reach out for another
//! schema (settled decision #3). Because validation hits only the in-memory
//! builtin (no external `$ref`s, no env IO, no `spawn`), a current-thread tokio
//! runtime `block_on` is sufficient.
//!
//! **Precondition — not for use inside a Tokio runtime.** The schema stage
//! builds its *own* current-thread runtime and `block_on`s it, so calling this
//! helper from a thread that is already driving a Tokio runtime panics
//! ("Cannot start a runtime from within a runtime"). This is sound for the only
//! caller — the PyO3 wrapper (`python.rs`), invoked via `Python::allow_threads`
//! from plain Python/OS threads (e.g. a FastAPI threadpool) that have no
//! ambient runtime. We can't simply offload the `block_on` to a worker thread:
//! `Schemas::validate_root` borrows the `dom::Node` across its `.await` for
//! error-position mapping, and the DOM is `!Send` (rowan's `Rc`-based syntax
//! tree), so it cannot cross a thread boundary. A future Rust caller that needs
//! this from within a runtime must re-parse and validate on its own dedicated
//! thread.

use std::collections::HashSet;

use anyhow::Context;
use taplo::{dom, parser, rowan::TextRange};
use taplo_common::{
    environment::native::NativeEnvironment,
    schema::{builtins::MTHDS_SCHEMA_URL, Schemas},
};
use url::Url;

use crate::diagnostic::{Diagnostic, Range};

/// Lint MTHDS `content` against the embedded MTHDS schema, fully offline.
///
/// Returns the diagnostics from the first failing stage (empty == clean).
pub fn lint_mthds_impl(content: &str) -> Result<Vec<Diagnostic>, anyhow::Error> {
    // Stage 1 — syntax. Dedup by range, mirroring the CLI's
    // `print_parse_errors_compact` (`.unique_by(|e| e.range)`), so duplicate
    // parser errors at one span don't surface as repeated diagnostics.
    let parse = parser::parse(content);
    if !parse.errors.is_empty() {
        let mut seen = HashSet::new();
        return Ok(parse
            .errors
            .iter()
            .filter(|err| seen.insert(err.range))
            .map(|err| {
                Diagnostic::syntax(
                    err.message.clone(),
                    Range::from_text_range(content, err.range),
                )
            })
            .collect());
    }

    let dom = parse.into_dom();

    // Stage 2 — semantic (DOM validation). The CLI does not dedup semantic
    // errors (`print_semantic_errors_compact`), so neither do we.
    if let Err(errors) = dom.validate() {
        return Ok(errors
            .map(|err| {
                let range = semantic_error_range(&err).map(|r| Range::from_text_range(content, r));
                Diagnostic::semantic(err.to_string(), range)
            })
            .collect());
    }

    // Stage 3 — schema, offline against the embedded builtin.
    let url = Url::parse(MTHDS_SCHEMA_URL).context("invalid builtin MTHDS schema URL")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .context("failed to build tokio runtime for schema validation")?;

    let validation = runtime.block_on(async {
        // `NativeEnvironment::new()` calls `Handle::current()`, so it must be
        // constructed inside the runtime context. `http: None` is what makes
        // this provably offline — there is no client to fetch with.
        let schemas = Schemas::new(NativeEnvironment::new(), None);
        schemas.validate_root(&url, &dom).await
    });

    // Uphold the never-raise-on-bad-content contract that `format_mthds` honors
    // (settled decision #2): when validation itself fails — most notably when
    // the validator produced errors that could not be mapped to document
    // positions (`Schemas::validate_root` bails out with an error rather than
    // reporting a false-clean) — surface that as a single, location-less schema
    // diagnostic instead of propagating it out as a `ValueError`.
    let errors = match validation {
        Ok(errors) => errors,
        Err(err) => return Ok(vec![Diagnostic::schema(format!("{err:#}"), None, None)]),
    };

    // Dedup identical schema errors at the same location, mirroring the CLI's
    // `print_schema_errors_compact` (`seen_messages` keyed on coords + message
    // + instance location).
    let mut seen = HashSet::new();
    Ok(errors
        .into_iter()
        .filter_map(|err| {
            let range = err
                .primary_text_range()
                .map(|r| Range::from_text_range(content, r));
            let message = err.display_message();
            let location = err.instance_location();
            // Mirror the CLI's `print_schema_errors_compact` dedup key exactly: it
            // fabricates `(1, 1)` for a rangeless error (`None => (1, 1)`) *before*
            // keying, so a rangeless error and a genuine `1:1` error sharing a
            // message + instance location collapse to one on both surfaces. Keying
            // on `None` here would keep them as two and spuriously fail parity.
            let dedup_key = (
                range
                    .as_ref()
                    .map(|r| (r.start_line, r.start_col))
                    .unwrap_or((1, 1)),
                message.clone(),
                location.clone(),
            );
            seen.insert(dedup_key)
                .then(|| Diagnostic::schema(message, location, range))
        })
        .collect())
}

/// Derive a text range for a semantic `dom::Error`, mirroring the CLI's
/// `print_semantic_errors_compact` (`taplo-cli/src/printing.rs`) exactly so the
/// coordinates match. Some variants carry no position.
fn semantic_error_range(error: &dom::Error) -> Option<TextRange> {
    match error {
        dom::Error::ConflictingKeys { key, .. } => key.text_ranges().next(),
        dom::Error::ExpectedArrayOfTables {
            not_array_of_tables,
            ..
        } => not_array_of_tables.text_ranges().next(),
        dom::Error::ExpectedTable { not_table, .. } => not_table.text_ranges().next(),
        dom::Error::InvalidEscapeSequence { string } => Some(string.text_range()),
        dom::Error::UnexpectedSyntax { .. } | dom::Error::Query(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::DiagnosticKind;
    use std::time::{Duration, Instant};

    const VALID: &str = include_str!("../../../test-data/mthds/lint/valid.mthds");
    const INVALID_SCHEMA: &str = include_str!("../../../test-data/mthds/lint/invalid_schema.mthds");

    #[test]
    fn clean_input_has_no_diagnostics() {
        let diagnostics = lint_mthds_impl(VALID).expect("lint should succeed");
        assert!(
            diagnostics.is_empty(),
            "expected a clean lint, got: {diagnostics:?}"
        );
    }

    #[test]
    fn schema_violation_reports_schema_kind_with_location() {
        let diagnostics = lint_mthds_impl(INVALID_SCHEMA).expect("lint should succeed");
        assert!(!diagnostics.is_empty(), "expected schema diagnostics");
        assert!(
            diagnostics.iter().all(|d| d.kind == DiagnosticKind::Schema),
            "stage short-circuits to schema only"
        );
        assert!(
            diagnostics.iter().any(|d| d.location.is_some()),
            "schema errors carry a dotted instance location"
        );
    }

    #[test]
    fn inline_syntax_error_reports_syntax_kind() {
        let diagnostics = lint_mthds_impl("key = ").expect("lint should succeed");
        assert!(!diagnostics.is_empty());
        assert_eq!(diagnostics[0].kind, DiagnosticKind::Syntax);
        assert!(diagnostics[0].range.is_some());
    }

    #[test]
    fn inline_semantic_error_reports_semantic_kind() {
        // Duplicate keys parse cleanly but fail DOM validation.
        let diagnostics = lint_mthds_impl("a = 1\na = 2\n").expect("lint should succeed");
        assert!(!diagnostics.is_empty());
        assert_eq!(diagnostics[0].kind, DiagnosticKind::Semantic);
    }

    #[test]
    fn lint_is_offline_and_fast() {
        // The structural offline guarantee is `http: None` (no client to fetch
        // with); this also asserts the in-memory validation returns quickly,
        // i.e. it never blocks on a network round-trip.
        let start = Instant::now();
        let diagnostics = lint_mthds_impl(VALID).expect("lint should succeed");
        assert!(diagnostics.is_empty());
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "offline in-memory validation should be near-instant"
        );
    }
}
