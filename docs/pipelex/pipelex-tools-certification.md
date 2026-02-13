# Pipelex Tools (plxt) - Feature Parity Certification & Code Map

## Certification Summary

The Pipelex wrapper crates provide **full feature parity** with the upstream taplo CLI and LSP, rebranded under the Pipelex / `plxt` identity. Zero upstream taplo crates were modified.

| Verification | Status | Details |
|---|---|---|
| `cargo test -p pipelex-common` | **5/5 pass** | MthdsEnvironment config discovery tests |
| `cargo check -p pipelex-cli` | **OK** | All features (lint, lsp, completions) compile |
| `cargo check -p pipelex-lsp` | **OK** | LSP server wrapper compiles |
| `cargo check -p pipelex-wasm --target wasm32-unknown-unknown` | **OK** | WASM target compiles |
| `cd editors/vscode && yarn test` | **26/26 pass** | Semantic token provider tests |
| VS Code extension debug launch | **OK** | LSP initializes and serves TOML/MTHDS files |

---

## Feature Parity Matrix

### CLI (`plxt` vs `taplo`)

| Command | taplo | plxt | How Delegated |
|---|---|---|---|
| `format` / `fmt` | `taplo format` | `plxt format` | Direct delegation to `taplo_cli::Taplo::execute()` |
| `lint` / `check` / `validate` | `taplo lint` | `plxt lint` | Direct delegation to `taplo_cli::Taplo::execute()` |
| `get` | `taplo get` | `plxt get` | Direct delegation to `taplo_cli::Taplo::execute()` |
| `lsp tcp` | `taplo lsp tcp` | `plxt lsp tcp` | **Custom handler** (fixes hard-coded NativeEnvironment bug) |
| `lsp stdio` | `taplo lsp stdio` | `plxt lsp stdio` | **Custom handler** (fixes hard-coded NativeEnvironment bug) |
| `config default` | `taplo config default` | `plxt config default` | Delegation to `taplo_cli::execute_config()` |
| `config schema` | `taplo config schema` | `plxt config schema` | Delegation to `taplo_cli::execute_config()` |
| `completions` | `taplo completions <shell>` | `plxt completions <shell>` | Local impl using `PlxtArgs::command()` |
| `toml-test` | `taplo toml-test` | *Not exposed* | taplo-internal testing tool, intentionally excluded |

### LSP Features

All LSP features are inherited from `taplo-lsp` via the `Server::handle_message()` delegation:

| LSP Feature | Status | Notes |
|---|---|---|
| TOML parsing & diagnostics | Inherited | Same parser (taplo core) |
| TOML formatting | Inherited | Same formatter |
| Schema validation | Inherited | Same schema infrastructure |
| Completions (TOML keys/values) | Inherited | Same completion handlers |
| Hover information | Inherited | Same hover handlers |
| Document symbols | Inherited | Same symbol provider |
| Semantic tokens | Inherited | Same token provider |
| Code actions | Inherited | Same code actions |
| Document links | Inherited | Same link provider |
| Folding ranges | Inherited | Same folding provider |

### WASM Exports

| WASM Function | taplo-wasm | pipelex-wasm | Difference |
|---|---|---|---|
| `initialize()` | `initialize()` | `initialize()` | Identical |
| `format()` | `WasmEnvironment` | `MthdsEnvironment<WasmEnvironment>` | Pipelex config discovery |
| `lint()` | `WasmEnvironment` | `MthdsEnvironment<WasmEnvironment>` | Pipelex config discovery |
| `to_json()` | `to_json()` | `to_json()` | Identical (pure parsing, no env) |
| `from_json()` | `from_json()` | `from_json()` | Identical (pure parsing, no env) |
| `run_cli()` | `Taplo::new(env)` | `PlxtCli::new(env)` | Uses pipelex-cli, MthdsEnvironment |
| `create_lsp()` | `TaploWasmLsp` | `PipelexWasmLsp` | MthdsEnvironment wrapping |

### Config File Discovery

