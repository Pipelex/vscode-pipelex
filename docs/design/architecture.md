# Architecture

How the Pipelex crates extend the Taplo foundation to provide formatting, linting, and language-server support for `.mthds` and `.toml` files.

## Architecture Diagram

```
                    +-----------------+
                    |  VS Code Ext    |
                    |  (TypeScript)   |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
     +--------v---------+          +--------v--------+
     | server.ts (Node) |          | server-worker.ts|
     | PipelexLsp       |          | (Browser)       |
     +--------+---------+          +--------+--------+
              |                             |
              +-------------+---------------+
                            |
                   +--------v--------+
                   | @pipelex/lsp    |
                   | (js/lsp/)       |
                   | PipelexLsp class|
                   +--------+--------+
                            |
                   +--------v--------+
                   | pipelex-wasm    |   <-- WASM bindings
                   | (Rust -> WASM)  |
                   +--------+--------+
                            |
         +------------------+------------------+
         |                  |                  |
+--------v----+    +--------v----+    +--------v--------+
| pipelex-cli |    | pipelex-lsp |    | pipelex-common  |
| PlxtCli<E>  |    | PipelexLsp  |    | MthdsEnvironment|
+------+------+    +------+------+    +--------+--------+
       |                  |                    |
       |                  |                    |
+------v------+    +------v------+    +--------v--------+
| taplo-cli   |    | taplo-lsp   |    | taplo-common    |
| Taplo<E>    |    | Server<W>   |    | Environment     |
+------+------+    +------+------+    +--------+--------+
       |                  |                    |
       +------------------+--------------------+
                          |
                  +-------v-------+
                  | taplo (core)  |
                  | Parser, DOM,  |
                  | Formatter     |
                  +---------------+
```

## Crate Map

| Crate | Purpose | Key Types |
|---|---|---|
| `pipelex-common` | Core abstraction layer; overrides config discovery and schema extension lookup | `MthdsEnvironment<E>` |
| `pipelex-cli` | `plxt` binary; delegates format/get/lint to taplo-cli, handles LSP startup with the correct environment | `PlxtCli<E>`, `PlxtArgs` |
| `pipelex-lsp` | Message-level LSP extension over taplo-lsp; future home of MTHDS-specific diagnostics and completions | `PipelexLsp<E>` |
| `pipelex-wasm` | WASM bindings for browser and Node.js; mirrors taplo-wasm exports with `MthdsEnvironment` | `PipelexWasmLsp` |

## Config Discovery Order

`plxt` (and the bundled VS Code LSP) search for configuration in this order:

1. `.pipelex/plxt.toml` (preferred)
2. `plxt.toml`
3. `.taplo.toml` (fallback)
4. `taplo.toml`

The native CLI walks directories upward; the bundled WASM LSP checks the workspace root via a JS callback in `server.ts`.

## Schema Extensions: `x-plxt`

JSON Schemas for TOML/MTHDS files can embed Pipelex-specific metadata using the `x-plxt` extension key. This follows the same structure as the upstream `x-taplo` key but takes priority when both are present:

```json
{
  "type": "object",
  "properties": { "name": { "type": "string" } },
  "x-plxt": { "docs": { "main": "Pipelex-specific docs" } },
  "x-taplo": { "docs": { "main": "Taplo docs (fallback)" } }
}
```

Resolution order (see `crates/taplo-common/src/schema/ext.rs`):
1. `x-plxt` — used if present and valid
2. `x-taplo` — fallback

## Modified Upstream Files

The `x-plxt` schema extension required a change in shared taplo code:

| File | Change |
|---|---|
| `crates/taplo-common/src/schema/ext.rs` | Added `PLXT_EXTENSION_KEY` constant and `x-plxt`-first resolution in `schema_ext_of()` |

All other Pipelex functionality lives in additive crates (`pipelex-*`) and the extension layer (`editors/vscode/`, `js/lsp/`).

## Design Principle: plxt-first, taplo-fallback

This pattern applies consistently across the project:

- **Config files**: `.pipelex/plxt.toml` before `.taplo.toml`
- **Schema extensions**: `x-plxt` before `x-taplo`
- **Binary lookup**: `plxt` before `taplo` (when the extension runs in non-bundled mode)
