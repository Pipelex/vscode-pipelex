# Version Map

## Version File Locations

| Component | File | Field | Published to |
|---|---|---|---|
| VS Code extension | `editors/vscode/package.json` | `.version` (JSON) | VS Code Marketplace, Open VSX |
| plxt CLI | `crates/pipelex-cli/Cargo.toml` | `[package] version` | PyPI as `pipelex-tools` (via maturin dynamic version) |
| pipelex-tools-py (library) | `crates/pipelex-py/Cargo.toml` | `[package] version` | PyPI as `pipelex-tools-py` (via maturin dynamic version) |
| pipelex-common | `crates/pipelex-common/Cargo.toml` | `[package] version` | Internal only |
| pipelex-lsp | `crates/pipelex-lsp/Cargo.toml` | `[package] version` | Internal only |
| pipelex-wasm | `crates/pipelex-wasm/Cargo.toml` | `[package] version` | Internal only (`publish = false`) |
| @pipelex/lsp JS | `js/lsp/package.json` | `.version` (JSON) | Bundled into extension |

## Dependency Cascade

When bumping `pipelex-common`, also update the version in these dependency lines:
- `crates/pipelex-cli/Cargo.toml`: `pipelex-common = { version = "X.Y.Z", path = "..." }`
- `crates/pipelex-lsp/Cargo.toml`: `pipelex-common = { version = "X.Y.Z", path = "..." }`

`pipelex-wasm` uses path-only references (no version pin) — no update needed.

After any `Cargo.toml` version change, run `cargo update --workspace` to refresh `Cargo.lock`.

## PyPI

Two **independent** PyPI packages, each with its own maturin project and `dynamic = ["version"]` — so you only ever edit a `Cargo.toml` version, never a `pyproject.toml`:

- **`pipelex-tools` (the `plxt` CLI):** root `pyproject.toml` → `[tool.maturin] manifest-path = "crates/pipelex-cli/Cargo.toml"`. The CLI Cargo.toml version is the published version.
- **`pipelex-tools-py` (the importable `pipelex_tools` library):** `crates/pipelex-py/pyproject.toml` → `[tool.maturin] manifest-path = "Cargo.toml"` (the library crate). The `crates/pipelex-py/Cargo.toml` version is the published version. Versioned and released independently of the CLI.

Each package's OIDC trusted publisher is registered **per PyPI project name** (out-of-repo, on PyPI). A newly named project (e.g. `pipelex-tools-py`'s first release) needs its trusted publisher registered on PyPI before the first tag push, or `pypi_publish_pipelex_lib` fails with `invalid-publisher` despite green CI.

## Changelog Conventions

- File: `CHANGELOG.md` at repo root
- Format: [Keep a Changelog](https://keepachangelog.com)
- `[Unreleased]` section may exist at the top when there are unreleased entries; at release time, rename it to the version heading (e.g., `## [X.Y.Z] - YYYY-MM-DD`). If no `[Unreleased]` section exists, create a new version heading at the top of the changelog (after the title). Do NOT re-add an empty `[Unreleased]` section after releasing
- Version headers: `## [X.Y.Z] - YYYY-MM-DD`
- The header version is the **extension version** (primary artifact)
- If releasing CLI only (no extension changes), use CLI version as header
- Subsections: `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security`
- CLI-specific entries get trailing `(plxt X.Y.Z)` annotation with the new CLI version
- Library-specific entries get trailing `(pipelex-tools-py X.Y.Z)` annotation with the new library version
- Unreleased CLI/library entries may use `(plxt >=X.Y.Z)` / `(pipelex-tools-py >=X.Y.Z)` as a placeholder — replace with actual version at release time
- Entries affecting both or extension-only: no annotation

## Tags

- Extension: `pipelex-vscode-ext/vX.Y.Z`
- CLI: `plxt-cli/vX.Y.Z`
- Library: `pipelex-tools-py/vX.Y.Z`
- Tags are created **automatically by CI** (`auto_tag` job in `.github/workflows/ci.yaml`) when versions are pushed to `main`. The `/release` skill does NOT create tags.

## Release Flow

1. `/release` bumps versions + updates changelog
2. Developer commits and pushes to `main` (or merges PR)
3. CI `auto_tag` detects version changes, creates + pushes tags
4. Tags trigger `releases.yaml`: extension to Marketplace/Open VSX, CLI to PyPI (`pipelex-tools`), library to PyPI (`pipelex-tools-py`)
