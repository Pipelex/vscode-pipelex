//! Pure, synchronous `format_mthds` implementation.
//!
//! Mirrors the wasm crate's `format` (`pipelex-wasm/src/lib.rs`) and the CLI's
//! `format_stdin` (`taplo-cli/src/commands/format.rs`), but with **no config
//! discovery** and **no `Environment`**: the canonical MTHDS formatting defaults
//! are baked in (so server output matches what the extension writes on save),
//! and the caller may override any of them.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use taplo::{formatter, parser};
use taplo_common::config::Config;

use crate::diagnostic::{Diagnostic, Range};

// ⚠️ PUBLIC PYTHON SURFACE — serialized into the `format_mthds` dict via `pythonize`.
// Mirror any field change in the hand-maintained stub `pipelex_tools.pyi` (`FormatResult`);
// nothing enforces the match at compile time.
/// Result of [`format_mthds_impl`] — the native analog of the binding's
/// `{ "formatted", "changed", "diagnostics" }` dict.
#[derive(Debug, Clone, Serialize)]
pub struct FormatOutcome {
    /// The formatted document. On a syntax error this is the input verbatim.
    pub formatted: String,
    /// Whether `formatted` differs from the input.
    pub changed: bool,
    /// Blocking syntax diagnostics, or empty on success.
    pub diagnostics: Vec<Diagnostic>,
}

/// The canonical MTHDS formatting options.
///
/// These are the effective `**/*.mthds` settings from this repo's `plxt.toml`
/// (global `[formatting]` merged with the `**/*.mthds` rule), spelled out as a
/// full struct literal so the baked defaults are self-documenting — and so a new
/// upstream `formatter::Options` field forces a conscious choice here rather than
/// silently inheriting taplo's default.
fn mthds_format_options() -> formatter::Options {
    formatter::Options {
        align_entries: true,
        align_comments: true,
        align_single_comments: true,
        array_trailing_comma: true,
        array_auto_expand: true,
        array_auto_collapse: false,
        inline_table_expand: true,
        compact_arrays: true,
        compact_inline_tables: false,
        compact_entries: false,
        column_width: 80,
        indent_tables: false,
        indent_entries: false,
        indent_string: "  ".to_owned(),
        trailing_newline: true,
        reorder_keys: false,
        reorder_arrays: false,
        reorder_inline_tables: false,
        allowed_blank_lines: 2,
        crlf: false,
    }
}

