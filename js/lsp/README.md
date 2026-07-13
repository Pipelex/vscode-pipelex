# @pipelex/lsp

The Pipelex **TOML / MTHDS language server**, compiled to WebAssembly and wrapped in a small JavaScript API. This is the language server behind the [Pipelex VS Code extension](https://github.com/Pipelex/vscode-pipelex): a fork of [taplo](https://github.com/tamasfe/taplo)'s LSP extended with first-class support for **MTHDS** (the language for AI methods, `.mthds` files) — schema validation, completion, hover, go-to-definition for pipe/concept references, semantic tokens, and formatting — while keeping taplo's full TOML support.

The package is transport-agnostic: it speaks raw LSP JSON-RPC messages, and you provide the environment (filesystem, stdio, fetch) it runs against, so it can be hosted in a Node process, a web worker, or any custom harness.

## Usage

```ts
import { PipelexLsp, RpcMessage } from "@pipelex/lsp";
import { Environment } from "@taplo/core";

const env: Environment = {
  /* filesystem, stdio, fetch, ... — see @taplo/core */
};

const lsp = await PipelexLsp.initialize(env, {
  onMessage(message: RpcMessage) {
    // LSP JSON-RPC messages emitted by the server → forward to your client
  },
});

// Forward your client's JSON-RPC messages to the server:
lsp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { /* ... */ } });

// When done:
lsp.dispose();
```

## Looking for lint/format only?

If you just need MTHDS **lint** and **format** results (e.g. in a CI check or an agent hook) without a language server, use [`@pipelex/tools-wasm`](https://www.npmjs.com/package/@pipelex/tools-wasm) instead — a much smaller package binding the same Rust engine, fully offline, emitting the same `Diagnostic` wire shape as the Pipelex API's `/v1/lint` and `/v1/format`.

## Related

- [Pipelex VS Code extension](https://marketplace.visualstudio.com/items?itemName=Pipelex.pipelex) — the primary consumer of this package
- [MTHDS](https://mthds.ai) — the open standard for AI methods
- [Pipelex](https://pipelex.com) — the runtime that executes MTHDS methods
- [taplo](https://taplo.tamasfe.dev) — the upstream TOML toolkit this language server is forked from

## Development

Built from [`crates/pipelex-wasm`](https://github.com/Pipelex/vscode-pipelex/tree/main/crates/pipelex-wasm) via rollup + `@wasm-tool/rollup-plugin-rust`, with the WASM inlined into a single bundle. See the [repository](https://github.com/Pipelex/vscode-pipelex) for build instructions.
