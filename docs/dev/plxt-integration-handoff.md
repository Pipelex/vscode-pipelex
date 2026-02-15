# Handoff: Integrating `plxt` as a linting/formatting tool

## What is `plxt`?

`plxt` is the Pipelex Tools CLI — a Rust binary built from `vscode-pipelex/crates/pipelex-cli/`. It wraps upstream `taplo` (the standard TOML toolkit) and adds Pipelex-specific config discovery (`.pipelex/toml_config.toml`) and MTHDS file support. It handles formatting and linting for both `.toml` and `.mthds` files.

## How to consume it

`pipelex-tools` is distributed as a Python package on PyPI (built via maturin from Rust source). It installs the `plxt` binary. To use it as a dev dependency from the local `vscode-pipelex` repo:

1. Add `"pipelex-tools"` to your dev dependencies in `pyproject.toml`
2. Add a `[tool.uv.sources]` entry pointing to the local repo:
   ```toml
   [tool.uv.sources]
   pipelex-tools = { path = "../vscode-pipelex", editable = false }
   ```
3. Run `uv sync` (or `uv sync --all-extras`) — this invokes maturin to compile the Rust binary and install it into the venv.

After code changes in `vscode-pipelex`, force-reinstall with:
```bash
uv sync --all-extras --reinstall-package pipelex-tools
```

## Key commands

```bash
plxt fmt --check          # Check formatting (exit 1 if unformatted)
plxt fmt                  # Format in place
plxt lint                 # Lint TOML/MTHDS files (aliases: check, validate)
plxt lsp stdio            # Start the language server (stdio transport)
plxt --help               # Full usage
```

## Config discovery

`plxt` looks for configuration in this order:
1. `.pipelex/toml_config.toml` (Pipelex-specific)
2. `.taplo.toml` (upstream fallback)
3. `PIPELEX_CONFIG` env var (override)
