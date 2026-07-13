# One MTHDS lint/format engine, several bindings

This repo ships MTHDS **lint** and **format** through several surfaces — a CLI, a Python wheel, and two WASM packages. They are not reimplementations: every one of them binds the **same Rust engine**, so their behavior and their `Diagnostic` wire shape agree **by construction**, and parity is additionally enforced by tests.

## The bindings

| Surface | Artifact | Built from | Consumer |
| --- | --- | --- | --- |
| `plxt` CLI | PyPI `pipelex-tools` (native binary) | `crates/pipelex-cli` | terminals, editors' format-on-save, CI |
| Python library | PyPI `pipelex-tools-py` (`import pipelex_tools`) | `crates/pipelex-py` | `pipelex-api`'s in-process `/v1/lint` + `/v1/format` |
| Language server | npm `@pipelex/lsp` (LSP-in-WASM) | `crates/pipelex-wasm` | the VS Code extension |
| Lint/format-only WASM | npm `@pipelex/tools-wasm` | `crates/pipelex-tools-wasm` + `js/tools-wasm` | Node consumers that need offline lint/format without the LSP — e.g. plugin hook bundles |

## Where the engine lives

The shared implementation is `pipelex_common::tools` (`crates/pipelex-common/src/tools/`), behind the `tools` cargo feature so default `pipelex-common` consumers don't pull in schema/serde machinery:

- `format.rs` — `format_mthds_impl(content, options)`: canonical MTHDS style baked in (the effective `**/*.mthds` settings from this repo's `plxt.toml`), optional per-call overrides, never raises on malformed content (returns the input unchanged plus the blocking syntax diagnostics).
- `lint.rs` — a shared async core `lint_mthds_with_env<E: Environment>` (syntax → semantic → schema, short-circuiting at the first failing stage) plus two sync wrappers:
  - `lint_mthds_impl` — native-only: tokio current-thread runtime + `NativeEnvironment`. This is what the Python wheel binds.
  - `lint_mthds_offline` — compiles on every target: `NullEnvironment` + `now_or_never()`. This is what `@pipelex/tools-wasm` binds. A native unit test asserts it produces identical diagnostics to `lint_mthds_impl` across all lint stages.
- `environment.rs` — `NullEnvironment`, a capability-less `taplo_common::environment::Environment` (fixed clock, empty stdio, erroring FS, panicking spawn) so the WASM binding needs no JS environment object or async plumbing.
- `diagnostic.rs` — the `Diagnostic` / `Range` serde structs, i.e. the wire contract.

Both lint paths validate against the **embedded official MTHDS schema only** (`pipelex://mthds.schema.json`), constructed with `http: None` — provably offline, no config discovery, no external `$ref` fetching. Consequence for WASM/vendored consumers: **the schema freezes at build time**, so package releases are the local schema update cadence; the server-side `validate` remains the authoritative verdict on skew.

## The wire contract

Every binding emits the identical diagnostic shape:

```
Diagnostic = {
  kind: "syntax" | "semantic" | "schema",
  severity: "error",
  message: string,
  location: string | null,     // dotted instance path for schema errors
  range: { start_offset, end_offset, start_line, start_col, end_line, end_col } | null,
}
```

with `lint` returning `{ diagnostics }` and `format` returning `{ formatted, changed, diagnostics }`. This shape is mirrored by `@pipelex/sdk` (`pipelex-sdk-js/src/models.ts`) and served by `pipelex-api`. Everything that serializes into it carries a `⚠️ PUBLIC BINDING SURFACE` marker — grep for that before touching any of these types, and keep all mirrors (Rust structs, the Python `.pyi` stub, `js/tools-wasm/src/index.ts` types, `@pipelex/sdk` models) in sync in the same change.

One subtlety specific to the WASM binding: serialization goes through `serde_wasm_bindgen`'s JSON-compatible serializer so absent `location`/`range` come out as `null` — the default serializer would emit `undefined` and silently drop always-present fields from the wire shape.

## `@pipelex/tools-wasm` specifically

`crates/pipelex-wasm` (behind `@pipelex/lsp`) is deliberately **not** reused for lint/format consumers: it compiles in the whole language server and HTTP plumbing, making its bundle an order of magnitude larger, and its `lint` returns an impoverished shape. `crates/pipelex-tools-wasm` is a thin `wasm-bindgen` binding over the shared engine — no LSP, no CLI deps, fully sync (no Promises beyond the one-time `initialize()`), yielding a single-digit-MB bundle that a hook can vendor. (`reqwest` still rides along as dead code behind `http: None`, because `taplo-common`'s `schema` feature can't compile without it.)

The JS package (`js/tools-wasm`, npm `@pipelex/tools-wasm`) exposes module-level `initialize()` / `lintMthds()` / `formatMthds()`. Format options use the same snake_case passthrough keys as `plxt fmt -o key=value` and the API's `/v1/format` options, so consumers can treat the local and remote engines identically. See its [README](../../js/tools-wasm/README.md) for the consumer-facing API.

## Parity enforcement

- **Rust unit** — `cargo test -p pipelex-common --features tools`: every reachable diagnostic path of the shared impls, plus the offline-vs-native lint equivalence test.
- **Rust parity corpus** — `crates/pipelex-cli/tests/parity.rs`: the in-process library output must match the shipped `plxt` binary on the whole `test-data/mthds` corpus.
- **Python e2e** — `crates/pipelex-py/tests/test_smoke.py` against the built wheel (`make test-pipelex-lib`).
- **JS corpus snapshots** — `js/tools-wasm/tests/` run vitest **against the built bundle** (what a Node consumer actually gets), with committed snapshots of lint diagnostics and formatted output over the same `test-data/mthds` corpus, plus wire-shape guards (`null` vs dropped fields, option stringification, never-throws-on-malformed-content).

## Build, test, publish

- `make tools-wasm` builds the JS package (debug; `RELEASE=true make tools-wasm` for the release artifact); `make test-tools-wasm-js` builds and runs its vitest suite; `make test-pipelex-tools-wasm` runs the crate's native-side unit tests. All are part of `make test` / `make check`.
- Publishing `@pipelex/tools-wasm` is manual via `./publish-tools-wasm.sh [patch|minor|major|none]` at the repo root (same pattern as `publish-lsp.sh`): release build → vitest against the release bundle → version bump → `npm publish`. Commit the version bump afterwards.
- The Python wheel and CLI have their own tag-driven release automation — see [`release-publishing.md`](release-publishing.md) and [`pipelex-tools-python-bindings.md`](pipelex-tools-python-bindings.md).
