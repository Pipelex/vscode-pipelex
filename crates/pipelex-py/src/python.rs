//! PyO3 glue for the `pipelex_tools` extension module.
//!
//! Gated behind the `python` cargo feature. The real `format_mthds` /
//! `lint_mthds` bindings land in later phases; for now this is the Phase-1
//! packaging spike — a single trivial function proving the wheel exposes an
//! importable module.

use pyo3::prelude::*;

/// Trivial smoke function — returns the module name. Replaced by the real
/// `format_mthds` / `lint_mthds` bindings in Phase 2/3.
#[pyfunction]
fn ping() -> &'static str {
    "pipelex_tools"
}

/// The `pipelex_tools` Python module. The function name must match the `[lib]`
/// `name` so PyO3 emits the matching `PyInit_pipelex_tools` symbol.
#[pymodule]
fn pipelex_tools(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(ping, m)?)?;
    Ok(())
}
