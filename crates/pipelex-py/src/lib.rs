//! Python bindings for Pipelex Tools — the `pipelex_tools` extension module.
//!
//! This crate is **library-only**: it produces the `pipelex_tools` Python
//! extension module (MTHDS lint & format as importable functions), shipped as
//! the `pipelex-tools-py` wheel via maturin's `pyo3` bindings. The native
//! `plxt` CLI is a separate concern — it stays in `pipelex-cli` and ships as the
//! `pipelex-tools` wheel via maturin's `bin` bindings (maturin cannot package a
//! native binary and a pyo3 cdylib in the same wheel).
//!
//! The lint/format engine itself lives in `pipelex_common::tools` (the shared
//! impl behind this wheel and the `@pipelex/tools-wasm` npm package); this
//! crate re-exports it and adds only the PyO3 glue. The glue lives in
//! [`python`] and is gated behind the `python` cargo feature so that plain
//! `cargo build` / `cargo test` stay PyO3-free.

pub use pipelex_common::tools::{diagnostic, format, lint};

#[cfg(feature = "python")]
mod python;
