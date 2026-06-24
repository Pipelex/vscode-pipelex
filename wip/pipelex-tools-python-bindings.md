# Python bindings for `pipelex-tools` — lint & format as a library

Status: **design / not started**. This is a cold-start plan for adding a Python-importable surface (PyO3) to the `pipelex-tools` wheel so a Python host (specifically the `pipelex-api` FastAPI server) can call `plxt`'s **lint** and **format** in-process, instead of shelling out to the `plxt` binary.

This work lands in **this repo** (`vscode-pipelex`). It is the upstream half of a two-repo change; the downstream half (two new HTTP endpoints) lands in `pipelex-api` and only starts once a new `pipelex-tools` version is published.

## Why

`pipelex-api` already declares `pipelex-tools>=0.6.0` as a direct dependency (added on purpose, for this). But today the wheel ships **only the compiled `plxt` binary** — `pyproject.toml` builds with maturin `bindings = "bin"` (`pyproject.toml:53-56`), target binary `[[bin]] plxt` (`crates/pipelex-cli/Cargo.toml:65-67`). There is no importable Python surface, so the only way to reach lint/format from Python right now is `subprocess` → `plxt`.

We want a real library call instead, because:

- **No JSON output mode exists for lint today.** The CLI only emits human-readable diagnostics (codespan boxes) or a compact `file:line:col: error[...]: msg` text line. A subprocess approach would mean regex-parsing that back into structure. A binding returns the structured `Diagnostic` directly — no parsing, no drift.
- **No fork/exec per request** from a FastAPI worker.
- **Single source of truth.** The Rust core already *builds* diagnostics before printing them; the binding returns that same data, and the existing CLI text rendering stays as one presentation on top.

## What already makes this cheap

This is **not** a deep refactor of `pipelex-cli`. The core is already CLI-agnostic library code, and there is already a **non-CLI binding crate that proves the pattern**: `crates/pipelex-wasm/` exposes `format()` and `lint()` to JS via `wasm-bindgen` + `serde-wasm-bindgen`. The PyO3 crate is the direct analog (pyo3 + pythonize). Read `crates/pipelex-wasm/src/lib.rs` first — it is the template.

Core functions the binding calls directly (all already public, all CLI-agnostic):

- `taplo::parser::parse(source: &str) -> Parse` — `.errors` is the syntax-error list (each carries a byte `.range` and `Display`); `.into_dom()` yields the DOM. (`crates/taplo/`)
- `dom.validate() -> Result<(), impl Iterator<Item = …>>` — semantic errors (no range in the current wasm mapping).
- `taplo::formatter::format_with_path_scopes(dom, options, &error_ranges, scopes) -> Result<String, _>` — the pure formatter. No `Environment`, no IO.
- `taplo_common::schema::Schemas` + `associations()` + `.validate(&url, &json).await` / `.validate_root(&url, &dom).await` — schema validation.

Reference implementations to mirror:

- Format core: `crates/taplo-cli/src/commands/format.rs` → `format_stdin` (`format.rs:24-81`). Note the failure path at `format.rs:44-54`: on parse errors, without `--force`, it does **not** format and returns an error. This is exactly decision #2 below.
- Lint core: `crates/taplo-cli/src/commands/lint.rs` → `lint_source` (`lint.rs:114-206`): parse → `dom.validate()` → schema validation, in that order, short-circuiting at the first failing stage.
- WASM binding: `crates/pipelex-wasm/src/lib.rs` → `format` (`lib.rs:37-71`, sync) and `lint` (`lib.rs:73-141`, async), with `LintError { range, error }` / `LintResult { errors }` (`lib.rs:14-30`).

## The official schema is embedded — lint is fully offline

Decision #3 is "use the official schema", and the official MTHDS JSON schema is **compile-time embedded** in `taplo-common`:

- `crates/taplo-common/src/schema/mod.rs:39` — `const MTHDS_SCHEMA_JSON: &str = include_str!("../../schemas/mthds_schema.json");`
- `mod.rs:37` — builtin URL `pipelex://mthds.schema.json`
- `mod.rs:47` — `builtins::mthds_schema() -> Arc<Value>`; `mod.rs:54` — `builtin_schema(url)`; offline resolve at `mod.rs:644` (checked **before** any HTTP).
- Schema file on disk: `crates/taplo-common/schemas/mthds_schema.json`.

**Consequence:** linting against the official schema needs **no network and no filesystem**. The binding can validate with a trivial/no-op `Environment` (or none, depending on how far we lift the schema call). This removes most of the `Environment` plumbing the wasm crate carries for browser IO. The CLI's `--schema-path` flag (resolved in `crates/pipelex-cli/src/commands/mod.rs:86-101`) is **not** the mechanism we use here — we bind to the embedded builtin directly.

## Locked design decisions

These came out of the design discussion in `pipelex-api` and are settled:

1. **Two separate endpoints downstream, mirroring the existing hook pipeline order** `plxt lint → plxt fmt → validate`. Lint is the cheap syntax+schema gate; format is a transformation; `validate` (semantic, dry-run) stays a distinct, heavier pipelex-core endpoint. The binding therefore exposes **two** functions, `lint_mthds` and `format_mthds`. (These are Pipelex-API-layer features, **not** MTHDS Protocol — never tagged `x-mthds-protocol: true` downstream. That classification lives in the API repo; noted here only so the binding's result shapes aren't designed as if they were a portable protocol contract.)
2. **Format on unparseable input returns `changed: false` + the blocking diagnostic** — it does not raise, and it does not duplicate full lint detail. Callers wanting detail hit lint. (This is the `format.rs:44-54` behavior, surfaced as data instead of an error.)
3. **Lint validates against the official embedded MTHDS schema** (`pipelex://mthds.schema.json`), offline.

## Proposed binding surface

New crate `crates/pipelex-py/` (Python import name `pipelex_tools`), `crate-type = ["cdylib"]`, mirroring `pipelex-wasm`'s layout. Expose **synchronous** pyfunctions returning plain dicts (built from `#[derive(Serialize)]` structs via `pythonize`, exactly as the wasm crate uses `serde-wasm-bindgen`). Synchronous is right because the Python host (FastAPI) will call these inside `run_in_threadpool`; lint's only async is the schema `validate`, which we wrap in a current-thread `tokio` runtime `block_on`. Format is already fully synchronous.

```
format_mthds(content: str, *, options: dict | None = None) -> dict
    # { "formatted": str, "changed": bool, "diagnostics": [Diagnostic] }
    # On syntax error: formatted == content, changed == False, diagnostics == [the blocking syntax error].  (decision #2)

lint_mthds(content: str, *, source: str | None = None) -> dict
    # { "diagnostics": [Diagnostic] }
    # diagnostics == [] means clean. source is an optional logical filename used only for diagnostic locators.
```

`Diagnostic` — enrich the wasm `LintError` shape (which is only `{ range:{start,end}, error }`) with a `kind` discriminator and resolved line/col, so the downstream API can render `file:line:col` and group by stage:

```
Diagnostic {
    kind: "syntax" | "semantic" | "schema",
    severity: "error",                      # room to grow; lint today is all errors
    message: str,
    range: { start_offset, end_offset, start_line, start_col, end_line, end_col } | null,
    # offsets are byte offsets from parse errors; line/col resolved via codespan (semantic errors may have null range)
}
```

Line/col resolution: the compact CLI printer already converts byte offset → line/col (see `print_parse_errors_compact` and friends in `taplo-cli`). Extract or replicate that small helper so the binding and the CLI compute coordinates identically.

**Out of scope for v1** (revisit later): `to_json` / `from_json` (the wasm crate has them), `--diff` output as a structured field, multi-file batch in a single call (the API loops per file, matching `mthds_contents: list[str]`).

## Packaging — keep the `plxt` binary, add the module (the one real wrinkle)

The wheel must keep shipping the `plxt` console command (the VS Code extension, the hook pipeline, and existing users all depend on it). So the binding is **additive**: same wheel, now also contains an importable extension module.

Plan:

- Switch maturin to `bindings = "pyo3"` with `manifest-path = crates/pipelex-py/Cargo.toml`.
- Make `pipelex-py` produce **both** the pyo3 `cdylib` module **and** declare `[[bin]] name = "plxt"` (depending on `pipelex-cli` and calling its entrypoint), so maturin includes the binary as a script alongside the module.
- Use **`pyo3/abi3-py38`**. The wheel CI matrix today is `os × arch` with **no Python-version axis** (`releases.yaml` `pypi_build_plxt`, `releases.yaml:115-153`) because bin wheels are Python-agnostic. A non-abi3 pyo3 build would force a per-Python matrix; `abi3-py38` keeps one wheel per `os × arch` and covers both the wheel's declared `requires-python = ">=3.8"` (`pyproject.toml:11`) and the API's `>=3.11`.

⚠️ **Spike this first.** Confirm a single maturin invocation yields a wheel containing *both* `pipelex_tools` (importable) *and* the `plxt` script. If "pyo3 module + bin in one wheel" proves painful, fall back to building the module wheel via maturin and shipping the bin through a second path — but single-wheel is the goal and is the normal maturin capability.

## Release & downstream wiring

- Bump `crates/pipelex-cli/Cargo.toml` version (currently `0.7.0`, `Cargo.toml:4`) and the new `pipelex-py` crate; add a CHANGELOG entry.
- Tag `plxt-cli/vX.Y.0`. `releases.yaml` builds wheels (`pypi_build_plxt`), smoke-tests them (`pypi_test_plxt`, currently just `plxt help`, `releases.yaml:176`), and publishes to PyPI (`pypi_publish_plxt`).
- **Extend the smoke test** in `pypi_test_plxt` to also `python -c "import pipelex_tools; pipelex_tools.format_mthds('a=1')"` so the module surface is guarded the way `plxt help` guards the binary.
- After publish, in `pipelex-api`: bump the pin to `pipelex-tools>=X.Y.0` and add the `/v1/lint` + `/v1/format` routes (modeled on `api/routes/pipelex/validate.py` — diagnostic 200-with-discriminator, opt-in `rendered_markdown`, RFC 7807 only for no-verdict). That is a separate doc/PR in that repo.

