//! WASM bindings for Pipelex Tools — the `@pipelex/tools-wasm` npm package.
//!
//! A thin `wasm-bindgen` layer over the shared MTHDS lint/format engine in
//! `pipelex_common::tools` — the same engine behind the `pipelex-tools-py`
//! wheel and (transitively) `pipelex-api`'s `/v1/lint` + `/v1/format`, so all
//! bindings emit the identical `Diagnostic` wire shape by construction.
//!
//! **This crate is deliberately not `pipelex-wasm`.** That crate backs
//! `@pipelex/lsp` and carries the whole LSP + CLI + HTTP machinery; this one
//! sheds all of it for a small artifact a plugin hook can vendor. Everything
//! here is synchronous and fully offline: lint validates against the embedded
//! MTHDS schema only (via [`lint_mthds_offline`], which needs no JS environment
//! object and never yields), and format does no config discovery.
//!
//! Serialization uses `serde-wasm-bindgen`'s JSON-compatible mode so the JS
//! shapes match the Python/HTTP surfaces exactly — plain objects, and absent
//! `location`/`range` serialized as `null`, never `undefined`.

use pipelex_common::tools::diagnostic::Diagnostic;
use pipelex_common::tools::format::format_mthds_impl;
use pipelex_common::tools::lint::lint_mthds_offline;
use serde::Serialize;
use wasm_bindgen::prelude::*;

// ⚠️ PUBLIC BINDING SURFACE — the `lint_mthds` return shape:
// `{ "diagnostics": [Diagnostic] }`. Mirror of `pipelex-py`'s `LintOutput` and
// `@pipelex/sdk`'s `LintResponse`; mirror any change in `js/tools-wasm`'s
// `LintResult` TS type.
#[derive(Serialize)]
struct LintOutput {
    diagnostics: Vec<Diagnostic>,
}

/// Install the panic hook so Rust panics surface as readable JS errors.
/// Call once before anything else (the JS wrapper does).
#[wasm_bindgen]
pub fn initialize() {
    console_error_panic_hook::set_once();
}

/// Serialize with JSON semantics: structs as plain objects, `None` as `null`
/// (the default serializer would emit `undefined`, silently dropping the
/// always-present `location`/`range` fields from the wire shape).
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    value
        .serialize(&serializer)
        .map_err(|err| JsError::new(&err.to_string()))
}

/// Convert one caller option value to the string form the formatter's
/// `update_from_str` expects — the exact analog of the Python binding's
/// `option_value_to_string` (booleans lowercased, numbers stringified).
fn option_pairs(
    options: serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<(String, String)>, String> {
    options
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                serde_json::Value::Bool(boolean) => boolean.to_string(),
                serde_json::Value::Number(number) => number.to_string(),
                serde_json::Value::String(string) => string,
                other => {
                    return Err(format!(
                        "option `{key}` must be a string, number, or boolean, got: {other}"
                    ))
                }
            };
            Ok((key, value))
        })
        .collect()
}

/// Marshal the optional `options` JS object into snake_case `(key, value)`
/// string pairs.
fn options_from_js(options: JsValue) -> Result<Vec<(String, String)>, JsError> {
    if options.is_undefined() || options.is_null() {
        return Ok(Vec::new());
    }
    let entries: serde_json::Map<String, serde_json::Value> =
        serde_wasm_bindgen::from_value(options)
            .map_err(|err| JsError::new(&format!("invalid options object: {err}")))?;
    option_pairs(entries).map_err(|err| JsError::new(&err))
}

// ⚠️ PUBLIC BINDING SURFACE — keep the signature and return shape in sync with
// `js/tools-wasm`'s TS wrapper (`formatMthds` / `FormatResult`).
/// `format_mthds(content, options?) -> { formatted, changed, diagnostics }`
///
/// Formats with the canonical MTHDS defaults baked in; `options` is an
/// optional JS object of snake_case formatter overrides (string, number, or
/// boolean values — the same keys as the CLI's `-o key=value`). On a syntax
/// error the input is returned unchanged with the blocking diagnostics — it
/// never throws for malformed MTHDS. It *does* throw for a malformed
/// `options` value (e.g. a non-numeric `column_width`).
#[wasm_bindgen]
pub fn format_mthds(content: &str, options: JsValue) -> Result<JsValue, JsError> {
    let options = options_from_js(options)?;
    let outcome =
        format_mthds_impl(content, &options).map_err(|err| JsError::new(&format!("{err:#}")))?;
    to_js(&outcome)
}

// ⚠️ PUBLIC BINDING SURFACE — keep the signature and return shape in sync with
// `js/tools-wasm`'s TS wrapper (`lintMthds` / `LintResult`).
/// `lint_mthds(content) -> { diagnostics }` (empty == clean)
///
/// Validates in stages — syntax → semantic → schema — short-circuiting at the
/// first failing stage, fully offline against the embedded MTHDS schema. It
/// never throws on bad content; diagnostics are data.
#[wasm_bindgen]
pub fn lint_mthds(content: &str) -> Result<JsValue, JsError> {
    let diagnostics =
        lint_mthds_offline(content).map_err(|err| JsError::new(&format!("{err:#}")))?;
    to_js(&LintOutput { diagnostics })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        value
            .as_object()
            .expect("test options must be an object")
            .clone()
    }

    #[test]
    fn option_values_stringify_like_the_python_binding() {
        // Booleans lowercase (JS `true`), numbers via to_string, strings as-is
        // — exactly what `update_from_str` parses.
        let pairs = option_pairs(json(serde_json::json!({
            "align_entries": false,
            "column_width": 100,
            "indent_string": "  ",
        })))
        .expect("primitive option values convert");
        assert!(pairs.contains(&("align_entries".to_owned(), "false".to_owned())));
        assert!(pairs.contains(&("column_width".to_owned(), "100".to_owned())));
        assert!(pairs.contains(&("indent_string".to_owned(), "  ".to_owned())));
    }

    #[test]
    fn non_primitive_option_value_is_rejected() {
        let result = option_pairs(json(serde_json::json!({ "column_width": [80] })));
        let err = result.expect_err("arrays are not valid option values");
        assert!(
            err.contains("column_width"),
            "error names the bad key: {err}"
        );
    }

    #[test]
    fn converted_options_drive_the_shared_engine() {
        // End-to-end through the same call chain `format_mthds` uses, minus the
        // JsValue marshalling (exercised by the JS package's vitest suite).
        let pairs = option_pairs(json(serde_json::json!({ "align_entries": false })))
            .expect("options convert");
        let outcome = format_mthds_impl("a = 1\nbb = 2\n", &pairs).expect("format succeeds");
        assert_eq!(outcome.formatted, "a = 1\nbb = 2\n");
    }
}