/// Format MTHDS/TOML `content`, applying the canonical MTHDS defaults overlaid
/// with the caller's `options` (snake_case `key`/`value` string pairs, exactly
/// like the CLI's `-o key=value`).
///
/// On a syntax error this returns the input unchanged with the blocking syntax
/// diagnostics — it does **not** raise (settled decision #2: the CLI's
/// no-`--force` behavior, surfaced as data).
pub fn format_mthds_impl(
    content: &str,
    options: &[(String, String)],
) -> Result<FormatOutcome, anyhow::Error> {
    // Validate/apply caller options first so a bad option value is rejected
    // consistently, regardless of whether `content` parses (settled contract:
    // `ValueError` is raised only — and always — for malformed options).
    let mut format_opts = mthds_format_options();
    format_opts.update_from_str(
        options
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str())),
    )?;

    let syntax = parser::parse(content);

    if !syntax.errors.is_empty() {
        // Dedup by range, mirroring the CLI's syntax printer
        // (`.unique_by(|e| e.range)`), so duplicate parser errors at one span
        // don't surface as repeated diagnostics.
        let mut seen = HashSet::new();
        let diagnostics = syntax
            .errors
            .iter()
            .filter(|err| seen.insert(err.range))
            .map(|err| {
                Diagnostic::syntax(
                    err.message.clone(),
                    Range::from_text_range(content, err.range),
                )
            })
            .collect();
        return Ok(FormatOutcome {
            formatted: content.to_owned(),
            changed: false,
            diagnostics,
        });
    }

    // `Config::default().format_scopes("")` yields the correct (empty) scopes
    // with no filesystem touch — the same call the wasm crate makes. There are
    // no syntax errors here, so the error-ranges slice is empty.
    let formatted = formatter::format_with_path_scopes(
        syntax.into_dom(),
        format_opts,
        &[],
        Config::default().format_scopes(Path::new("")),
    )
    .map_err(|err| anyhow::anyhow!("invalid key pattern: {err}"))?;

    let changed = formatted != content;

    Ok(FormatOutcome {
        formatted,
        changed,
        diagnostics: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::DiagnosticKind;

    const VALID: &str = include_str!("../../../test-data/mthds/lint/valid.mthds");
    const PIPE_DEFINITIONS: &str = include_str!("../../../test-data/mthds/pipe-definitions.mthds");
    const STEPS: &str = include_str!("../../../test-data/mthds/steps.mthds");
    const CONCEPT_TABLES: &str = include_str!("../../../test-data/mthds/concept-tables.mthds");

    fn format(content: &str) -> FormatOutcome {
        format_mthds_impl(content, &[]).expect("format should not error on valid input")
    }

    #[test]
    fn formatting_is_idempotent_on_the_corpus() {
        // Formatting an already-formatted document is a no-op: the canonical
        // output is a fixed point of the formatter.
        for fixture in [VALID, PIPE_DEFINITIONS, STEPS, CONCEPT_TABLES] {
            let once = format(fixture);
            assert!(once.diagnostics.is_empty());
            let twice = format(&once.formatted);
            assert!(!twice.changed, "second format should report no change");
            assert_eq!(twice.formatted, once.formatted, "format is not idempotent");
        }
    }

    #[test]
    fn already_canonical_input_reports_unchanged() {
        // `valid.mthds` is checked in already in canonical MTHDS style.
        let outcome = format(VALID);
        assert!(!outcome.changed);
        assert_eq!(outcome.formatted, VALID);
    }

    #[test]
    fn unformatted_valid_input_becomes_canonical() {
        let outcome = format("a=1");
        assert!(outcome.changed);
        // compact_entries=false → spaces around `=`; trailing_newline=true.
        assert_eq!(outcome.formatted, "a = 1\n");
        assert!(outcome.diagnostics.is_empty());
    }

    #[test]
    fn baked_default_aligns_consecutive_entries() {
        // The canonical MTHDS default has align_entries=true.
        let outcome = format("a = 1\nbb = 2\n");
        assert_eq!(outcome.formatted, "a  = 1\nbb = 2\n");
    }

    #[test]
    fn caller_option_overrides_baked_default() {
        // Overriding align_entries=false beats the baked default.
        let outcome = format_mthds_impl(
            "a = 1\nbb = 2\n",
            &[("align_entries".to_owned(), "false".to_owned())],
        )
        .expect("override should apply cleanly");
        assert_eq!(outcome.formatted, "a = 1\nbb = 2\n");
    }

    #[test]
    fn syntax_error_returns_input_unchanged_with_diagnostic() {
        // An incomplete entry is a parse error.
        let input = "key = ";
        let outcome = format_mthds_impl(input, &[]).expect("must not raise on syntax error");
        assert!(!outcome.changed, "syntax error must not change content");
        assert_eq!(outcome.formatted, input, "content returned verbatim");
        assert!(
            !outcome.diagnostics.is_empty(),
            "must surface the blocking error"
        );
        let diag = &outcome.diagnostics[0];
        assert_eq!(diag.kind, DiagnosticKind::Syntax);
        assert_eq!(diag.severity, "error");
        assert!(diag.range.is_some(), "syntax diagnostics are positioned");
    }

    #[test]
    fn syntax_diagnostic_range_uses_one_based_coords() {
        // Error is on the second line; assert the reported range is 1-based.
        let input = "a = 1\nb = =\n";
        let outcome = format_mthds_impl(input, &[]).expect("must not raise");
        let diag = outcome
            .diagnostics
            .first()
            .expect("expected a syntax diagnostic");
        let range = diag.range.as_ref().expect("syntax diag has a range");
        assert_eq!(range.start_line, 2, "error sits on the second line");
    }

    #[test]
    fn malformed_option_value_is_an_error() {
        // `column_width` parses as usize; a non-numeric value is rejected.
        let result =
            format_mthds_impl("a = 1\n", &[("column_width".to_owned(), "wide".to_owned())]);
        assert!(result.is_err(), "a bad option value should error");
    }

    #[test]
    fn malformed_option_value_errors_even_with_syntax_error() {
        // Option validation must not depend on whether the content parses:
        // a bad option value is rejected before the syntax short-circuit.
        let result = format_mthds_impl("key = ", &[("column_width".to_owned(), "wide".to_owned())]);
        assert!(
            result.is_err(),
            "bad option value must error regardless of syntax errors"
        );
    }
}
