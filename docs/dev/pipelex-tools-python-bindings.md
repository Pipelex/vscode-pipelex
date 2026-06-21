# Pipelex Tools — Python bindings (`import pipelex_tools`)

`pipelex_tools` is an importable Python library that exposes MTHDS **lint** and **format** as in-process functions, so a Python host (e.g. the `pipelex-api` FastAPI server) can validate and format `.mthds` content without shelling out to the `plxt` binary. It is a thin PyO3 wrapper around the same `taplo`/`taplo-common` engine the `plxt` CLI uses, so the library and the binary cannot drift (enforced by parity tests — see [Testing](#testing)).

The bindings live in the `crates/pipelex-py` crate (Python module name `pipelex_tools`, published as the `pipelex-tools-lib` wheel).

## Two packages, one repo

maturin cannot pack a native binary and a pyo3 extension module into the same wheel, so the CLI and the library are **two separate PyPI packages** built from this one repo:

| Install | Wheel kind | Gives you | Built from |
| --- | --- | --- | --- |
| `pip install pipelex-tools` | native bin | the real `plxt` executable (zero Python startup) | `crates/pipelex-cli` via the **root** `pyproject.toml` (`bindings = "bin"`) |
| `pip install pipelex-tools-lib` | abi3 cdylib | `import pipelex_tools` → `format_mthds` / `lint_mthds` | `crates/pipelex-py` via `crates/pipelex-py/pyproject.toml` (`bindings = "pyo3"`) |

They coexist in one environment with no file overlap (a script in `bin/` vs a module in `site-packages`). The Python **import** name is `pipelex_tools` either way; only the PyPI **distribution** name differs. The `pipelex-api` server depends on `pipelex-tools-lib`.

The PyO3 glue is behind a `python` cargo feature, so plain `cargo build` / `cargo test` and the MSRV jobs stay PyO3-free; maturin turns the feature on for the wheel build (`[tool.maturin] features = ["python"]`).

## API

```python
import pipelex_tools

format_mthds(content: str, *, options: dict | None = None) -> dict
    # { "formatted": str, "changed": bool, "diagnostics": [Diagnostic] }

lint_mthds(content: str, *, source: str | None = None) -> dict
    # { "diagnostics": [Diagnostic] }   ([] == clean)
```

### `format_mthds`

Formats `content` with the canonical MTHDS style baked in (the effective `**/*.mthds` settings from this repo's `plxt.toml`, so server output matches what the VS Code extension writes on save). `options` is an optional dict of formatter overrides (the same keys as the CLI's `-o key=value`, e.g. `{"column_width": 100, "align_entries": False}`); it overrides any baked default.

- On a **syntax error** the input is returned unchanged: `formatted == content`, `changed == False`, and `diagnostics` carries the blocking `kind: "syntax"` error(s). It does **not** raise — malformed MTHDS is surfaced as data, never an exception.
- It **does** raise `ValueError` for a malformed *option value* (e.g. a non-numeric `column_width`). That is the one raising path: bad content never raises, a bad option does.

```python
>>> pipelex_tools.format_mthds("a=1")
{'formatted': 'a = 1\n', 'changed': True, 'diagnostics': []}

>>> pipelex_tools.format_mthds("key = ")["diagnostics"][0]["kind"]
'syntax'
```

### `lint_mthds`

Validates `content` in stages — **syntax → semantic → schema** — short-circuiting at the first failing stage and returning that stage's diagnostics (empty == clean). `source` is an optional logical filename reserved for locators; it is accepted for API symmetry but currently a no-op.

Like `format_mthds`, it **never raises on bad content**: even a validator failure that can't be mapped to a document position is surfaced as a single location-less `kind: "schema"` diagnostic rather than an exception.

```python
>>> pipelex_tools.lint_mthds(valid_mthds)
{'diagnostics': []}

>>> [d["kind"] for d in pipelex_tools.lint_mthds(bad_mthds)["diagnostics"]]
['schema']
```

#### Embedded schema only — fully offline

`lint_mthds` validates against the **embedded official MTHDS schema only** (`pipelex://mthds.schema.json`), and is provably offline: it constructs the validator with `http = None` (no client to fetch with) and calls `validate_root` with the hardcoded builtin URL directly. There is **no** code path that reaches out for another schema — no `--schema` equivalent, no catalogs, no `.taplo.toml`/`plxt.toml` associations, no external `$ref` fetching. This is what lets a server call it in a request path with no network dependency.

> Note: the builtin **URL** matters. Loading the same schema *file* via a `file://` path resolves its internal `$ref`s under a different base URI, which collapses an MTHDS pipe's `oneOf` branch errors into a single "does not match any of the allowed schemas". The library (and the extension/hook in production) always validate against the builtin `pipelex://mthds.schema.json`.

### `Diagnostic` shape

Both functions return diagnostics with this stable shape (`location` and `range` are always present, `null` when absent):

```python
Diagnostic = {
    "kind": "syntax" | "semantic" | "schema",
    "severity": "error",          # room to grow; lint is all-errors today
    "message": str,
    "location": str | None,       # dotted instance path for schema errors (e.g. "pipe.foo.model")
    "range": {                    # None for semantic/schema errors that carry no position
        "start_offset": int, "end_offset": int,         # byte offsets
        "start_line": int, "start_col": int,            # 1-based, codespan-style
        "end_line": int, "end_col": int,
    } | None,
}
```

The line/column coordinates match the `plxt` CLI exactly. The `pipelex-api` repo owns the wire contract and `model_validate`s these.

## Testing

The surface is covered at three levels:

1. **Rust unit** (`cargo test -p pipelex-py`) — the pure `format_mthds_impl` / `lint_mthds_impl` (which return `#[derive(Serialize)]` structs) tested without a Python interpreter: every reachable diagnostic path (format known-good / syntax-error / baked-default / caller-override / line-col mapping; lint clean / syntax / semantic / schema-with-location / offline).
2. **Rust parity** (`crates/pipelex-cli/tests/parity.rs`) — the in-process library output must match the shipped `plxt` binary (`plxt fmt -` / `plxt lint -`) on the `test-data/mthds` corpus, so the two can't drift. It lives in `pipelex-cli` (not `pipelex-py`) because only the bin-owning crate gets `CARGO_BIN_EXE_plxt`; `pipelex-py` is a pure-Rust dev-dependency there.
3. **Python e2e from the built wheel** (`crates/pipelex-py/tests/test_smoke.py`) — `pip install pipelex-tools-lib`, then exercise the *shipped* module asserting on the structured `diagnostics`. Run locally via `make pipelex-lib-smoke`, and in CI on every release OS (incl. Windows, where abi3 linking differs) by the `pypi_test_pipelex_lib` job.

## Build & release

- Dev build: `make pipelex-lib` (`cd crates/pipelex-py && maturin develop --release`), or `make pipelex-lib-smoke` to also run the Python smoke test.
- Release: bump `version` in `crates/pipelex-py/Cargo.toml`; on push to `main`, `ci.yaml`'s auto-tag step creates `pipelex-tools-lib/v{version}`, which triggers the build/test/publish jobs in `releases.yaml`. The CLI release path (`plxt-cli/v*`) is entirely independent. See [`release-publishing.md`](release-publishing.md).