| Context | Search Order |
|---|---|
| `plxt` CLI (native) | `.pipelex.toml` > `pipelex.toml` > `.taplo.toml` > `taplo.toml` (walks up directories) |
| VS Code extension (bundled LSP, Node) | `.pipelex.toml` > `pipelex.toml` > `.taplo.toml` > `taplo.toml` (via `server.ts` callback) |
| VS Code extension (non-bundled, external `plxt`) | Same as CLI |
| WASM (browser) | Delegates to JS `findConfigFile` callback |

### Environment Variable

| Tool | Config env var |
|---|---|
| `taplo` | `TAPLO_CONFIG` |
| `plxt` | `PIPELEX_CONFIG` (defined in `PlxtGeneralArgs`) |

---

## Pipelex-Specific Code Map

### New Rust Crates

#### `crates/pipelex-common/` - Foundation
The core abstraction layer. Contains the `MthdsEnvironment<E>` wrapper that makes all other pipelex crates work.

| File | Purpose | Lines |
|---|---|---|
| `Cargo.toml` | Crate manifest | 29 |
| `src/lib.rs` | Module declarations, re-exports `taplo_common` | 5 |
| `src/config.rs` | `PIPELEX_CONFIG_FILE_NAMES` constant | 3 |
| `src/environment.rs` | `MthdsEnvironment<E>` struct + `Environment` trait impl (15 delegated methods + custom `find_config_file`) + 5 unit tests | 265 |

**Key type**: `MthdsEnvironment<E: Environment>` - wraps any `Environment` impl, overrides `find_config_file` to search `.pipelex.toml`/`pipelex.toml` before falling back to the inner env's discovery.

#### `crates/pipelex-cli/` - CLI Binary
The `plxt` binary. Wraps `taplo-cli` with pipelex branding and the `MthdsEnvironment`.

| File | Purpose | Lines |
|---|---|---|
| `Cargo.toml` | Crate manifest with feature propagation | 49 |
| `bin/plxt.rs` | Entry point (`#[tokio::main]`) | 41 |
| `src/lib.rs` | `PlxtCli<E>` struct wrapping `taplo_cli::Taplo<E>` | 22 |
| `src/args.rs` | `PlxtArgs`, `PlxtCommand`, `PlxtConfigCommand`, `PlxtGeneralArgs` | 85 |
| `src/commands/mod.rs` | Command dispatch (delegates format/get/lint to taplo, handles lsp/config/completions) | 73 |
| `src/commands/lsp.rs` | **Critical**: Custom LSP handler using `MthdsEnvironment<NativeEnvironment>` instead of taplo-cli's hard-coded `NativeEnvironment` | 35 |
| `src/commands/config.rs` | Config subcommand delegation | 14 |

**Why `lsp` is handled separately**: `taplo-cli/src/commands/lsp.rs:17` hard-codes `taplo_lsp::create_world(NativeEnvironment::new())`, ignoring the generic `E` type parameter. The pipelex-cli LSP handler fixes this by using `MthdsEnvironment::new(NativeEnvironment::new())`.

#### `crates/pipelex-lsp/` - Extended LSP Server
Message-level wrapper over `taplo-lsp`. Provides the `PipelexLsp<E>` struct and convenience constructors.

| File | Purpose | Lines |
|---|---|---|
| `Cargo.toml` | Crate manifest | 29 |
| `src/lib.rs` | `PipelexLsp<E>` struct, `create_server()`, `create_world()` | 67 |

**Extension point**: The `handle_message` method currently delegates directly to taplo-lsp. Future MTHDS-specific LSP features (diagnostics, completions, code actions for `.mthds` files) would be added here by intercepting specific method names before delegation.

#### `crates/pipelex-wasm/` - WASM Bindings
WASM exports for browser and Node.js environments. Contains a mechanical copy of `taplo-wasm` internals (which are `pub(crate)` and cannot be depended upon).

