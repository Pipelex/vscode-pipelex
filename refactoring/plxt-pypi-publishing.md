# Publishing `plxt` to PyPI

## Architecture: `pipelex-cli` is Our CLI

`crates/pipelex-cli/` is a **thin wrapper around `taplo-cli`** — not a fork or copy. It:

| Aspect | taplo-cli | pipelex-cli |
|--------|-----------|-------------|
| Binary name | `taplo` | `plxt` |
| Config files searched | `.taplo.toml`, `taplo.toml` | `.pipelex/toml_config.toml` (priority), then `.taplo.toml` fallback |
| Env var for config | `TAPLO_CONFIG` | `PIPELEX_CONFIG` |
| LSP environment | `NativeEnvironment` | `MthdsEnvironment` wrapping `NativeEnvironment` |
| `toml-test` feature | Yes (default) | No |

Internally, `PlxtCli<E>` wraps `taplo_cli::Taplo<E>` and delegates all standard commands (format, lint, get, completions) unchanged. Only config discovery and LSP setup are customized.

This is the crate to publish as `plxt` on PyPI.

## How Taplo Currently Does PyPI

Taplo uses **Maturin** (a Rust-to-Python packaging tool) with `bindings = "bin"` — this wraps the compiled Rust CLI binary into a Python wheel. Users install with `pip install taplo` and get the binary on their PATH.

Key files:
- `pyproject.toml` — defines the Python package metadata + maturin config (currently points to `taplo-cli`)
- `.github/workflows/releases.yaml` — builds wheels for all platforms and publishes via OIDC

## Steps to Publish `plxt`

### 1. Update `pyproject.toml`

Change the current root `pyproject.toml` from taplo to plxt:

```toml
[build-system]
requires      = ["maturin>=1.4"]
build-backend = "maturin"

[project]
name            = "plxt"
description     = "A CLI for the Pipelex MTHDS toolkit"
authors         = [{ name = "PipelexLab" }]
requires-python = ">=3.8"
dynamic         = ["version"]

[tool.maturin]
bindings      = "bin"
manifest-path = "crates/pipelex-cli/Cargo.toml"
```

### 2. Set up PyPI authentication

Two options:
- **OIDC Trusted Publisher (recommended for CI)** — Go to pypi.org > account > Publishing > add a "pending publisher" for your GitHub repo/workflow. No secrets needed.
- **API Token** — Generate a token on pypi.org, store as GitHub Actions secret (`PYPI_API_TOKEN`).

### 3. Test locally

```bash
pip install maturin
maturin develop --manifest-path crates/pipelex-cli/Cargo.toml
plxt --help  # verify it works
maturin build --manifest-path crates/pipelex-cli/Cargo.toml
```

### 4. Publish manually (first release)

```bash
maturin publish --manifest-path crates/pipelex-cli/Cargo.toml
```

This prompts for PyPI credentials and uploads the wheel for the current platform only.

### 5. Create/adapt CI workflow

The existing `releases.yaml` has three PyPI jobs for taplo:
- `pypi_build_taplo_cli` — builds wheels for Linux/macOS/Windows (multiple architectures)
- `pypi_test_taplo_cli` — smoke tests with `taplo help`
- `pypi_publish_taplo_cli` — publishes to PyPI via OIDC

Create equivalent jobs for `plxt`:
- Rename jobs (e.g., `pypi_build_plxt`, `pypi_test_plxt`, `pypi_publish_plxt`)
- Change tag triggers (e.g., `release-plxt-*` instead of `release-taplo-cli-*`)
- Point maturin build to `crates/pipelex-cli/Cargo.toml`
- Change smoke test to `plxt help`

### 6. Platforms to build for

Following taplo's matrix:
- **Linux**: x86, x64, aarch64, armv7
- **macOS**: x86_64, aarch64 (Apple Silicon)
- **Windows**: x86, x64 (no aarch64)
