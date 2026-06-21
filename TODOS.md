# TODO — Python bindings for `pipelex-tools` (lint & format as a library)

Status: **planned, grounded against the code, not started.** This is the detailed implementation plan. It supersedes and refines the cold-start design in [`wip/pipelex-tools-python-bindings.md`](wip/pipelex-tools-python-bindings.md) — read that for the "why"; read this for the "how". Every API call, file path, and CI edit below was verified against the current tree.

Goal: add a Python-importable surface (PyO3) to the `pipelex-tools` wheel so a Python host (the `pipelex-api` FastAPI server) can call `plxt`'s **lint** and **format** in-process instead of shelling out to the `plxt` binary. The wheel must keep shipping the `plxt` console command unchanged — the binding is purely additive.

This lands in **this repo** only. The downstream half (two `/v1/*` routes in `pipelex-api`) is a separate PR that starts after a new `pipelex-tools` is published.

---

## Orientation & prerequisites (read first on a cold start)

- **Repo:** `vscode-pipelex` — a fork of [tamasfe/taplo](https://github.com/tamasfe/taplo) (TOML toolkit) extended with MTHDS support. Polyglot: Rust workspace (`crates/*`) + TS VS Code extension (`editors/vscode/`) + JS packages (`js/`). The repo's `CLAUDE.md` is the authority on conventions; this plan assumes its rules.
- **Critical taplo rule, and why this work is safe under it:** upstream taplo crates (`taplo`, `taplo-cli`, `taplo-common`, `taplo-lsp`, `taplo-wasm`, `lsp-async-stub`) must not change behavior; touching shared/upstream code requires notifying the developer first. **This plan does not modify any upstream taplo crate** — it only *calls* their already-public, CLI-agnostic APIs. All edits are to Pipelex-owned surfaces: the new `crates/pipelex-py/`, plus `crates/pipelex-cli/` (ours), `pyproject.toml`, `Makefile`, `.github/workflows/`, `CHANGELOG.md`, `docs/`. No developer notification needed.
- **Build tooling:** standard `cargo` for the Rust side. The Python wheel is built by **maturin** (`pyproject.toml` `build-backend = "maturin"`). `make env` creates the uv venv; `make pipelex-tools` runs `maturin develop --release` inside it. If `maturin` is missing, install it (`uv pip install maturin` or `pipx install maturin`; `requires maturin>=1.4`).
- **Key commands you'll use to verify each phase:**
  - `cargo build --bin plxt` — must stay PyO3-free (no `python` feature).
  - `cargo test -p pipelex-py` — Rust unit + parity tests (impls are testable without Python).
  - `maturin develop --features python` then `python -c "import pipelex_tools; ..."` — exercise the module locally.
  - `maturin build --features python` — produce the wheel (Phase-1 spike gate).
  - `make check` — full gate (fmt + clippy `-D warnings` + tests + wasm check) before any release. Note: clippy requires `#[cfg(test)] mod tests` to be the **last item** in each Rust file (`items_after_test_module` lint).
- **Concrete `.mthds` fixtures already in the tree** (use these as test inputs — no need to invent any):
  - `test-data/mthds/lint/valid.mthds` — clean (lint passes, schema-valid).
  - `test-data/mthds/lint/invalid_schema.mthds` — schema-invalid (drives the `kind:"schema"` path).
  - `test-data/mthds/*.mthds` (e.g. `pipe-definitions.mthds`, `steps.mthds`, `concept-tables.mthds`) — format-parity corpus.

---

## The one decision that changed after reading the code: feature-gate PyO3

The wip doc said "make `pipelex-py` produce both the cdylib module and a `[[bin]] plxt`". That is right, but naively done it **regresses the existing CLI build**: the Makefile and CI invoke the binary through `cargo run --bin plxt` (Makefile:98,102,108; ci.yaml:70,85) and build it via `cargo build -p pipelex-cli` (Makefile:38). If the `plxt` bin lives in a crate that unconditionally depends on PyO3, then every plain `cargo build` / `cargo test` / MSRV job pulls PyO3 into the graph and needs a Python interpreter at build time — a real regression to today's Python-free CLI build.

**Resolution — make `pyo3` + `pythonize` optional, behind a `python` feature, and `#[cfg(feature = "python")]`-gate all binding code.**

- `cargo build --bin plxt`, `cargo run --bin plxt`, `cargo test`, the MSRV jobs → feature off → **no PyO3, no Python needed** (optional deps are not compiled unless their feature is on). Zero regression.
- `maturin build` → passes `features = ["python"]` → compiles the cdylib module **and** the bin into one wheel.

The pure format/lint logic is **not** gated (plain Rust returning `#[derive(Serialize)]` structs), so it compiles and unit-tests without Python. Only the thin `#[pyfunction]` / `#[pymodule]` wrappers are gated.

There must be exactly **one** `plxt` bin in the workspace (two crates with a `[[bin]] plxt` makes `cargo run --bin plxt` ambiguous and collides on `target/*/plxt`). So **move** the bin from `pipelex-cli` to `pipelex-py`; `pipelex-cli` stays a pure library (it already is — `PlxtCli` in `src/lib.rs`, consumed by `pipelex-wasm` and now `pipelex-py`). The moved bin source stays Python-free: it calls a small `pipelex_cli::cli_main()` we extract (additive) so we don't duplicate `bin/plxt.rs`'s `main`.

**The `cli_main()` extraction (additive, preserves behavior).** Move the body of `crates/pipelex-cli/bin/plxt.rs:main` into a new `pub async fn cli_main() -> i32` in `crates/pipelex-cli/src/lib.rs` — same arg parse (`PlxtArgs::parse()`), same `setup_stderr_logging`, same `MthdsEnvironment::new(NativeEnvironment::new())`, returning `0` on `Ok` / `1` on `Err` (instead of calling `exit`). Both bins become the same three lines:
```rust
use std::process::exit;
#[tokio::main]
async fn main() { exit(pipelex_cli::cli_main().await); }
```
`pipelex-cli` keeps its existing native deps (tokio `rt-multi-thread`, `NativeEnvironment`) since `cli_main` still uses them; no dependency change. `crates/pipelex-cli/bin/plxt.rs` is deleted and its `[[bin]]` stanza removed from `crates/pipelex-cli/Cargo.toml`; `crates/pipelex-py/src/bin/plxt.rs` is the new home.

**⚠ Consequence — relocate the bin's integration test.** `crates/pipelex-cli/tests/schema_path.rs` resolves the binary via `env!("CARGO_BIN_EXE_plxt")`, which Cargo sets **only for the crate that defines the `plxt` bin**. After the move that's `pipelex-py`, so this test must move to `crates/pipelex-py/tests/` (it otherwise fails to compile, breaking `cargo test -p pipelex-cli` / `make test`). Update `Makefile:112` (`cargo test -p pipelex-cli`) to test `pipelex-py` too. The new `tests/parity.rs` can use the same `env!("CARGO_BIN_EXE_plxt")` since `pipelex-py` now owns the bin.

---

## Crate layout

New crate `crates/pipelex-py/` (Python import name `pipelex_tools`):

```
crates/pipelex-py/
  Cargo.toml
  src/
    lib.rs            # pub mod diagnostic; pub mod format; pub mod lint; #[cfg(feature="python")] mod python;
    diagnostic.rs     # Diagnostic + Range structs (Serialize) + offset→line/col helper
    format.rs         # format_mthds_impl(content, options) -> FormatOutcome   (pure, sync)
    lint.rs           # lint_mthds_impl(content, source) -> Vec<Diagnostic>    (pure; block_on inside)
    python.rs         # #[cfg(feature="python")] #[pyfunction] wrappers + #[pymodule]
    bin/plxt.rs       # Python-free; calls pipelex_cli::cli_main()
  tests/
    parity.rs         # binding output vs `plxt fmt -` / `plxt lint -`
```

`Cargo.toml` essentials:

```toml
[package]
name = "pipelex-py"
version = "<canonical wheel version — see Release>"
publish = false
rust-version = { workspace = true }
authors = { workspace = true }
edition = { workspace = true }
license = { workspace = true }

[lib]
name = "pipelex_tools"          # the Python module name
crate-type = ["cdylib", "rlib"] # cdylib for maturin, rlib so `cargo test` can link the impls

[[bin]]
name = "plxt"
path = "src/bin/plxt.rs"

[dependencies]
pipelex-cli = { path = "../pipelex-cli" }
pipelex-common = { path = "../pipelex-common" }
taplo = { path = "../taplo" }
taplo-common = { path = "../taplo-common", features = ["rustls-tls", "schema", "reqwest"] }
anyhow = { workspace = true }
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }
tokio = { workspace = true, features = ["rt"] }   # current-thread runtime for block_on
url = { workspace = true }
pyo3 = { version = "0.23", features = ["abi3-py38", "extension-module"], optional = true }
pythonize = { version = "0.23", optional = true }

[features]
python = ["dep:pyo3", "dep:pythonize"]

[lints]
workspace = true
```

(pyo3/pythonize 0.23 — MSRV 1.63, comfortably under the repo's 1.74; pin both to the same minor. The bin target never references PyO3 even when the `python` feature is on, so `extension-module` — which suppresses `-lpython` and only adds `-undefined dynamic_lookup` to the *cdylib* via `rustc-cdylib-link-arg` — does not break the binary link.)

---

## Settled decisions (carried from the wip doc)

1. **Two functions**, `format_mthds` and `lint_mthds`, mirroring the hook order `lint → fmt`. `validate` (semantic dry-run) stays a separate, heavier pipelex-core endpoint — out of scope here.
2. **Format on unparseable input returns `changed: false` + the blocking diagnostic; it does not raise.** This is the `format.rs:44-54` no-`--force` behavior surfaced as data instead of an error.
3. **Lint validates `.mthds` against the embedded official MTHDS schema only** — `pipelex://mthds.schema.json`, fully offline (no network, no filesystem, no config discovery). **Arbitrary / external schemas are explicitly out of scope by design:** no `--schema` equivalent, no schema catalogs, no `.taplo.toml`/`plxt.toml` schema associations, no `x-taplo` directives, no external `$ref` fetching. The binding hardcodes the builtin URL and always passes `http: None` to `Schemas`, so there is no code path that can reach out for another schema. This is what makes lint provably offline and removes nearly all the `Environment`/HTTP plumbing the wasm crate carries.

---

## Binding surface

```
format_mthds(content: str, *, options: dict | None = None) -> dict
    # { "formatted": str, "changed": bool, "diagnostics": [Diagnostic] }
    # Syntax error: formatted == content, changed == False, diagnostics == [blocking syntax error(s)].

lint_mthds(content: str, *, source: str | None = None) -> dict
    # { "diagnostics": [Diagnostic] }
    # [] == clean. `source` is an optional logical filename, used only for locators.
```

`Diagnostic` (enriches the wasm `LintError`, which is only `{ range, error }`):

```
Diagnostic {
    kind: "syntax" | "semantic" | "schema",
    severity: "error",   # room to grow; lint is all-errors today
    message: str,
    location: str | null,        # dotted instance path for schema errors (e.g. "pipe.foo.model"); null otherwise
    range: {
        start_offset, end_offset,            # byte offsets
        start_line, start_col, end_line, end_col   # 1-based, codespan-style
    } | null,                                # semantic/schema errors may have no range
}
```

Built from `#[derive(Serialize)]` structs and handed to Python via `pythonize` (the native analog of the wasm crate's `serde-wasm-bindgen`). Field names kept neutral; the `pipelex-api` repo owns the wire contract and will `model_validate` these.

---

## Implementation notes (exact APIs — all already public and CLI-agnostic)

### `format_mthds_impl` — pure, synchronous, no `Environment`

Mirror `crates/pipelex-wasm/src/lib.rs:37-71` (`format`) and `crates/taplo-cli/src/commands/format.rs:24-81` (`format_stdin`), but with **no config discovery**:

1. `let syntax = taplo::parser::parse(content);`
2. `let error_ranges = syntax.errors.iter().map(|e| e.range).collect::<Vec<_>>();`
3. If `!syntax.errors.is_empty()` → **decision #2**: return `{ formatted: content.to_owned(), changed: false, diagnostics: <syntax diagnostics> }`. Do not format, do not raise.
4. Build options: `let mut options = formatter::Options::default();` then apply the **canonical MTHDS defaults** (below), then apply the caller's `options` dict over the top (`options.update_from_str(..)` for `"key=value"` pairs, matching `format.rs:292-303`).
5. `let formatted = formatter::format_with_path_scopes(syntax.into_dom(), options, &error_ranges, Config::default().format_scopes(Path::new("")))?;` — `Config::default().format_scopes(Path::new(""))` yields the correct (empty) scopes type with no filesystem touch (same call the wasm crate makes at `lib.rs:69`).
6. `changed = formatted != content;` return `{ formatted, changed, diagnostics: [] }`.

**Canonical MTHDS formatting defaults to bake** (from this repo's `plxt.toml` global `[formatting]` plus its `**/*.mthds` rule, so server output matches what the extension writes on save): `align_entries = true`, `align_comments = true`, `align_single_comments = true`, `array_trailing_comma = true`, `array_auto_expand = true`, `array_auto_collapse = false`, `inline_table_expand = true`, `compact_arrays = true`, `compact_inline_tables = false`, `compact_entries = false`, `column_width = 80`, `indent_string = "  "`, `trailing_newline = true`, `reorder_keys = false`, `reorder_arrays = false`, `allowed_blank_lines = 2`, `crlf = false`. The caller's `options` dict overrides any of these (decision: both — baked defaults + caller override).

### `lint_mthds_impl` — staged, offline; one `block_on` for the schema stage

Mirror `crates/taplo-cli/src/commands/lint.rs:114-206` (`lint_source`) staging and `crates/pipelex-wasm/src/lib.rs:73-141` (`lint`), short-circuiting at the **first** failing stage:

1. **Syntax** — `let parse = taplo::parser::parse(content);` if `!parse.errors.is_empty()` → return syntax diagnostics. Each `parse.errors[i]` has `.range` (byte `TextRange`) and `.message`; `kind = "syntax"`.
2. **Semantic** — `let dom = parse.into_dom();` `if let Err(errors) = dom.validate()` → return semantic diagnostics. Range derived per `dom::Error` variant exactly as `crates/taplo-cli/src/printing.rs:241-250` does (`ConflictingKeys` → `key.text_ranges().next()`; `ExpectedArrayOfTables` → `not_array_of_tables.text_ranges().next()`; `ExpectedTable` → `not_table.text_ranges().next()`; `InvalidEscapeSequence` → `string.text_range()`; `UnexpectedSyntax`/`Query` → `None`). Message = `error.to_string()`; `kind = "semantic"`.
3. **Schema** — offline against the builtin:
   ```rust
   let schemas = Schemas::new(NativeEnvironment::new(), None); // http = None
   let url = Url::parse(taplo_common::schema::builtins::MTHDS_SCHEMA_URL)?; // "pipelex://mthds.schema.json"
   let errors = schemas.validate_root(&url, &dom).await?;       // Vec<NodeValidationError>
   ```
   Note this calls `validate_root` with the **hardcoded builtin URL directly** — it deliberately skips the association machinery the CLI/wasm use to *choose* a schema (`associations().add_from_config()` / `add_from_document()` / `association_for(..)`). We never ask "which schema applies to this file?"; the answer is always the embedded MTHDS schema. `validate_root` → `validate` → `load_schema` resolves the builtin at `schema/mod.rs:644` **before any HTTP**, and `validate_impl` (`schema/mod.rs:583-630`) returns on the first loop because there are no external `$ref`s to fetch — so **no env IO and no `spawn`**, which means a **current-thread** tokio runtime `block_on` is sufficient (no need for a multi-thread runtime). Per `NodeValidationError` (these accessors are already `pub` and used cross-crate by `taplo-cli`'s printer at `printing.rs:284-295`): `message = err.display_message()`, range from `err.primary_text_range() -> Option<TextRange>`, `location = err.instance_location()` (the dotted path). `kind = "schema"`.

Wrap the whole thing so the async stage runs under a runtime; on the Python side, release the GIL around it (`Python::allow_threads`) since FastAPI calls these in a threadpool.

### `Diagnostic` line/col helper

Replicate the tiny `offset_to_line_col(source, offset) -> (line, col)` from `crates/taplo-cli/src/printing.rs:163-179` inside `pipelex-py/src/diagnostic.rs` (it's a private fn there). Replicating — rather than lifting it to a shared `pub` location — keeps the change additive and touches no upstream code; the two implementations are identical so coordinates match the CLI. Compute `start_line/start_col` from `range.start()` and `end_line/end_col` from `range.end()`.

### `Environment` for `Schemas`

Use `taplo_common::environment::native::NativeEnvironment` (the same env `bin/plxt.rs:30` uses; available on native, not behind a cargo feature). Because validation hits only the embedded builtin, none of its IO methods are ever called — no need for the no-op `Environment` the wip doc floated.

---

## Packaging mechanics (`pyproject.toml`)

```toml
[tool.maturin]
bindings      = "pyo3"
manifest-path = "crates/pipelex-py/Cargo.toml"
features      = ["python"]    # turn on PyO3 only for the wheel build
include       = ["LICENSE"]
```

- `bindings = "bin"` → `"pyo3"`; `manifest-path` moves from `pipelex-cli` to `pipelex-py`.
- `requires-python = ">=3.8,<3.15"` already matches `abi3-py38` — one wheel per `os × arch`, no Python-version axis needed (so `releases.yaml`'s matrix at 115-153 stays as-is).
- ⚠️ **Phase-1 spike gate:** confirm a single `maturin build` yields one wheel that contains both `import pipelex_tools` (the extension module) **and** a working `plxt` script. maturin bundles a crate's `[[bin]]` targets into the wheel as scripts; the spike proves it for this combo (and, in CI, across Windows where abi3 linking differs). If single-wheel proves infeasible, stop and re-decide before writing real logic.

---

## Release & downstream wiring

- **Version source of truth moves with `manifest-path`.** maturin reads the wheel version (`pyproject.toml` `dynamic = ["version"]`) from the manifest-path crate, which becomes `pipelex-py`. So:
  - Set `crates/pipelex-py/Cargo.toml` `version` to the next `pipelex-tools` release (bump from the current `pipelex-cli` `0.7.0`, e.g. `0.8.0`).
  - Update `ci.yaml` auto_tag (`ci.yaml:34`) `CLI_VERSION=$(sed ... crates/pipelex-cli/Cargo.toml)` → read `crates/pipelex-py/Cargo.toml` instead (the tag `plxt-cli/v*` should track the published wheel's version). Keep `pipelex-cli`'s version in lockstep to avoid confusion, or document that `pipelex-py` is now canonical.
- **Makefile:** `cli:` target (Makefile:38) `cargo build -p pipelex-cli --release` → `cargo build -p pipelex-py --bin plxt --release` (still emits `target/release/plxt`). The `cargo run --bin plxt` lines (98,102,108) keep working (one bin, unambiguous). `test:` target (Makefile:112) `cargo test -p pipelex-cli` → add `-p pipelex-py` (where the relocated `schema_path.rs` now lives). `make pipelex-tools` (Makefile:53, `maturin develop`) now needs `--features python` if maturin doesn't read `[tool.maturin] features` for `develop` — verify; otherwise add it.
- **Docs (per the repo doc rule):** add a doc for the new library surface under `docs/` (suggest `docs/dev/pipelex-tools-python-bindings.md`) — the two functions, the `Diagnostic` shape, the embedded-schema-only guarantee, and the `import pipelex_tools` usage. Update it in the same change that adds the code.
- **CI smoke test:** extend `pypi_test_plxt` (`releases.yaml:176`) — after `plxt help`, add `python -c "import pipelex_tools; assert pipelex_tools.format_mthds('a=1')['formatted']; assert 'diagnostics' in pipelex_tools.lint_mthds('a=1')"` so the module surface is guarded like the binary.
- **CHANGELOG.md:** add an entry under the current release section (no empty `## [Unreleased]` left behind). Tag `plxt-cli/vX.Y.0` once green.
- **Downstream (separate repo/PR):** in `pipelex-api`, bump the pin to `pipelex-tools>=X.Y.0` and add `/v1/lint` + `/v1/format` (modeled on `api/routes/pipelex/validate.py` — diagnostic 200-with-discriminator, opt-in `rendered_markdown`, RFC 7807 only for no-verdict). Not part of this repo's work.

---

## Phase-by-phase plan

### Phase 1 — packaging spike (de-risk the wrinkle)
Stand up `crates/pipelex-py` with one trivial gated `#[pyfunction]` returning a constant and the moved `[[bin]] plxt`. Wire `pyproject.toml` (`bindings = "pyo3"`, `manifest-path`, `features = ["python"]`). Extract `pipelex_cli::cli_main()`, delete `pipelex-cli`'s `bin/plxt.rs` and its `[[bin]]` stanza, and point the new `pipelex-py` bin at `cli_main()`. Relocate `crates/pipelex-cli/tests/schema_path.rs` → `crates/pipelex-py/tests/` (the `CARGO_BIN_EXE_plxt` gotcha above). Update Makefile `cli:` target, the `cargo test -p pipelex-cli` list (Makefile:112), and ci.yaml auto_tag version path. Confirm: `cargo build --bin plxt` builds with **no** PyO3 in the graph; `cargo test -p pipelex-py` and `cargo test -p pipelex-cli` both green; `maturin build --features python` produces one wheel where both `import pipelex_tools` and `plxt help` work.

> **Checkpoint 1:** single wheel carries module + binary; plain `cargo build`/`test` and the MSRV jobs remain Python-free; `os × arch` matrix unchanged. If single-wheel is infeasible, stop and re-decide packaging.

### Phase 2 — implement `format_mthds`
Pure, sync. `diagnostic.rs` (structs + `offset_to_line_col`) and `format.rs` (`format_mthds_impl`) with the decision-#2 syntax behavior and baked canonical defaults + caller overrides. Gated `#[pyfunction] format_mthds` in `python.rs`. Rust unit tests for known-good (feed `test-data/mthds/pipe-definitions.mthds` etc.; assert formatting an already-formatted file gives `changed:false`) and known-bad (a string with a syntax error → `changed:false` + a `kind:"syntax"` diagnostic, content returned unchanged) inputs.

### Phase 3 — implement `lint_mthds`
`lint.rs` (`lint_mthds_impl`): parse → `dom.validate()` → `Schemas::validate_root` against the embedded `pipelex://mthds.schema.json`, the schema stage run under a current-thread runtime `block_on`. Emit `kind`-tagged diagnostics, short-circuiting per stage. Gated `#[pyfunction] lint_mthds` with `Python::allow_threads` around the runtime. Rust unit tests covering clean (`test-data/mthds/lint/valid.mthds` → `[]`), schema-error (`test-data/mthds/lint/invalid_schema.mthds` → a `kind:"schema"` diagnostic), plus inline syntax-error and semantic-error strings.

> **Checkpoint 2:** both functions implemented; `cargo test -p pipelex-py` green (impls tested without Python); a local Python smoke test (`maturin develop --features python`, then format + lint a known-good and known-bad `.mthds`) passes.

### Phase 4 — parity + CI + release
`tests/parity.rs`: assert binding output matches `plxt lint -` / `plxt fmt -` (compact) on a corpus reusing `test-data/` and the patterns in `crates/pipelex-cli/tests/schema_path.rs`. Extend `pypi_test_plxt` with the import smoke test. Update `docs/` for the new surface (per the repo doc rule). Bump `pipelex-py` version, add the CHANGELOG entry, then `make check` clean. Tag `plxt-cli/vX.Y.0` and let `releases.yaml` build/test/publish.

> **Checkpoint 3:** new `pipelex-tools` published with the module surface. Hand off to `pipelex-api` (separate session/repo): bump pin, add `/v1/lint` + `/v1/format`.

---

## Open decisions to settle while building

- **Runtime reuse.** Building a current-thread runtime per `lint_mthds` call is simple and correct (validation is fast and fully in-memory). If profiling later shows it matters, cache a runtime in a `thread_local!` or `OnceLock`. Start simple.
- **`pipelex-cli` version after the move.** Keep it bumped in lockstep with `pipelex-py`, or freeze it and make `pipelex-py` the sole version of record. Recommend lockstep for least surprise; document whichever.
- **`maturin develop` feature passing.** Confirm `[tool.maturin] features` is honored by `develop`; if not, `make pipelex-tools` must pass `--features python` explicitly.
- **Final `Diagnostic` field names** — coordinate with the `pipelex-api` wire models so the route can `model_validate` with minimal remapping; the API repo owns the contract.
- **`end_line`/`end_col` for rangeless errors** — semantic/schema errors with no `TextRange` emit `range: null`; confirm the downstream renderer tolerates null (it should, mirroring the wasm `Option<Range>`).

---

## Acceptance criteria (definition of done for this repo's half)

- `pip install pipelex-tools` (the new wheel) gives both a working `plxt` command **and** `import pipelex_tools` exposing `format_mthds` and `lint_mthds`.
- `lint_mthds` validates `.mthds` against the embedded schema only, fully offline; no code path fetches an external schema.
- `format_mthds` returns `{formatted, changed, diagnostics}`, never raising on syntax errors (decision #2), with output matching `plxt fmt -` on the corpus.
- `cargo build --bin plxt` and `cargo test` (and the MSRV jobs) remain PyO3-free; `make check` is green.
- Parity tests pass (binding vs `plxt fmt -` / `plxt lint -`); the CI wheel smoke test imports the module.
- Version bumped, CHANGELOG updated, `docs/` updated, tag `plxt-cli/vX.Y.0` pushed → `releases.yaml` publishes.

---

## Cold-start file map

| Purpose | Path |
| --- | --- |
| Binding template (read first) | `crates/pipelex-wasm/src/lib.rs` (`format` 37-71, `lint` 73-141) |
| Format core to mirror | `crates/taplo-cli/src/commands/format.rs` (`format_stdin` 24-81; syntax-error path 44-54; options 283-306) |
| Lint core to mirror | `crates/taplo-cli/src/commands/lint.rs` (`lint_source` 114-206) |
| Diagnostic range/coords reference | `crates/taplo-cli/src/printing.rs` (`offset_to_line_col` 163-179; semantic ranges 241-254; schema accessors 284-295) |
| Pure formatter entry | `taplo::formatter::format_with_path_scopes` (called at wasm `lib.rs:65`) |
| Parser entry | `taplo::parser::parse` |
| Embedded official schema | `crates/taplo-common/src/schema/mod.rs` (builtins 30-61; `MTHDS_SCHEMA_URL` 37; offline resolve 644); file `crates/taplo-common/schemas/mthds_schema.json` |
| Schema validation API | `Schemas::new` (`schema/mod.rs:74`), `validate_root` (344), `validate`/`validate_impl` (552/573), `NodeValidationError` (1162) |
| CLI entrypoint to refactor into `cli_main()` | `crates/pipelex-cli/bin/plxt.rs`, `crates/pipelex-cli/src/lib.rs` |
| Native environment | `taplo_common::environment::native::NativeEnvironment` |
| Canonical format defaults source | `plxt.toml` (global `[formatting]` + `**/*.mthds` rule) |
| Current maturin config (to change) | `pyproject.toml:49-56` |
| Bin target to move | `crates/pipelex-cli/Cargo.toml:65-67` → `crates/pipelex-py/Cargo.toml` |
| CI: version/tag, fmt-run, wheel build/test/publish | `.github/workflows/ci.yaml:34,70,85`; `.github/workflows/releases.yaml:113-195` |
| Makefile targets to update | `Makefile:38` (`cli`), `53` (`pipelex-tools`) |
| Bin integration test to relocate (CARGO_BIN_EXE_plxt) | `crates/pipelex-cli/tests/schema_path.rs` → `crates/pipelex-py/tests/` |
| `.mthds` test fixtures | clean: `test-data/mthds/lint/valid.mthds`; schema-invalid: `test-data/mthds/lint/invalid_schema.mthds`; format corpus: `test-data/mthds/*.mthds` |
| Docs to add | `docs/dev/pipelex-tools-python-bindings.md` (new) |
| New crate to create | `crates/pipelex-py/` |