## Open decisions to settle before/while building

- **Server-side formatting config.** Format is config-dependent: the CLI reads `plxt.toml` (the repo root one at `vscode-pipelex/plxt.toml` sets `align_entries`, `column_width = 80`, etc.). A server has no project config and should not walk the filesystem for one. Decide the canonical formatting options for the binding: bake the project's MTHDS defaults into `format_mthds`, accept an `options` dict from the caller, or both (dict overrides baked defaults). Recommendation: both, defaulting to the canonical MTHDS formatting so API output matches what the extension produces on save.
- **abi3 floor:** `abi3-py38` (matches `requires-python`) vs `abi3-py311` (matches the API). Recommend `py38` — widest, trivial.
- **Final `Diagnostic` field names** — coordinate with the `pipelex-api` wire models so the route can `model_validate` with minimal remapping, but the API repo owns the wire contract; keep these neutral.
- **No-op `Environment` vs. lifting the schema call.** Decide whether to validate via a minimal `Environment` impl (cheapest: copy the relevant bits of `pipelex-wasm/src/environment.rs`) or to call `Schemas` against the embedded builtin without a full environment. Either works since the official schema is offline; pick the smaller surface.

## Step-by-step plan

**Phase 1 — packaging spike (de-risk the wrinkle).** Stand up an empty `crates/pipelex-py` with one trivial `#[pyfunction]` returning a constant, wire maturin (`bindings = "pyo3"`, abi3-py38, `[[bin]] plxt`), and confirm `maturin build` produces one wheel with both `import pipelex_tools` working and `plxt help` working. Do not write real logic until this is green.

> **Checkpoint 1:** wheel proven to carry module + binary together; CI matrix unchanged (os × arch). If single-wheel is infeasible, stop and re-decide packaging before proceeding.

**Phase 2 — implement `format_mthds`.** Pure path, no async. Mirror `pipelex-wasm` `format` + `format.rs` `format_stdin`, returning `{ formatted, changed, diagnostics }` with the decision-#2 syntax-error behavior. Add the byte-offset → line/col helper (shared with the compact printer).

**Phase 3 — implement `lint_mthds`.** parse → `dom.validate()` → schema validate against the embedded `pipelex://mthds.schema.json`, wrapped in a `block_on`. Mirror `lint.rs` `lint_source` staging and `pipelex-wasm` `lint`. Emit `kind`-tagged diagnostics.

> **Checkpoint 2:** both functions implemented; Rust unit tests pass; a Python smoke test (`import pipelex_tools`, format + lint a known-good and known-bad sample) passes locally.

**Phase 4 — parity + CI.** Add a parity test asserting binding output matches `plxt lint -` / `plxt fmt -` on a corpus (reuse `test-data/` and the patterns in `crates/pipelex-cli/tests/schema_path.rs`). Extend `pypi_test_plxt` with the module import smoke test. Bump versions + CHANGELOG, tag `plxt-cli/vX.Y.0`, publish.

> **Checkpoint 3:** new `pipelex-tools` published with the module surface. Hand off to `pipelex-api`: bump pin, add `/v1/lint` and `/v1/format`. (Separate session/repo.)

## Cold-start file map

| Purpose | Path |
| --- | --- |
| Binding template (read first) | `crates/pipelex-wasm/src/lib.rs`, `crates/pipelex-wasm/src/environment.rs` |
| Format core to mirror | `crates/taplo-cli/src/commands/format.rs` (`format_stdin`) |
| Lint core to mirror | `crates/taplo-cli/src/commands/lint.rs` (`lint_source`) |
| Pure formatter entry | `taplo::formatter::format_with_path_scopes` (in `crates/taplo/`) |
| Parser entry | `taplo::parser::parse` |
| Embedded official schema | `crates/taplo-common/src/schema/mod.rs:37-57`, file `crates/taplo-common/schemas/mthds_schema.json` |
| Schema validation API | `taplo_common::schema::Schemas` (`crates/taplo-common/src/schema/mod.rs`) |
| CLI command dispatch (plxt wrapper) | `crates/pipelex-cli/src/commands/mod.rs:41-105` |
| Current maturin config (to change) | `pyproject.toml:49-56` |
| Existing `plxt` bin target | `crates/pipelex-cli/Cargo.toml:65-67` |
| Wheel build/test/publish CI | `.github/workflows/releases.yaml:113-195` |
| Schema-path test patterns to reuse | `crates/pipelex-cli/tests/schema_path.rs` |
| New crate to create | `crates/pipelex-py/` |
