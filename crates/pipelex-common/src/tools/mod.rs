//! The shared MTHDS lint/format engine — one implementation, several bindings.
//!
//! This module (behind the `tools` cargo feature) is the single home of the
//! offline `format_mthds` / `lint_mthds` implementations. The published
//! bindings are all thin wrappers over it:
//!
//! - `pipelex-py` → the `pipelex-tools-py` wheel (`import pipelex_tools`)
//! - `pipelex-tools-wasm` → the `@pipelex/tools-wasm` npm package
//!
//! Keeping the implementation here makes the bindings' wire shapes agree **by
//! construction**: the [`Diagnostic`](diagnostic::Diagnostic) structs are
//! serialized as-is by every binding (`pythonize` on the Python side,
//! `serde-wasm-bindgen` on the wasm side), and the same shape is what
//! `pipelex-api` serves over HTTP and `@pipelex/sdk` types on the client.
//!
//! Everything in here is fully offline: lint validates against the embedded
//! MTHDS schema only, and format does no config discovery.

pub mod diagnostic;
pub mod environment;
pub mod format;
pub mod lint;
