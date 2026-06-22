//! Structured diagnostics shared by `format_mthds` and `lint_mthds`.
//!
//! These are pure-data `#[derive(Serialize)]` shapes — the native analog of the
//! wasm crate's `LintError`, enriched with a `kind`, a dotted `location`, and
//! codespan-style line/column coordinates. They are handed to Python via
//! `pythonize`. They are deliberately **not** behind the `python` feature so the
//! pure `format_mthds_impl` / `lint_mthds_impl` can be unit-tested without a
//! Python interpreter.

use serde::Serialize;
use taplo::rowan::TextRange;

// ⚠️ PUBLIC PYTHON SURFACE — these variants are serialized lowercase into each
// diagnostic's `kind`; mirror any change in `pipelex_tools.pyi` (`Diagnostic.kind`).
/// Which validation stage produced a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticKind {
    /// TOML/MTHDS parse error — the document is not well-formed.
    Syntax,
    /// DOM-level semantic error (e.g. conflicting keys, invalid escapes).
    Semantic,
    /// JSON-schema validation error against the embedded MTHDS schema.
    Schema,
}

// ⚠️ PUBLIC PYTHON SURFACE — serialized into each diagnostic's `range`; mirror
// any field change in `pipelex_tools.pyi` (`Range`).
/// A source range, as both raw byte offsets and 1-based codespan-style
/// line/column coordinates. Coordinates match the `plxt` CLI exactly (the
/// offset→line/col mapping is replicated from the CLI; see
/// [`offset_to_line_col`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Range {
    pub start_offset: usize,
    pub end_offset: usize,
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
}

impl Range {
    /// Build a [`Range`] from a rowan [`TextRange`] over `source`.
    #[must_use]
    pub fn from_text_range(source: &str, range: TextRange) -> Self {
        let start_offset = u32::from(range.start()) as usize;
        let end_offset = u32::from(range.end()) as usize;
        let (start_line, start_col) = offset_to_line_col(source, start_offset);
        let (end_line, end_col) = offset_to_line_col(source, end_offset);
        Self {
            start_offset,
            end_offset,
            start_line,
            start_col,
            end_line,
            end_col,
        }
    }
}

// ⚠️ PUBLIC PYTHON SURFACE — serialized into the Python diagnostic dicts via
// `pythonize`; mirror any field change in `pipelex_tools.pyi` (`Diagnostic`).
/// A single lint/format diagnostic.
///
/// Field names are kept neutral — the `pipelex-api` repo owns the wire contract
/// and will `model_validate` these. `location` and `range` are always present
/// (as `null` when absent) so the Python shape is stable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub kind: DiagnosticKind,
    /// Always `"error"` today; lint has no warnings yet. Kept for room to grow.
    pub severity: &'static str,
    pub message: String,
    /// Dotted instance path for schema errors (e.g. `"pipe.foo.model"`),
    /// `None` otherwise.
    pub location: Option<String>,
    /// Source range; `None` for semantic/schema errors that carry no position.
    pub range: Option<Range>,
}

impl Diagnostic {
    /// A `kind: "syntax"` diagnostic (always positioned).
    #[must_use]
    pub fn syntax(message: String, range: Range) -> Self {
        Self {
            kind: DiagnosticKind::Syntax,
            severity: "error",
            message,
            location: None,
            range: Some(range),
        }
    }

    /// A `kind: "semantic"` diagnostic (position may be absent for some
    /// `dom::Error` variants).
    #[must_use]
    pub fn semantic(message: String, range: Option<Range>) -> Self {
        Self {
            kind: DiagnosticKind::Semantic,
            severity: "error",
            message,
            location: None,
            range,
        }
    }

    /// A `kind: "schema"` diagnostic, carrying the dotted instance `location`.
    #[must_use]
    pub fn schema(message: String, location: Option<String>, range: Option<Range>) -> Self {
        Self {
            kind: DiagnosticKind::Schema,
            severity: "error",
            message,
            location,
            range,
        }
    }
}

/// Compute 1-based line and column from a byte offset in source text.
///
/// Replicated verbatim from `taplo-cli`'s private `printing::offset_to_line_col`
/// so binding coordinates match the CLI exactly. Replicating — rather than
/// lifting the CLI helper to a shared `pub` location — keeps this change
/// additive and touches no upstream taplo code.
#[must_use]
pub fn offset_to_line_col(source: &str, offset: usize) -> (usize, usize) {
    let offset = offset.min(source.len());
    let mut line = 1usize;
    let mut col = 1usize;
    for (i, ch) in source.char_indices() {
        if i >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

#[cfg(test)]
mod tests {
    use super::*;
    use taplo::rowan::{TextRange, TextSize};

    #[test]
    fn line_col_is_one_based_at_start() {
        assert_eq!(offset_to_line_col("abc\ndef", 0), (1, 1));
    }

    #[test]
    fn line_col_advances_columns_within_a_line() {
        // Offset 2 is the third char on line 1.
        assert_eq!(offset_to_line_col("abc\ndef", 2), (1, 3));
    }

    #[test]
    fn line_col_crosses_newlines() {
        // Offset 4 is the first char after the '\n' → line 2, col 1.
        assert_eq!(offset_to_line_col("abc\ndef", 4), (2, 1));
        // Offset 5 is the second char on line 2.
        assert_eq!(offset_to_line_col("abc\ndef", 5), (2, 2));
    }

    #[test]
    fn line_col_clamps_out_of_bounds_offset() {
        // An offset past the end clamps to the end rather than panicking.
        let src = "ab";
        assert_eq!(offset_to_line_col(src, 99), (1, 3));
    }

    #[test]
    fn range_maps_both_endpoints_to_codespan_coords() {
        // Source: "abc\ndef" — a range covering "def" on line 2.
        let src = "abc\ndef";
        let range = TextRange::new(TextSize::from(4), TextSize::from(7));
        let mapped = Range::from_text_range(src, range);
        assert_eq!(
            mapped,
            Range {
                start_offset: 4,
                end_offset: 7,
                start_line: 2,
                start_col: 1,
                end_line: 2,
                end_col: 4,
            }
        );
    }
}
