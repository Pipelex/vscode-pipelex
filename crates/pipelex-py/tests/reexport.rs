//! Guards the re-export wiring: the binding crate exposes the shared engine
//! from `pipelex_common::tools` under the same paths the PyO3 glue and the
//! `pipelex-cli` parity suite import (`pipelex_tools::{diagnostic, format,
//! lint}`). A broken re-export fails to compile here before it can break a
//! downstream consumer.

use pipelex_tools::diagnostic::DiagnosticKind;
use pipelex_tools::format::format_mthds_impl;
use pipelex_tools::lint::lint_mthds_impl;

#[test]
fn reexported_format_is_the_shared_engine() {
    let outcome = format_mthds_impl("a=1", &[]).expect("format should succeed");
    assert!(outcome.changed);
    assert_eq!(outcome.formatted, "a = 1\n");
}

#[test]
fn reexported_lint_is_the_shared_engine() {
    let diagnostics = lint_mthds_impl("key = ").expect("lint should succeed");
    assert_eq!(diagnostics[0].kind, DiagnosticKind::Syntax);
}