| File | Purpose | Lines |
|---|---|---|
| `Cargo.toml` | Crate manifest with `cli` and `lsp` features | 46 |
| `src/lib.rs` | WASM-exported functions: `initialize`, `format`, `lint`, `to_json`, `from_json`, `run_cli`, `create_lsp` | 231 |
| `src/environment.rs` | `WasmEnvironment`, `JsAsyncRead`, `JsAsyncWrite` (copied from `taplo-wasm`) | 359 |
| `src/lsp.rs` | `PipelexWasmLsp`, `WasmLspInterface` (adapted from `taplo-wasm`) | 98 |

**Copied from `taplo-wasm`**: `environment.rs` is a byte-identical copy. `lsp.rs` differs only in type parameter (`MthdsEnvironment<WasmEnvironment>` vs `WasmEnvironment`) and struct name (`PipelexWasmLsp` vs `TaploWasmLsp`).

### Modified TypeScript/JavaScript Files

#### `js/lsp/src/index.ts` - WASM LSP Package
| Change | Before | After |
|---|---|---|
| Import source | `taplo-wasm/Cargo.toml` | `pipelex-wasm/Cargo.toml` |
| Class name | `TaploLsp` | `PipelexLsp` |
| Internal field | `taplo` | `pipelex` |

#### `js/lsp/dist/index.d.ts` - Type Declaration
| Change | Before | After |
|---|---|---|
| Class export | `TaploLsp` | `PipelexLsp` |

#### `editors/vscode/src/server.ts` - Node Server Entry
| Change | Before | After |
|---|---|---|
| Import | `TaploLsp` | `PipelexLsp` |
| Variable name | `taplo` | `pipelex` |
| Config file search | `[".taplo.toml", "taplo.toml"]` | `[".pipelex.toml", "pipelex.toml", ".taplo.toml", "taplo.toml"]` |

#### `editors/vscode/src/server-worker.ts` - Browser Worker Entry
| Change | Before | After |
|---|---|---|
| Import | `TaploLsp` | `PipelexLsp` |
| Variable name | `taplo` | `pipelex` |

#### `editors/vscode/src/client.ts` - VS Code Client
| Change | Before | After |
|---|---|---|
| Binary search | `which.sync("taplo", ...)` | `which.sync("plxt", ...) ?? which.sync("taplo", ...)` |

#### `editors/vscode/package.json` - Extension Manifest
| Change | Before | After |
|---|---|---|
| `@pipelex/lsp` dependency | `"^0.1.34"` (npm registry) | `"portal:../../js/lsp"` (local workspace) |

### Rebuilt Artifacts

| File | Description |
|---|---|
| `js/lsp/dist/index.js` | Full WASM bundle compiled from `pipelex-wasm`, exports `PipelexLsp` |

---

## Architecture Diagram

```
                    +-----------------+
                    |  VS Code Ext    |
                    |  (TypeScript)   |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
     +--------v--------+          +--------v--------+
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

---

## Known Limitations

1. **Server info branding**: The LSP `InitializeResult` still reports `server_info.name = "Taplo"` (hard-coded in `taplo-lsp` handler). Low priority; could be intercepted in `PipelexLsp::handle_message` in the future.

2. **`toml-test` subcommand**: Intentionally excluded from `plxt`. This is a taplo-internal testing tool for the [toml-test](https://github.com/BurntSushi/toml-test) suite, not relevant to Pipelex users.

3. **WASM environment code duplication**: ~450 lines of `taplo-wasm` internals are mechanically copied into `pipelex-wasm` because the upstream types are `pub(crate)`. The WASM environment interface is stable, so maintenance burden is low.

4. **`plxt config default`**: Prints the same default `.taplo.toml` content as `taplo config default` (delegated to `taplo_cli::execute_config`). The content could be rebranded to reference `.pipelex.toml` in the future.

---

## Upstream Merge Safety

All 4 new crates (`pipelex-common`, `pipelex-cli`, `pipelex-lsp`, `pipelex-wasm`) are **additive** — they live in new directories under `crates/` and do not modify any existing taplo source file. The only files modified are in the extension layer (`editors/vscode/`, `js/lsp/`), which are already Pipelex-specific.

If upstream taplo adds new methods to the `Environment` trait, `MthdsEnvironment` will fail to compile — this is caught immediately and trivially fixed by adding the new delegation.
