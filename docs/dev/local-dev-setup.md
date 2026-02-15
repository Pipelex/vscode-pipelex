# Local Development Setup

How to build and install the Pipelex extension and CLI from source for local testing.

## Prerequisites

- Rust toolchain (1.74+) with `wasm32-unknown-unknown` target
- Node.js 20+
- Yarn 4 (via corepack: `corepack enable`)
- `vsce` (`npm install -g @vscode/vsce`)
- A VS Code-compatible IDE (VS Code, Cursor, Windsurf, etc.)

Install the WASM target if you haven't already:

```bash
rustup target add wasm32-unknown-unknown
```

## Quick Start

```bash
# Build and install everything in one command:
make ext-install
```

This builds the WASM LSP bundle, the VS Code extension, packages it into a `.vsix`, and installs it into the first IDE it finds (`cursor` or `code` CLI).

## Makefile Targets

Run `make help` to see all targets. Here are the key ones:

| Target | Description |
|---|---|
| `make cli` | Build the `plxt` CLI binary (release mode) |
| `make ext` | Build the VS Code extension (includes WASM bundle) |
| `make vsix` | Package the extension into `editors/vscode/pipelex.vsix` |
| `make ext-install` | Build, package, and install the `.vsix` into your IDE |
| `make ext-uninstall` | Remove the extension from your IDE |
| `make test` | Run all tests (Rust + extension) |
| `make check` | Quick compilation checks (CLI + WASM) |
| `make clean` | Remove all build artifacts |

## Step-by-Step Guide

### 1. Build and install the extension

```bash
make ext-install
```

If no CLI is detected automatically, install the `.vsix` manually:

1. Run `make vsix`
2. In your IDE: **Extensions** sidebar > `...` menu > **Install from VSIX...**
3. Select `editors/vscode/pipelex.vsix`
4. Reload the window

### 2. Build the CLI (optional)

The extension ships with a bundled WASM-based language server, so the CLI is not required. However, you can build and use the native `plxt` binary for better performance or for command-line usage:

```bash
make cli
```

The binary is at `target/release/plxt`. To use it with the extension instead of the bundled WASM server:

1. Add `target/release/` to your `PATH`, or copy the binary somewhere in your `PATH`
2. In your IDE settings, set `pipelex.server.bundled` to `false`
3. The extension will find `plxt` in your `PATH` and run `plxt lsp stdio`

### 3. Verify it works

Open a `.toml` or `.mthds` file. You should see:

- Syntax highlighting for TOML and MTHDS files
- Semantic tokens (pipe types, concept names, data variables in MTHDS)
- TOML formatting (right-click > Format Document)
- TOML validation diagnostics

### Iterating on changes

After modifying Rust or TypeScript source, rebuild and reinstall:

```bash
make ext-install
```

Then reload your IDE window (**Developer: Reload Window** from the command palette, or `Cmd+Shift+P` > "Reload Window").

### Using the Extension Development Host

For faster iteration without packaging a `.vsix` each time, use the VS Code Extension Development Host:

1. Open the repo in your IDE
2. Press `F5` (or **Run > Start Debugging**)
3. Select **Extension Development Host** if prompted
4. A new IDE window opens with the extension loaded from source

Changes to TypeScript require `cd editors/vscode && yarn build` then relaunch. Changes to Rust/WASM require rebuilding the LSP bundle first: `cd js/lsp && yarn build`.

## Uninstalling

```bash
make ext-uninstall
```

Or manually: **Extensions** sidebar > find "Pipelex" > **Uninstall**.
