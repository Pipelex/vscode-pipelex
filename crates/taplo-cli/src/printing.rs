use crate::Taplo;
use codespan_reporting::{
    diagnostic::{Diagnostic, Label},
    files::SimpleFile,
    term::{
        self,
        termcolor::{Ansi, NoColor},
    },
};
use itertools::Itertools;
#[cfg(feature = "lint")]
use std::collections::HashSet;
use std::ops::Range;
#[cfg(feature = "lint")]
use std::path::Path;
use taplo::{dom, parser, rowan::TextRange};
use taplo_common::environment::Environment;
#[cfg(feature = "lint")]
use taplo_common::schema::NodeValidationError;
use tokio::io::AsyncWriteExt;

impl<E: Environment> Taplo<E> {
    pub(crate) async fn print_parse_errors(
        &self,
        file: &SimpleFile<&str, &str>,
        errors: &[parser::Error],
    ) -> Result<(), anyhow::Error> {
        let mut out_diag = Vec::<u8>::new();

        let config = codespan_reporting::term::Config::default();

        for error in errors.iter().unique_by(|e| e.range) {
            let diag = Diagnostic::error()
                .with_message("invalid TOML")
                .with_labels(Vec::from([
                    Label::primary((), std_range(error.range)).with_message(&error.message)
                ]));

            if self.colors {
                term::emit(&mut Ansi::new(&mut out_diag), &config, file, &diag)?;
            } else {
                term::emit(&mut NoColor::new(&mut out_diag), &config, file, &diag)?;
            }
        }

        let mut stderr = self.env.stderr();

        stderr.write_all(&out_diag).await?;
        stderr.flush().await?;

        Ok(())
    }

    pub(crate) async fn print_semantic_errors(
        &self,
        file: &SimpleFile<&str, &str>,
        errors: impl Iterator<Item = dom::Error>,
    ) -> Result<(), anyhow::Error> {
        let mut out_diag = Vec::<u8>::new();

        let config = codespan_reporting::term::Config::default();

        for error in errors {
            let diag = match &error {
                dom::Error::ConflictingKeys { key, other } => Diagnostic::error()
                    .with_message(error.to_string())
                    .with_labels(Vec::from([
                        Label::primary((), std_range(key.text_ranges().next().unwrap()))
                            .with_message("duplicate key"),
                        Label::secondary((), std_range(other.text_ranges().next().unwrap()))
                            .with_message("duplicate found here"),
                    ])),
                dom::Error::ExpectedArrayOfTables {
                    not_array_of_tables,
                    required_by,
                } => Diagnostic::error()
                    .with_message(error.to_string())
                    .with_labels(Vec::from([
                        Label::primary(
                            (),
                            std_range(not_array_of_tables.text_ranges().next().unwrap()),
                        )
                        .with_message("expected array of tables"),
                        Label::secondary((), std_range(required_by.text_ranges().next().unwrap()))
                            .with_message("required by this key"),
                    ])),
                dom::Error::ExpectedTable {
                    not_table,
                    required_by,
                } => Diagnostic::error()
                    .with_message(error.to_string())
                    .with_labels(Vec::from([
                        Label::primary((), std_range(not_table.text_ranges().next().unwrap()))
                            .with_message("expected table"),
                        Label::secondary((), std_range(required_by.text_ranges().next().unwrap()))
                            .with_message("required by this key"),
                    ])),
                dom::Error::InvalidEscapeSequence { string } => Diagnostic::error()
                    .with_message(error.to_string())
                    .with_labels(Vec::from([Label::primary(
                        (),
                        std_range(string.text_range()),
                    )
                    .with_message("the string contains invalid escape sequences")])),
                _ => {
                    unreachable!("this is a bug")
                }
            };

            if self.colors {
                term::emit(&mut Ansi::new(&mut out_diag), &config, file, &diag)?;
            } else {
                term::emit(&mut NoColor::new(&mut out_diag), &config, file, &diag)?;
            }
        }
        let mut stderr = self.env.stderr();
        stderr.write_all(&out_diag).await?;
        stderr.flush().await?;
        Ok(())
    }

    #[cfg(feature = "lint")]
    pub(crate) async fn print_schema_errors(
        &self,
        file: &SimpleFile<&str, &str>,
        errors: &[NodeValidationError],
    ) -> Result<(), anyhow::Error> {
        let config = codespan_reporting::term::Config::default();

        let mut out_diag = Vec::<u8>::new();
        for err in errors {
            let msg = err.display_message();
            for text_range in err.text_ranges() {
                let diag = Diagnostic::error()
                    .with_message(&msg)
                    .with_labels(Vec::from([
                        Label::primary((), std_range(text_range)).with_message(&msg)
                    ]));

                if self.colors {
                    term::emit(&mut Ansi::new(&mut out_diag), &config, file, &diag)?;
                } else {
                    term::emit(&mut NoColor::new(&mut out_diag), &config, file, &diag)?;
                };
            }
        }
        let mut stderr = self.env.stderr();
        stderr.write_all(&out_diag).await?;
        stderr.flush().await?;

        Ok(())
    }
}

