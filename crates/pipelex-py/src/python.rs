//! PyO3 glue for the `pipelex_tools` extension module.
//!
//! Gated behind the `python` cargo feature. These are thin wrappers: they
//! marshal Python arguments, release the GIL around the pure Rust impls (FastAPI
//! calls these from a threadpool), and hand the `#[derive(Serialize)]` results
//! back via `pythonize`. All the real work lives in [`crate::format`] /
//! [`crate::lint`] and is unit-tested without a Python interpreter.

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict};
use serde::Serialize;

use crate::diagnostic::Diagnostic;
use crate::format::format_mthds_impl;
use crate::lint::lint_mthds_impl;

/// The `lint_mthds` return shape: `{ "diagnostics": [Diagnostic] }`.
#[derive(Serialize)]
struct LintOutput {
    diagnostics: Vec<Diagnostic>,
}

/// Convert a single Python option value to the string form the formatter's
/// `update_from_str` expects. Python `bool` stringifies to `"True"`/`"False"`
/// which the Rust parser rejects, so it is mapped to lowercase; everything else
/// (`int`, `str`, `float`) round-trips through `str()`.
fn option_value_to_string(value: &Bound<'_, PyAny>) -> PyResult<String> {
    if let Ok(boolean) = value.downcast::<PyBool>() {
        return Ok(if boolean.is_true() {
            "true".to_owned()
        } else {
            "false".to_owned()
        });
    }
    value.str()?.extract()
}

/// Marshal the optional `options` dict into snake_case `(key, value)` string
/// pairs.
fn options_from_dict(options: Option<&Bound<'_, PyDict>>) -> PyResult<Vec<(String, String)>> {
    let dict = match options {
        Some(dict) => dict,
        None => return Ok(Vec::new()),
    };

    let mut pairs = Vec::with_capacity(dict.len());
    for (key, value) in dict.iter() {
        let key: String = key.extract()?;
        pairs.push((key, option_value_to_string(&value)?));
    }
    Ok(pairs)
}

/// Convert a `Serialize` value into a Python object via `pythonize`.
fn to_py<T: Serialize>(py: Python<'_>, value: &T) -> PyResult<PyObject> {
    pythonize::pythonize(py, value)
        .map(pyo3::Bound::unbind)
        .map_err(|err| PyValueError::new_err(err.to_string()))
}

/// `format_mthds(content, *, options=None) -> dict`
///
/// Returns `{ "formatted", "changed", "diagnostics" }`. On a syntax error the
/// input is returned unchanged with the blocking diagnostics — it never raises
/// for malformed MTHDS (settled decision #2). It *does* raise `ValueError` for a
/// malformed `options` value (e.g. a non-numeric `column_width`).
#[pyfunction]
#[pyo3(signature = (content, *, options=None))]
fn format_mthds(
    py: Python<'_>,
    content: String,
    options: Option<&Bound<'_, PyDict>>,
) -> PyResult<PyObject> {
    let options = options_from_dict(options)?;
    let outcome = py
        .allow_threads(|| format_mthds_impl(&content, &options))
        .map_err(|err| PyValueError::new_err(format!("{err:#}")))?;
    to_py(py, &outcome)
}

/// `lint_mthds(content, *, source=None) -> dict`
///
/// Returns `{ "diagnostics": [Diagnostic] }` (empty == clean). Validation is
/// fully offline against the embedded MTHDS schema. `source` is an optional
/// logical filename reserved for locator use; today's diagnostics carry no
/// filename, so it is accepted for API symmetry but not yet threaded through.
#[pyfunction]
#[pyo3(signature = (content, *, source=None))]
fn lint_mthds(py: Python<'_>, content: String, source: Option<String>) -> PyResult<PyObject> {
    let _ = source;
    let diagnostics = py
        .allow_threads(|| lint_mthds_impl(&content))
        .map_err(|err| PyValueError::new_err(format!("{err:#}")))?;
    to_py(py, &LintOutput { diagnostics })
}

/// The `pipelex_tools` Python module. The function name must match the `[lib]`
/// `name` so PyO3 emits the matching `PyInit_pipelex_tools` symbol.
#[pymodule]
fn pipelex_tools(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(format_mthds, m)?)?;
    m.add_function(wrap_pyfunction!(lint_mthds, m)?)?;
    Ok(())
}
