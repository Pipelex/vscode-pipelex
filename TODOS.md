# TODO — Python bindings for Pipelex Tools (lint & format as a library)

Status: **Phase 1 complete (packaging proven), Phases 2–4 not started.** This is the detailed implementation plan. It supersedes and refines the cold-start design in [`wip/pipelex-tools-python-bindings.md`](wip/pipelex-tools-python-bindings.md) — read that for the "why"; read this for the "how".

Goal: add a Python-importable surface (PyO3) — `format_mthds` / `lint_mthds` — so a Python host (the `pipelex-api` FastAPI server) can call lint and format **in-process** instead of shelling out to the `plxt` binary.

> **⚠ Architecture changed at the Phase-1 gate — read this before anything else.** The original plan assumed a **single wheel** carrying both the importable module and the `plxt` binary, built by moving the `[[bin]] plxt` into a combined `pipelex-py` crate. **That is impossible with maturin:** maturin builds *either* a pyo3 cdylib *or* a `bin`, never both in one wheel (bin bindings are auto-detected *only when there is no pyo3/cdylib target*; there is no flag to combine them and no supported way to inject a native binary into a pyo3 wheel — confirmed in the maturin docs and empirically: a `bindings = "pyo3"` wheel contained the `.so` but no `plxt`). The decision (made with the user) is therefore **two packages built from this one repo** — see ["The architecture: two packages"](#the-architecture-two-packages) below. The CLI stays a true native binary; the library is a separate importable wheel. This is the "best of both worlds" the user asked for.

This lands in **this repo** only. The downstream half (two `/v1/*` routes in `pipelex-api`) is a separate PR that starts after the new library wheel is published.

> **Testing mandate (non-negotiable).** The new library surface must be **thoroughly tested at every level**: Rust **unit** tests for the pure `format_mthds_impl` / `lint_mthds_impl` (no Python needed), Rust **integration** tests (`tests/`) for the public crate API and parity against the `plxt` CLI on a shared corpus, and **end-to-end** Python tests that `import pipelex_tools` from the *built wheel* and exercise both functions on known-good and known-bad `.mthds` inputs (run in CI as the wheel smoke test, not just locally). "As appropriate" means: every reachable diagnostic `kind` (syntax / semantic / schema), the decision-#2 no-raise-on-syntax-error path, the offline-schema guarantee, and the baked-defaults-plus-override formatting behavior each get a test. No diagnostic path ships unverified. See [Testing strategy](#testing-strategy).

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

## The architecture: two packages

maturin cannot put a native binary and a pyo3 extension module in the same wheel. So the repo publishes **two PyPI packages**, each built natively by maturin (no custom wheel surgery):

| Package | Wheel kind | Built from | Ships | Status |
| --- | --- | --- | --- | --- |
| **`pipelex-tools`** (existing) | native bin (`py3-none-<platform>`) | `crates/pipelex-cli` via **root** `pyproject.toml` (`bindings = "bin"`) | the real native `plxt` executable, in `…​.data/scripts/plxt` | **unchanged** |
| **`pipelex-tools-lib`** (new) | abi3 cdylib (`cp38-abi3-<platform>`) | `crates/pipelex-py` via `crates/pipelex-py/pyproject.toml` (`bindings = "pyo3"`) | `import pipelex_tools` → `format_mthds` / `lint_mthds` | new |

- `pip install pipelex-tools` → a **true native** `plxt` (zero Python startup, exactly as today).
- `pip install pipelex-tools-lib` → `import pipelex_tools` (the library `pipelex-api` consumes).
- They coexist in one env (script in `bin/` vs module in site-packages — no file overlap).

**Library package name `pipelex-tools-lib` is provisional** — nothing is published yet, so it's a cheap rename (one `[project] name` + the downstream pin). The Python **import** name is fixed at `pipelex_tools` (the cdylib `[lib] name`).

**Why this leaves the CLI pristine.** Because the CLI ships from `pipelex-cli` exactly as before, **none** of the abandoned single-wheel surgery is needed: no bin move, no `cli_main()` extraction, no `_run_cli` shim, no relocating `pipelex-cli`'s integration tests. `crates/pipelex-cli` is untouched (still owns `[[bin]] plxt` + `tests/{schema_path,quiet_flag}.rs`, version `0.7.0`), and the root `pyproject.toml` / `ci.yaml` auto_tag / `Makefile cli:` target are all unchanged.

**Feature-gate PyO3 in the library crate.** `pyo3` + `pythonize` are optional, behind a `python` feature, and **all** binding code is `#[cfg(feature = "python")]`-gated:

- `cargo build`, `cargo test`, `cargo check`, the MSRV jobs → feature off → **no PyO3, no Python interpreter needed**. Verified: `cargo tree -i pyo3` finds nothing in the default graph.
- `maturin build` (from `crates/pipelex-py`) → reads `features = ["python"]` from its `[tool.maturin]` → compiles the cdylib with PyO3.

The pure format/lint logic is **not** gated (plain Rust returning `#[derive(Serialize)]` structs), so it compiles and unit-tests without Python. Only the thin `#[pyfunction]` / `#[pymodule]` wrappers are gated.

**Parity tests need a built `plxt`.** Since the `plxt` bin lives in `pipelex-cli` (not `pipelex-py`), the library crate's `tests/parity.rs` **cannot** use `env!("CARGO_BIN_EXE_plxt")` (Cargo only sets that for the bin-owning crate). Options for Phase 4: put the parity test in `pipelex-cli/tests/` (where `CARGO_BIN_EXE_plxt` is available) and have it call the library crate as a path dep, or resolve a freshly-built `plxt` via `CARGO_BIN_EXE_plxt`-from-`pipelex-cli` / `assert_cmd`. Decide when writing Phase 4.

---

## Crate layout

New **library-only** crate `crates/pipelex-py/` (Python import name `pipelex_tools`, published as `pipelex-tools-lib`). This is the as-built Phase-1 skeleton; Phase 2/3 add `diagnostic.rs` / `format.rs` / `lint.rs` and a `tests/` dir.

```
crates/pipelex-py/
  Cargo.toml          # library-only: cdylib + rlib, no [[bin]]
  pyproject.toml      # the pipelex-tools-lib package (bindings = "pyo3")
  src/
    lib.rs            # #[cfg(feature="python")] mod python;  (+ pub mod diagnostic/format/lint in Phase 2/3)
    python.rs         # #[cfg(feature="python")] #[pyfunction] wrappers + #[pymodule]
    diagnostic.rs     # (Phase 2) Diagnostic + Range structs (Serialize) + offset→line/col helper
    format.rs         # (Phase 2) format_mthds_impl(content, options) -> FormatOutcome   (pure, sync)
    lint.rs           # (Phase 3) lint_mthds_impl(content, source) -> Vec<Diagnostic>    (pure; block_on inside)
  tests/
    parity.rs         # (Phase 4) binding output vs `plxt fmt -` / `plxt lint -`  (see note above re: CARGO_BIN_EXE_plxt)
```

`Cargo.toml` as built in Phase 1 (note: **no `[[bin]]`, no `pipelex-cli`/`pipelex-common` deps** — the library uses `taplo` / `taplo-common` directly):

```toml
[package]
name         = "pipelex-py"
version      = "0.1.0"
publish      = false
# … workspace package fields …

[lib]
name       = "pipelex_tools"       # the Python module name
crate-type = ["cdylib", "rlib"]    # cdylib for maturin, rlib so `cargo test` can link the impls

[dependencies]
taplo        = { path = "../taplo" }
taplo-common = { path = "../taplo-common", features = ["rustls-tls", "schema", "reqwest"] }
anyhow       = { workspace = true }
serde        = { workspace = true, features = ["derive"] }
serde_json   = { workspace = true }
tokio        = { workspace = true, features = ["rt"] }   # current-thread runtime for block_on (lint schema stage)
url          = { workspace = true }
pyo3         = { version = "0.23", features = ["abi3-py38", "extension-module"], optional = true }
pythonize    = { version = "0.23", optional = true }

[features]
python = ["dep:pyo3", "dep:pythonize"]

[lints]
workspace = true
```

(pyo3/pythonize 0.23 — MSRV 1.63, comfortably under the repo's 1.74; pin both to the same minor. `extension-module` suppresses `-lpython` so the abi3 wheel links against no specific interpreter.)

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

## Packaging mechanics (two `pyproject.toml` files)

The repo now has **two** maturin projects. They never collide because each is invoked from its own directory / manifest.

**Root `pyproject.toml` — the CLI package `pipelex-tools` (UNCHANGED):**

```toml
[tool.maturin]
bindings      = "bin"
manifest-path = "crates/pipelex-cli/Cargo.toml"
include       = ["LICENSE"]
```

**`crates/pipelex-py/pyproject.toml` — the library package `pipelex-tools-lib` (NEW):**

```toml
[project]
name = "pipelex-tools-lib"
requires-python = ">=3.8,<3.15"   # matches abi3-py38 → one wheel per os × arch
dynamic = ["version"]             # maturin reads the version from crates/pipelex-py/Cargo.toml

[tool.maturin]
bindings      = "pyo3"
manifest-path = "Cargo.toml"      # relative to this pyproject → crates/pipelex-py/Cargo.toml
features      = ["python"]        # turn PyO3 on only for the wheel build
```

- Build the library: `cd crates/pipelex-py && maturin build` (or `maturin develop` for dev — `make pipelex-lib`). Build the CLI: `maturin build` from the repo root (`make pipelex-tools`). Both land in `target/wheels/`.
- ✅ **Phase-1 gate — RESOLVED.** Proven end-to-end: the root build yields `pipelex_tools-0.7.0-py3-none-<plat>.whl` carrying the **native** `plxt` binary in `…​.data/scripts/plxt`; the library build yields `pipelex_tools_lib-0.1.0-cp38-abi3-<plat>.whl` from which `import pipelex_tools` works after `pip install`. `cargo build`/`test` stay PyO3-free. **One wheel carrying both was abandoned (maturin can't) — see the architecture note at the top.**
- ⚠️ **TODO (Phase 4): per-target binary build for the library on Windows.** abi3 linking differs on Windows; the library wheel must be exercised on the CI matrix (incl. Windows) via the import smoke test, not just locally on macОS.

---

## Release & downstream wiring (Phase 4)

The CLI release path is **untouched**. The library gets a **parallel, independent** release path under a new tag. Independent versions: the CLI keeps its own version in `crates/pipelex-cli/Cargo.toml` (and the `plxt-cli/v*` tag); the library version lives in `crates/pipelex-py/Cargo.toml` (maturin reads it via `dynamic = ["version"]`).

- **New tag scheme `pipelex-tools-lib/v*`** for the library. Add it to `on.push.tags` in both `ci.yaml` and `releases.yaml`. In `ci.yaml`'s `auto_tag`, add a step that reads the version from `crates/pipelex-py/Cargo.toml` and creates `pipelex-tools-lib/v${LIB_VERSION}` (mirroring the existing `plxt-cli` step — do **not** touch the existing one). In `releases.yaml`'s `get_version`, add a `pipelex-tools-lib` output.
- **New release jobs in `releases.yaml`** mirroring `pypi_build_plxt` / `pypi_test_plxt` / `pypi_publish_plxt`, but for the library:
  - build job: same `os × arch` matrix, but tell `PyO3/maturin-action` to use the library project via `working-directory: crates/pipelex-py` (so it picks up `crates/pipelex-py/pyproject.toml` → `bindings = "pyo3"`). Gate on the `pipelex-tools-lib/v*` tag.
  - test job: `pip install pipelex-tools-lib --no-index --find-links wheels/`, then the import smoke test (below) on **every** matrix OS (incl. Windows — abi3 linking differs there).
  - publish job: `pypa/gh-action-pypi-publish`, gated on the `pipelex-tools-lib/v*` push.
- **Library import smoke test** (the e2e gate in CI — replaces the old "extend `pypi_test_plxt`" idea, since the library is now a separate wheel): `python -c "import pipelex_tools; assert pipelex_tools.format_mthds('a=1')['formatted']; assert 'diagnostics' in pipelex_tools.lint_mthds('a=1')"`. Keep `pypi_test_plxt`'s `plxt help` exactly as-is for the CLI.
- **Makefile (done in Phase 1):** `cli:` / `pipelex-tools:` unchanged (CLI); added `pipelex-lib:` (`cd crates/pipelex-py && maturin develop --release`); `test:` runs `cargo test -p pipelex-py`; `check:` runs `cargo check -p pipelex-py --locked`. `build:` builds CLI + library + ext.
- **Docs (per the repo doc rule):** add `docs/dev/pipelex-tools-python-bindings.md` — the two functions, the `Diagnostic` shape, the embedded-schema-only guarantee, `import pipelex_tools` usage, and the **two-package split** (why `pip install pipelex-tools-lib` for the library vs `pipelex-tools` for the CLI). Update in the same change as the code.
- **CHANGELOG.md:** add an entry under the current release section (no empty `## [Unreleased]` left behind). Tag `pipelex-tools-lib/v0.1.0` once green.
- **Downstream (separate repo/PR):** in `pipelex-api`, add the pin to **`pipelex-tools-lib>=0.1.0`** (not `pipelex-tools`) and add `/v1/lint` + `/v1/format` (modeled on `api/routes/pipelex/validate.py` — diagnostic 200-with-discriminator, opt-in `rendered_markdown`, RFC 7807 only for no-verdict). Not part of this repo's work.

---

## Phase-by-phase plan

### Phase 1 — packaging (DONE ✅)
Stand up `crates/pipelex-py` as a **library-only** crate (cdylib + rlib) with one trivial gated `#[pyfunction]` (`ping`) and its `#[pymodule]`, plus its own `pyproject.toml` (`bindings = "pyo3"`, `features = ["python"]`). `pyo3`/`pythonize` are optional behind the `python` feature; all binding code is `#[cfg(feature = "python")]`-gated. `crates/pipelex-cli` is left pristine (keeps `[[bin]] plxt` + its tests + version `0.7.0`); the root `pyproject.toml` keeps `bindings = "bin"`. Makefile gains `pipelex-lib:` and adds `pipelex-py` to `test:` / `check:`.

**What was verified (all green):**
- `cargo build --bin plxt` and `cargo tree -i pyo3` → **no PyO3 in the default graph**.
- `cargo test -p pipelex-cli -p pipelex-py` → green (CLI's `quiet_flag` + `schema_path` integration tests still pass in place).
- `cargo clippy --workspace --all-targets` (default) **and** `cargo clippy -p pipelex-py --features python` → no warnings; `cargo fmt --check` + `plxt fmt --check` clean; `cargo check -p pipelex-py --locked` clean.
- Root `maturin build` → `pipelex_tools-0.7.0-py3-none-<plat>.whl` carrying the **native** `plxt` in `…​.data/scripts/plxt`.
- `crates/pipelex-py` `maturin build` → `pipelex_tools_lib-0.1.0-cp38-abi3-<plat>.whl`; in a clean venv, `pip install` + `import pipelex_tools` + `ping()` works, and the wheel ships **no** `plxt` (correct).

> **Checkpoint 1 (met):** the **two-wheel** packaging is proven — native `plxt` CLI wheel (unchanged) + importable `pipelex_tools` library wheel. Plain `cargo build`/`test` and the MSRV jobs remain Python-free; the CLI `os × arch` matrix is unchanged. (The single-wheel-carries-both idea was found infeasible with maturin and replaced by the two-package architecture — see the top of this doc.)

### Phase 2 — implement `format_mthds`
Pure, sync. `diagnostic.rs` (structs + `offset_to_line_col`) and `format.rs` (`format_mthds_impl`) with the decision-#2 syntax behavior and baked canonical defaults + caller overrides. Gated `#[pyfunction] format_mthds` in `python.rs`. **Unit tests (per the testing mandate):** known-good (format `test-data/mthds/*.mthds` corpus; an already-formatted file gives `changed:false`); known-bad (a string with a syntax error → `changed:false` + a `kind:"syntax"` diagnostic, content returned unchanged — never raises); baked-default behavior (an unformatted-but-valid input becomes the canonical MTHDS style); caller-override behavior (an `options` value overrides a baked default); the `Diagnostic` line/col mapping (assert 1-based codespan coords on a known offset).

### Phase 3 — implement `lint_mthds`
`lint.rs` (`lint_mthds_impl`): parse → `dom.validate()` → `Schemas::validate_root` against the embedded `pipelex://mthds.schema.json`, the schema stage run under a current-thread runtime `block_on`. Emit `kind`-tagged diagnostics, short-circuiting per stage. Gated `#[pyfunction] lint_mthds` with `Python::allow_threads` around the runtime. **Unit tests (per the testing mandate) — one per reachable path:** clean (`test-data/mthds/lint/valid.mthds` → `[]`); schema-error (`test-data/mthds/lint/invalid_schema.mthds` → a `kind:"schema"` diagnostic with a non-null `location`); inline syntax-error string (`kind:"syntax"`); inline semantic-error string (`kind:"semantic"`); and an **offline assertion** (validation succeeds with no network — e.g. assert it returns under a tight time bound / never touches `http`).

> **Checkpoint 2:** both functions implemented; `cargo test -p pipelex-py` green (impls tested without Python); a local Python e2e smoke test (`cd crates/pipelex-py && maturin develop`, then in the venv `import pipelex_tools` and format + lint a known-good and known-bad `.mthds`) passes.

### Phase 4 — parity + integration/e2e tests + CI + release
- **Rust integration `tests/parity.rs`:** assert binding output matches `plxt lint -` / `plxt fmt -` (compact) on a `test-data/` corpus. ⚠ `CARGO_BIN_EXE_plxt` is **not** available to `pipelex-py` (the bin lives in `pipelex-cli`) — either put the parity test in `crates/pipelex-cli/tests/` (calling `pipelex-py` as a path dep + `env!("CARGO_BIN_EXE_plxt")`), or resolve a built `plxt` another way (`assert_cmd`/explicit build). Decide here.
- **Python e2e tests in CI:** the import smoke test as a **new** `pypi_test_pipelex_lib` matrix job (every OS incl. Windows) — `pip install pipelex-tools-lib`, then `import pipelex_tools` + `format_mthds` + `lint_mthds` on known-good/known-bad inputs. Leave `pypi_test_plxt` (`plxt help`) untouched for the CLI.
- **Release wiring:** add the `pipelex-tools-lib/v*` tag + `get_version` output + the build/test/publish jobs (see "Release & downstream wiring" above).
- **Docs + CHANGELOG:** add `docs/dev/pipelex-tools-python-bindings.md`; CHANGELOG entry. Then `make check` clean. Tag `pipelex-tools-lib/v0.1.0` → `releases.yaml` builds/tests/publishes the library wheel.

> **Checkpoint 3:** `pipelex-tools-lib` published with `import pipelex_tools` exposing `format_mthds` / `lint_mthds` (CLI `pipelex-tools` untouched). Hand off to `pipelex-api` (separate session/repo): add the `pipelex-tools-lib` pin, add `/v1/lint` + `/v1/format`.

---

## Open decisions to settle while building

- **Library package name.** `pipelex-tools-lib` is provisional (nothing published yet). Confirm before Phase-4 tag/publish — it's the name `pipelex-api` will pin. The import name `pipelex_tools` is fixed.
- **Runtime reuse.** Building a current-thread runtime per `lint_mthds` call is simple and correct (validation is fast and fully in-memory). If profiling later shows it matters, cache a runtime in a `thread_local!` or `OnceLock`. Start simple.
- **Parity-test home** (Phase 4): `crates/pipelex-cli/tests/` (has `CARGO_BIN_EXE_plxt`) vs a self-built `plxt` resolver. See Phase 4.
- **Final `Diagnostic` field names** — coordinate with the `pipelex-api` wire models so the route can `model_validate` with minimal remapping; the API repo owns the contract.
- **`end_line`/`end_col` for rangeless errors** — semantic/schema errors with no `TextRange` emit `range: null`; confirm the downstream renderer tolerates null (it should, mirroring the wasm `Option<Range>`).

_Resolved during Phase 1:_ single-wheel-carries-both → **infeasible with maturin, replaced by two packages**. `maturin develop` honors `[tool.maturin] features` → confirmed (no explicit `--features python` needed). `pipelex-cli` version → **stays independent at `0.7.0`** (CLI untouched), library versioned separately.

---

## Testing strategy

The new library surface must be covered at **three levels** — this is a hard requirement, not best-effort.

1. **Unit (Rust, no Python) — `cargo test -p pipelex-py`.** The pure `format_mthds_impl` / `lint_mthds_impl` return `#[derive(Serialize)]` structs, so they're testable without a Python interpreter. Cover **every reachable diagnostic path**: format known-good / syntax-error (no-raise, decision #2) / baked-default / caller-override / line-col mapping; lint clean / syntax / semantic / schema (with `location`) / offline. Fixtures: `test-data/mthds/*.mthds`, `test-data/mthds/lint/{valid,invalid_schema}.mthds`.
2. **Integration (Rust, `tests/`) — parity.** Binding output must match the `plxt` CLI (`plxt fmt -` / `plxt lint -`) on a shared corpus, so the in-process library and the shipped binary can't drift. (Mind the `CARGO_BIN_EXE_plxt` caveat — see Phase 4.)
3. **End-to-end (Python, from the built wheel) — in CI on every OS.** `pip install pipelex-tools-lib` (the actual wheel, incl. Windows abi3), then `import pipelex_tools` and exercise `format_mthds` / `lint_mthds` on known-good and known-bad `.mthds` — asserting on the structured `diagnostics` (`kind`, `range`, `location`), not just truthiness. This is the gate that catches packaging/ABI regressions a `cargo test` cannot.

No diagnostic path ships unverified; no `kind` is added without a test that reaches it.

---

## Acceptance criteria (definition of done for this repo's half)

- `pip install pipelex-tools` gives a working **native** `plxt` command (unchanged); `pip install pipelex-tools-lib` gives `import pipelex_tools` exposing `format_mthds` and `lint_mthds`.
- `lint_mthds` validates `.mthds` against the embedded schema only, fully offline; no code path fetches an external schema.
- `format_mthds` returns `{formatted, changed, diagnostics}`, never raising on syntax errors (decision #2), with output matching `plxt fmt -` on the corpus.
- `cargo build` and `cargo test` (and the MSRV jobs) remain PyO3-free; `make check` is green.
- **All three test levels pass** (unit + parity integration + Python e2e-from-wheel) — see [Testing strategy](#testing-strategy); every diagnostic path is covered.
- Library version set, CHANGELOG updated, `docs/` updated, tag `pipelex-tools-lib/v0.1.0` pushed → `releases.yaml` builds/tests/publishes the library wheel. CLI release path untouched.

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
| Native environment | `taplo_common::environment::native::NativeEnvironment` |
| Canonical format defaults source | `plxt.toml` (global `[formatting]` + `**/*.mthds` rule) |
| CLI package maturin config (UNCHANGED) | root `pyproject.toml` `[tool.maturin]` (`bindings = "bin"`) |
| Library package maturin config | `crates/pipelex-py/pyproject.toml` (`bindings = "pyo3"`) — built in Phase 1 |
| CLI release path (UNCHANGED) | `.github/workflows/releases.yaml` (`pypi_build_plxt` / `pypi_test_plxt` / `pypi_publish_plxt`); `ci.yaml` `auto_tag` `plxt-cli/v*` |
| Library release jobs to ADD (Phase 4) | `releases.yaml` (mirror the plxt jobs with `working-directory: crates/pipelex-py`); new tag `pipelex-tools-lib/v*` in `ci.yaml` + `releases.yaml` |
| `.mthds` test fixtures | clean: `test-data/mthds/lint/valid.mthds`; schema-invalid: `test-data/mthds/lint/invalid_schema.mthds`; format corpus: `test-data/mthds/*.mthds` |
| Docs to add (Phase 4) | `docs/dev/pipelex-tools-python-bindings.md` (new) |
| Library crate (created, Phase 1) | `crates/pipelex-py/` (library-only: `Cargo.toml`, `pyproject.toml`, `src/{lib,python}.rs`) |
