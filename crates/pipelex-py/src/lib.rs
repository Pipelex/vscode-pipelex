//! Python bindings for Pipelex Tools — the `pipelex_tools` extension module.
//!
//! This crate is **library-only**: it produces the `pipelex_tools` Python
//! extension module (MTHDS lint & format as importable functions), shipped as
//! the `pipelex-tools-lib` wheel via maturin's `pyo3` bindings. The native
//! `plxt` CLI is a separate concern — it stays in `pipelex-cli` and ships as the
//! `pipelex-tools` wheel via maturin's `bin` bindings (maturin cannot package a
//! native binary and a pyo3 cdylib in the same wheel).
//!
//! The PyO3 glue lives in [`python`] and is gated behind the `python` cargo
//! feature so that plain `cargo build` / `cargo test` stay PyO3-free. The pure
//! lint/format logic (added in later phases) is *not* gated, so it compiles and
//! unit-tests without a Python interpreter.

#[cfg(feature = "python")]
mod python;