fn std_range(range: TextRange) -> Range<usize> {
    let start: usize = u32::from(range.start()) as _;
    let end: usize = u32::from(range.end()) as _;
    start..end
}

/// Compute 1-based line and column from a byte offset in source text.
#[cfg(feature = "lint")]
fn offset_to_line_col(source: &str, offset: usize) -> (usize, usize) {
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

/// Make a path relative to cwd, or return as-is if not under cwd.
#[cfg(feature = "lint")]
fn relative_path(file_path: &str, cwd: &Path) -> String {
    let p = Path::new(file_path);
    p.strip_prefix(cwd)
        .map(|rel| rel.to_string_lossy().into_owned())
        .unwrap_or_else(|_| file_path.to_string())
}

#[cfg(feature = "lint")]
impl<E: Environment> Taplo<E> {
    /// Compact one-line format for parse errors: `file:line:col: error[syntax]: message`
    pub(crate) async fn print_parse_errors_compact(
        &self,
        file_path: &str,
        source: &str,
        errors: &[parser::Error],
        cwd: &Path,
    ) -> Result<(), anyhow::Error> {
        let rel = relative_path(file_path, cwd);
        let mut out = Vec::<u8>::new();
        let mut count = 0usize;

        for error in errors.iter().unique_by(|e| e.range) {
            count += 1;
            let start: usize = u32::from(error.range.start()) as _;
            let (line, col) = offset_to_line_col(source, start);
            out.extend_from_slice(
                format!(
                    "{}:{}:{}: error[syntax]: {}\n",
                    rel, line, col, error.message
                )
                .as_bytes(),
            );
        }

        if count > 0 {
            out.extend_from_slice(format!("Found {} error(s) in {}\n", count, rel).as_bytes());
        }

        let mut stderr = self.env.stderr();
        stderr.write_all(&out).await?;
        stderr.flush().await?;
        Ok(())
    }

    /// Compact one-line format for semantic errors: `file:line:col: error[semantic]: message`
    pub(crate) async fn print_semantic_errors_compact(
        &self,
        file_path: &str,
        source: &str,
        errors: impl Iterator<Item = dom::Error>,
        cwd: &Path,
    ) -> Result<(), anyhow::Error> {
        let rel = relative_path(file_path, cwd);
        let mut out = Vec::<u8>::new();
        let mut count = 0usize;

        for error in errors {
            count += 1;
            let range = match &error {
                dom::Error::ConflictingKeys { key, .. } => key.text_ranges().next(),
                dom::Error::ExpectedArrayOfTables {
                    not_array_of_tables,
                    ..
                } => not_array_of_tables.text_ranges().next(),
                dom::Error::ExpectedTable { not_table, .. } => not_table.text_ranges().next(),
                dom::Error::InvalidEscapeSequence { string } => Some(string.text_range()),
                dom::Error::UnexpectedSyntax { .. } | dom::Error::Query(_) => None,
            };
            let (line, col) = match range {
                Some(r) => offset_to_line_col(source, u32::from(r.start()) as usize),
                None => (1, 1),
            };
            out.extend_from_slice(
                format!("{}:{}:{}: error[semantic]: {}\n", rel, line, col, error).as_bytes(),
            );
        }

        if count > 0 {
            out.extend_from_slice(format!("Found {} error(s) in {}\n", count, rel).as_bytes());
        }

        let mut stderr = self.env.stderr();
        stderr.write_all(&out).await?;
        stderr.flush().await?;
        Ok(())
    }

    /// Compact one-line format for schema errors: `file:line:col: error[schema]: message (in pipe.name)`
    /// Deduplicates errors with the same message and location.
    pub(crate) async fn print_schema_errors_compact(
        &self,
        file_path: &str,
        source: &str,
        errors: &[NodeValidationError],
        cwd: &Path,
    ) -> Result<(), anyhow::Error> {
        let rel = relative_path(file_path, cwd);
        let mut out = Vec::<u8>::new();
        let mut seen_messages = HashSet::new();
        let mut count = 0usize;

        for err in errors {
            let msg = err.display_message();

            let (line, col) = match err.primary_text_range() {
                Some(r) => offset_to_line_col(source, u32::from(r.start()) as usize),
                None => (1, 1),
            };

            let location_suffix = match err.instance_location() {
                Some(loc) => format!(" (in {})", loc),
                None => String::new(),
            };

            // Deduplicate: skip errors with identical message AND location
            let dedup_key = format!("{}:{}:{}{}", line, col, msg, location_suffix);
            if !seen_messages.insert(dedup_key) {
                continue;
            }
            count += 1;

            out.extend_from_slice(
                format!(
                    "{}:{}:{}: error[schema]: {}{}\n",
                    rel, line, col, msg, location_suffix
                )
                .as_bytes(),
            );
        }

        if count > 0 {
            out.extend_from_slice(format!("Found {} error(s) in {}\n", count, rel).as_bytes());
        }

        let mut stderr = self.env.stderr();
        stderr.write_all(&out).await?;
        stderr.flush().await?;
        Ok(())
    }
}
