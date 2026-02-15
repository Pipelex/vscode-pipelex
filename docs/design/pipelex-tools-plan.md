# Pipelex Wrapper Crates: Master Plan

## Context

The Pipelex VS Code extension is a fork of [Taplo](https://github.com/tamasfe/taplo). The extension already uses "Pipelex" branding (settings, commands, package name), but the underlying Rust tools still carry the "taplo" identity: the CLI binary is `taplo`, the config file is `.taplo.toml`, and the LSP server self-identifies as "Taplo".

**Goal**: Create wrapper crates that rebrand and extend the taplo tools under Pipelex naming, enabling MTHDS-specific features **without modifying any upstream taplo crate**, keeping merges clean.

## Naming Decisions

| Artifact | Name | Rationale |
|----------|------|-----------|
| CLI binary | **`plxt`** (Pipelex Tools) | `mthds` is taken (workflow runner), `pipelex` is the broader brand |
| Config file | **`.pipelex.toml`** | Matches extension branding; falls back to `.taplo.toml` |
| Rust crate prefix | **`pipelex-`** | `pipelex-common`, `pipelex-cli`, `pipelex-lsp`, `pipelex-wasm` |
| WASM approach | **Copy** taplo-wasm internals | Zero upstream modifications (~450 lines mechanical copy) |

---

## Architecture: The Environment Wrapper Pattern

The entire taplo stack is generic over an `Environment` trait (`crates/taplo-common/src/environment.rs`). Every tool — CLI (`Taplo<E>`), LSP (`World<E>`), WASM bindings — receives its environment as a type parameter. By wrapping `Environment` with a newtype that overrides config-file discovery (and potentially other behaviors), we rebrand the whole stack without touching upstream code.

```
NativeEnvironment                     MthdsEnvironment<NativeEnvironment>
       |                                          |
   find_config_file ->                    find_config_file ->
     .taplo.toml, taplo.toml               .pipelex.toml, pipelex.toml
                                           (then fallback to .taplo.toml)
```

---

## New Crate Structure

```
crates/
  lsp-async-stub/       (untouched)
  taplo/                (untouched)
  taplo-cli/            (untouched)
  taplo-common/         (untouched)
  taplo-lsp/            (untouched)
  taplo-wasm/           (untouched)
  pipelex-common/       NEW - MthdsEnvironment wrapper, config constants
  pipelex-cli/          NEW - "plxt" binary wrapping taplo-cli
  pipelex-lsp/          NEW - Extended LSP server (wraps taplo-lsp)
  pipelex-wasm/         NEW - WASM bindings using pipelex-* crates
```

Dependency graph of new crates:
```
pipelex-common -> taplo-common, taplo
pipelex-cli    -> pipelex-common, taplo-cli, taplo-common
pipelex-lsp    -> pipelex-common, taplo-lsp, taplo-common, lsp-async-stub
pipelex-wasm   -> pipelex-common, pipelex-lsp, taplo, taplo-common
```

The workspace `Cargo.toml` uses `members = ["crates/*"]`, so new crates are auto-discovered.

---

## Phase 1: `pipelex-common` (Foundation)

**Path**: `crates/pipelex-common/`

### 1.1 Config File Constants

```rust
// crates/pipelex-common/src/config.rs
pub const PIPELEX_CONFIG_FILE_NAMES: &[&str] = &[".pipelex.toml", "pipelex.toml"];
```

### 1.2 MthdsEnvironment Wrapper

The core abstraction. Wraps any `Environment` to search for `.pipelex.toml` before `.taplo.toml`.

```rust
// crates/pipelex-common/src/environment.rs
#[derive(Clone)]
pub struct MthdsEnvironment<E: Environment> {
    inner: E,
}

#[async_trait(?Send)]
impl<E: Environment> Environment for MthdsEnvironment<E> {
    // Delegate all ~15 methods to inner, EXCEPT:

    async fn find_config_file(&self, from: &Path) -> Option<PathBuf> {
        // Walk directories upward looking for PIPELEX_CONFIG_FILE_NAMES
        // If found, return it
        // Otherwise, fall back to self.inner.find_config_file(from)
    }
}
```

The `find_config_file` logic is ~20 lines (copied from `NativeEnvironment::find_config_file` in `crates/taplo-common/src/environment/native.rs:110-132` but searching pipelex names first).

**Key files to reference**:
- `crates/taplo-common/src/environment.rs` — the `Environment` trait (17 required methods, 4 provided)
- `crates/taplo-common/src/environment/native.rs:110-132` — reference `find_config_file` impl
- `crates/taplo-common/src/config.rs:19` — `CONFIG_FILE_NAMES`

### 1.3 Re-exports

Re-export `taplo_common` types so downstream pipelex crates can use `pipelex_common` as their single entry point.

---

## Phase 2: `pipelex-cli` (CLI Binary)

**Path**: `crates/pipelex-cli/`
**Binary**: `plxt`

### 2.1 Entry Point

```rust
// crates/pipelex-cli/bin/plxt.rs
#[tokio::main]
async fn main() {
    let cli = PlxtArgs::parse();
    // ... logging setup ...
    let env = MthdsEnvironment::new(NativeEnvironment::new());
    match PlxtCli::new(env).execute(cli).await { ... }
}
```

### 2.2 Rebranded Args

Define `PlxtArgs` — same structure as `TaploArgs` but with `#[clap(name = "plxt")]` and `env = "PIPELEX_CONFIG"` for the config flag.

All inner command structs (`FormatCommand`, `LintCommand`, etc.) from `taplo-cli` are `pub` and can be reused directly.

### 2.3 Command Dispatch

For most commands (`format`, `lint`, `get`), delegate to `Taplo<MthdsEnvironment<NativeEnvironment>>` since these use `self.env` for config discovery.

**Critical exception — the `lsp` subcommand**: `taplo-cli/src/commands/lsp.rs:17` hard-codes `NativeEnvironment::new()` for the LSP world, ignoring the generic `E`. We must handle the `lsp` subcommand ourselves:

```rust
// In pipelex-cli's execute():
PlxtCommand::Lsp { cmd } => {
    // Don't delegate to taplo-cli's execute_lsp
    let server = taplo_lsp::create_server();
    let world = taplo_lsp::create_world(MthdsEnvironment::new(NativeEnvironment::new()));
    world.set_default_config(config);
    // ... listen_tcp or listen_stdio ...
}
```

### 2.4 Config Command Override

`taplo config default` prints a default `.taplo.toml`. Override this to print pipelex-branded output.

**Key files to reference**:
- `crates/taplo-cli/bin/taplo.rs` — reference entry point
- `crates/taplo-cli/src/args.rs` — all args structs (all `pub`)
- `crates/taplo-cli/src/commands/mod.rs` — `execute()` dispatch
- `crates/taplo-cli/src/commands/lsp.rs:17` — the hard-coded `NativeEnvironment` bug

---

## Phase 3: `pipelex-lsp` (Extended LSP)

**Path**: `crates/pipelex-lsp/`

### 3.1 Strategy: Message-Level Wrapping

The taplo-lsp handler functions are `pub(crate)`, so we cannot register them from outside. Instead, we wrap at the message level using `Server::handle_message()` which is public.

```rust
pub struct PipelexLsp<E: Environment> {
    server: Server<World<MthdsEnvironment<E>>>,
    world: World<MthdsEnvironment<E>>,
}

impl<E: Environment> PipelexLsp<E> {
    pub fn new(env: E) -> Self {
        let mthds_env = MthdsEnvironment::new(env);
        Self {
            server: taplo_lsp::create_server(),
            world: taplo_lsp::create_world(mthds_env),
        }
    }

    pub async fn handle_message(&self, message: rpc::Message, writer: impl Sink<rpc::Message>) {
        // Future: intercept specific methods for MTHDS features
        self.server.handle_message(self.world.clone(), message, writer).await
    }
}
```

### 3.2 Server Info Branding (Optional / Future)

The `InitializeResult` includes `server_info.name = "Taplo"` (hard-coded in the handler). To rebrand, we would intercept the initialize response and modify it. This is doable but fragile — we may defer this to later and accept "Taplo" server info initially.

### 3.3 MTHDS Extension Points (Future)

The wrapper opens the door for:
- **MTHDS-specific diagnostics** — validate pipe/concept structure
- **MTHDS completions** — suggest pipe types, concept names
- **MTHDS code actions** — quick fixes for common patterns
- **Custom LSP methods** — MTHDS-specific requests

These would be implemented by intercepting messages in `handle_message` or adding a secondary handler layer.

**Key files to reference**:
- `crates/taplo-lsp/src/lib.rs` — `create_server()`, `create_world()` (both `pub`)
- `crates/taplo-lsp/src/world.rs` — `WorldState<E>` (pub), `World<E>` = `Arc<WorldState<E>>`
- `crates/lsp-async-stub/src/lib.rs` — `Server::handle_message()` (pub)

---

## Phase 4: `pipelex-wasm` (WASM Bindings)

**Path**: `crates/pipelex-wasm/`

### 4.1 Why Not Reuse `taplo-wasm`?

`taplo-wasm`'s internal types (`WasmEnvironment`, `JsAsyncRead`, `JsAsyncWrite`, `WasmLspInterface`) are all `pub(crate)`, so we cannot depend on them. We have two options:

**Option A (recommended)**: Copy ~350 lines of WASM environment code into `pipelex-wasm`. This gives us independence and the ability to evolve the WASM interface.

**Option B**: Make `taplo-wasm` types public. This requires modifying `taplo-wasm` (violates our upstream-untouched constraint).

### 4.2 WASM Exports

```rust
#[wasm_bindgen]
pub fn initialize() { console_error_panic_hook::set_once(); }

#[wasm_bindgen]
pub fn format(env: JsValue, toml: &str, options: JsValue, config: JsValue) -> Result<String, JsError> {
    // Same logic as taplo-wasm's format — uses core taplo parser directly
}

#[wasm_bindgen]
pub fn create_lsp(env: JsValue, lsp_interface: JsValue) -> PipelexWasmLsp {
    let env = MthdsEnvironment::new(WasmEnvironment::from(env));
    let server = taplo_lsp::create_server();
    let world = taplo_lsp::create_world(env);
    PipelexWasmLsp { server, world, lsp_interface: WasmLspInterface::from(lsp_interface) }
}
```

**Key files to reference**:
- `crates/taplo-wasm/src/lib.rs` — current WASM exports to mirror
- `crates/taplo-wasm/src/environment.rs` — `WasmEnvironment` to copy (~350 lines)
- `crates/taplo-wasm/src/lsp.rs` — `TaploWasmLsp`, `WasmLspInterface` to copy (~95 lines)

---

## Phase 5: JS/TS Layer Updates

### 5.1 `@pipelex/lsp` Package (`js/lsp/`)

Change the rollup import from `taplo-wasm` to `pipelex-wasm`:

```typescript
// js/lsp/src/index.ts
import loadPipelex from "../../../crates/pipelex-wasm/Cargo.toml";
```

Rename `TaploLsp` class to `PipelexLsp`.

### 5.2 VS Code Server (`editors/vscode/src/server.ts`)

Update config file search to find pipelex configs first:

```typescript
findConfigFile: from => {
    const fileNames = [".pipelex.toml", "pipelex.toml", ".taplo.toml", "taplo.toml"];
    for (const name of fileNames) {
        try {
            const fullPath = path.join(from, name);
            fs.accessSync(fullPath);
            return fullPath;
        } catch { }
    }
},
```

### 5.3 VS Code Client (`editors/vscode/src/client.ts`)

For non-bundled mode, search for `plxt` binary before `taplo`:

```typescript
const serverPath =
    config.get("pipelex.server.path") ??
    which.sync("plxt", { nothrow: true }) ??
    which.sync("taplo", { nothrow: true });
```

---

## Config File Precedence

With this architecture, `.pipelex.toml` takes priority over `.taplo.toml` in the same directory. If both exist, `.pipelex.toml` wins. The config file format is identical — only the filename changes.

| Path | Native CLI (`plxt fmt`) | WASM/VS Code (bundled LSP) |
|------|--------------------------|---------------------------|
| Config discovery | `MthdsEnvironment::find_config_file` in Rust | JS `findConfigFile` callback in `server.ts` |
| Search order | `.pipelex.toml` > `pipelex.toml` > `.taplo.toml` > `taplo.toml` | Same |
| Walks up dirs | Yes (same as taplo) | No (only checks `from` dir, same as current) |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `taplo-wasm` types are `pub(crate)` | Must copy ~450 lines of WASM glue code | Mechanical copy; low maintenance burden since WASM env interface is stable |
| `execute_lsp` hard-codes `NativeEnvironment` | CLI `plxt lsp` would ignore our wrapper | Handle `lsp` subcommand ourselves in `pipelex-cli` |
| `taplo-lsp` handlers are `pub(crate)` | Cannot compose at builder level | Wrap at message level via `Server::handle_message()` |
| Server info says "Taplo" not "Pipelex" | Minor branding inconsistency | Can intercept initialize response later; low priority |
| Environment trait has ~17 methods | Boilerplate delegation | Consider a macro; methods are simple pass-throughs |
| Upstream taplo adds new Environment methods | Compilation failure in wrapper | Caught immediately at compile time; easy to fix |

---

## Verification Plan

1. **pipelex-common**: `cargo test -p pipelex-common` — unit tests for `MthdsEnvironment::find_config_file` precedence
2. **pipelex-cli**: `cargo build -p pipelex-cli` then `./target/debug/plxt fmt --help` shows "plxt" branding; `plxt fmt --check` finds `.pipelex.toml`
3. **pipelex-lsp**: `cargo test -p pipelex-lsp` — verify server creation and message forwarding
4. **pipelex-wasm**: `cargo check -p pipelex-wasm --target wasm32-unknown-unknown` — WASM compilation check
5. **VS Code extension**: `cd editors/vscode && yarn build && yarn test` — existing tests pass; manual test: open `.mthds` file, verify LSP starts
6. **Config fallback**: Create a project with `.pipelex.toml`, verify `plxt fmt` uses it; remove it, verify fallback to `.taplo.toml`
7. **Upstream merge test**: Verify `git merge` from upstream taplo produces no conflicts in existing crates
