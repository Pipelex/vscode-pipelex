# @pipelex/tools-wasm

MTHDS lint & format compiled to WebAssembly — a lean, fully offline binding over the shared Rust engine that also powers the `plxt` CLI, the `pipelex-tools-py` Python library, and the Pipelex API's `/v1/lint` + `/v1/format`. All bindings emit the identical `Diagnostic` wire shape by construction.

- **Offline by design:** lint validates against the MTHDS JSON Schema embedded at build time — no HTTP, no filesystem, no config discovery. The schema therefore freezes at package build time; server-side `validate` remains the authoritative verdict on skew.
- **Lean:** unlike `@pipelex/lsp` (which carries the whole language server), this package exposes only `lintMthds` and `formatMthds`, small enough to vendor inside a plugin hook bundle.

## Usage

The package ships a single UMD bundle (like its `@taplo/lib` / `@pipelex/lsp` siblings), so pick the import form for your environment:

```js
// Bundlers (esbuild, rollup, webpack, vite) — the primary use-case of
// vendoring into a plugin hook bundle — resolve named imports from UMD:
import { initialize, lintMthds, formatMthds } from "@pipelex/tools-wasm";

// Native Node ESM cannot see named exports through the minified UMD wrapper;
// default-import and destructure instead:
import pkg from "@pipelex/tools-wasm";
const { initialize, lintMthds, formatMthds } = pkg;

// CommonJS:
const { initialize, lintMthds, formatMthds } = require("@pipelex/tools-wasm");
```

```js
// Once, at startup (loads the WASM module).
await initialize();

// Lint: syntax → semantic → schema, short-circuiting at the first failing stage.
const { diagnostics } = lintMthds(mthdsSource);
// diagnostics: [{ kind, severity, message, location, range }, ...] — empty == clean

// Format with the canonical MTHDS defaults; never throws on malformed MTHDS
// (the input comes back unchanged with the blocking diagnostics).
const { formatted, changed, diagnostics: formatDiagnostics } = formatMthds(mthdsSource);

// Formatter overrides use the same snake_case keys as `plxt fmt -o key=value`
// and the API's /v1/format options passthrough.
formatMthds(mthdsSource, { column_width: 100, align_entries: false });
```

The `Diagnostic` shape mirrors `@pipelex/sdk`'s `Diagnostic`/`DiagnosticRange`/`DiagnosticKind`: `location` and `range` are `null` (never absent) when the analysis cannot attribute a span.

## Development

Built from [`crates/pipelex-tools-wasm`](https://github.com/Pipelex/vscode-pipelex/tree/main/crates/pipelex-tools-wasm) via rollup + `@wasm-tool/rollup-plugin-rust`, with the WASM inlined into a single UMD bundle.

```sh
yarn build   # debug build (RELEASE=true yarn build for the release artifact)
yarn test    # vitest over the built bundle + the repo's MTHDS fixture corpus
```
