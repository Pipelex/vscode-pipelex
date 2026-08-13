# Version Map

## Version File Locations

| Component | File | Field | Published to |
|---|---|---|---|
| VS Code extension | `editors/vscode/package.json` | `.version` (JSON) | VS Code Marketplace, Open VSX |
| plxt CLI | `crates/pipelex-cli/Cargo.toml` | `[package] version` | PyPI as `pipelex-tools` (via maturin dynamic version) |
| pipelex-tools-py (library) | `crates/pipelex-py/Cargo.toml` | `[package] version` | PyPI as `pipelex-tools-py` (via maturin dynamic version) |
| @pipelex/tools-wasm | `js/tools-wasm/package.json` | `.version` (JSON) | npm as `@pipelex/tools-wasm` |
| pipelex-common | `crates/pipelex-common/Cargo.toml` | `[package] version` | Internal only |
| pipelex-lsp | `crates/pipelex-lsp/Cargo.toml` | `[package] version` | Internal only |
| pipelex-wasm | `crates/pipelex-wasm/Cargo.toml` | `[package] version` | Internal only (`publish = false`) |
| pipelex-tools-wasm | `crates/pipelex-tools-wasm/Cargo.toml` | `[package] version` | Internal only (`publish = false`) — **never bump; see below** |
| @pipelex/lsp JS | `js/lsp/package.json` | `.version` (JSON) | Bundled into extension |

## The two WASM crates have inert versions

`crates/pipelex-wasm` and `crates/pipelex-tools-wasm` are both `publish = false`. They are compiled *into* a JS bundle, and it is the npm package that carries the published version:

| Crate (inert version) | npm package (real version) |
|---|---|
| `crates/pipelex-wasm` | `js/lsp` → `@pipelex/lsp` |
| `crates/pipelex-tools-wasm` | `js/tools-wasm` → `@pipelex/tools-wasm` |

Bump only the `package.json`. Bumping the crate creates a second apparent source of truth that nothing reads, and the next person to look will not know which one shipped. (Both crates have sat at `0.1.0` while their npm packages moved — that is intended, not drift.)

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

## npm

One npm package is published from this repo: **`@pipelex/tools-wasm`** (`js/tools-wasm`), on the `pipelex-tools-wasm/v*` tag, by the `npm_publish_tools_wasm` job in `releases.yaml`.

The job builds with `RELEASE=true` explicitly rather than relying on the package's `prepublish` script — npm 7+ **does not run `prepublish` on `npm publish`** (it was deprecated in favour of `prepare`/`prepublishOnly`), so a publish that trusted it would ship whatever stale `dist/` happened to be lying around, or a debug-profile WASM build.

Authentication is **OIDC trusted publishing** (`permissions: id-token: write` + `npm publish --provenance`) — no `NPM_TOKEN` secret, matching PyPI here and the `mthds-ui` / `mthds-js` / `pipelex-sdk-js` repos. The trusted publisher is registered per package on npmjs.com and names the workflow file, so **renaming `releases.yaml` breaks publishing**. See `docs/dev/release-publishing.md`.

`publish-tools-wasm.sh` at the repo root is the manual escape hatch for when CI cannot run. It defaults to `none` (publish the committed version without bumping) precisely so it cannot become a competing source of truth: **the version bump belongs to this skill, the publish belongs to CI.**

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
- tools-wasm-specific entries get trailing `(@pipelex/tools-wasm X.Y.Z)` annotation with the new npm version
- An entry shipping in several artifacts lists them all: `(plxt 0.8.0, pipelex-tools-py 0.2.0, @pipelex/tools-wasm 0.2.0)`
- Unreleased entries may use `(plxt >=X.Y.Z)` / `(pipelex-tools-py >=X.Y.Z)` / `(@pipelex/tools-wasm >=X.Y.Z)` as a placeholder — replace with actual version at release time
- Entries affecting both or extension-only: no annotation

## Tags

- Extension: `pipelex-vscode-ext/vX.Y.Z`
- CLI: `plxt-cli/vX.Y.Z`
- Library: `pipelex-tools-py/vX.Y.Z`
- npm WASM package: `pipelex-tools-wasm/vX.Y.Z`
- Tags are created **automatically by CI** (`auto_tag` job in `.github/workflows/ci.yaml`) when versions are pushed to `main`. The `/release` skill does NOT create tags.

## Release Flow

1. `/release` bumps versions + updates changelog
2. Developer commits and pushes to `main` (or merges PR)
3. CI `auto_tag` detects version changes, creates + pushes tags
4. Tags trigger `releases.yaml`: extension to Marketplace/Open VSX, CLI to PyPI (`pipelex-tools`), library to PyPI (`pipelex-tools-py`), WASM bindings to npm (`@pipelex/tools-wasm`)
