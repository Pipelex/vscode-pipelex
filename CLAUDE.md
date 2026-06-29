# CLAUDE.md

## Project Overview
Fork of [tamasfe/taplo](https://github.com/tamasfe/taplo) (TOML toolkit) extended with MTHDS (the language for AI methods) support.
Polyglot monorepo: Rust workspace + TypeScript VS Code extension + JS npm packages + VitePress docs site.
Publishes two PyPI packages from separate `pyproject.toml` files:
- `pipelex-tools`: native `plxt` CLI, published from the repo-root `pyproject.toml`
- `pipelex-tools-py`: importable Python library (`import pipelex_tools`), published from `crates/pipelex-py/pyproject.toml`

## Critical Rule: Preserve Upstream Taplo Behavior
**By default, unless expressly and clearly stated otherwise, all existing taplo upstream features and behavior must be kept as-is.** Do not modify, remove, or alter any taplo functionality. Our work is exclusively focused on **adding** new features for MTHDS files and the Pipelex VS Code extension. When making changes, ensure they do not regress or interfere with existing TOML support.

**Exception — bug fixes in common code:** If fixing a bug requires modifying shared/upstream taplo code (e.g. crates outside of MTHDS-specific paths), you must explicitly notify the developer before making the change, explaining what the bug is, which common code is affected, and why the fix is necessary.

## Repository Structure

### Upstream Taplo crates
- `crates/taplo/` - Core Rust library (parser, formatter, DOM)
- `crates/taplo-cli/` - Upstream CLI tool (binary: `taplo`)
- `crates/taplo-lsp/` - Language server (IDE-agnostic)
- `crates/taplo-common/` - Shared utilities (schemas, config)
- `crates/taplo-wasm/` - WASM bindings (target: wasm32-unknown-unknown)
- `crates/lsp-async-stub/` - Async LSP framework

### Pipelex-specific crates
- `crates/pipelex-cli/` - **Our CLI** (binary: `plxt`). Thin wrapper around `taplo-cli` that adds Pipelex config discovery (`.pipelex/plxt.toml` or `plxt.toml` first, then `.taplo.toml` fallback) and wraps LSP with `MthdsEnvironment`. Delegates all standard commands (format, lint, get) to taplo-cli unchanged.
- `crates/pipelex-common/` - Pipelex shared utilities (includes `MthdsEnvironment` for config discovery)

### VS Code extension & other
- `editors/vscode/` - VS Code extension (TypeScript)
- `editors/vscode/src/pipelex/` - MTHDS-specific extension code
- `editors/vscode/src/syntax/mthds/` - MTHDS grammar generator (generates mthds.tmLanguage.json)
- `js/` - npm packages (@taplo/core, @taplo/cli, @taplo/lib, @taplo/lsp)
- `site/` - Documentation site (VitePress + Tailwind)
- `test-data/` - Test fixtures for TOML/MTHDS parsing
- `test-data/mthds/` - MTHDS grammar test fixtures

## Makefile Targets
- `make ext` - **Full extension rebuild**: compiles Rust → WASM → JS bundle (`ext-deps`), then builds the VS Code extension. Run this after any Rust LSP change to test in the Extension Host.
- `make cli` - Build the `plxt` CLI binary (release mode)
- `make vsix` - Package the extension into a `.vsix` file (runs `ext` first)
- `make ext-install` - Build, package, and install the `.vsix` into Cursor or VS Code
- `make ext-uninstall` - Uninstall the extension from the IDE
- `make test` - Run all fast tests (every Rust crate that has tests + VS Code extension vitest) and type-check the extension (`yarn typecheck`). It aggregates the per-package `test-*` targets below.
- `make test-<package>` - Run one package's tests in isolation. One target per package that has a test suite: `test-taplo`, `test-taplo-common`, `test-taplo-lsp`, `test-lsp-async-stub`, `test-pipelex-common`, `test-pipelex-cli`, `test-pipelex-py` (Rust side), `test-ext` (extension tsc + vitest), and `test-pipelex-lib` (builds the Python wheel via maturin, then runs the `pipelex_tools` smoke test).
- `make test-all` - `make test` **plus** `test-pipelex-lib`. The Python smoke test is kept out of plain `make test` because it needs `uv` + a `maturin` release build; `test-all` is the run-absolutely-everything target. (`make pipelex-lib-smoke` remains as an alias for `test-pipelex-lib`.)
- `make check` - **Full quality gate**: fmt check, plxt fmt check, clippy (`-D warnings`), all crate tests (via `make test`), vitest, extension `tsc` type-check, and WASM check. Always run after code changes.
- `make clean` - Remove all build artifacts (cargo, JS dist, VSIX)
- `make sync-grammar` - Copy MTHDS TextMate grammar to the website repo

## Other Build Commands
- `cargo test -p taplo` - Run core Rust tests
- `cargo test` - Run all Rust tests
- `cargo check -p taplo-wasm --target wasm32-unknown-unknown` - Check WASM compilation
- `taplo fmt --check --diff` - Check TOML formatting (project dogfoods taplo)
- `cargo run -- fmt --check` - Check formatting via built binary
- `cd editors/vscode && yarn test` - Run semantic token provider tests (vitest)

## Key Technical Details
- **Rust MSRV**: 1.74 (CI tests against this)
- **VS Code engine**: ^1.90.0
- **Package manager**: Yarn 4 (via corepack)
- **Main branch**: `main`
- **Rust formatter**: rustfmt (config in `rustfmt.toml`)
- **Clippy**: runs with `-D warnings` in `make check`. Notably, `#[cfg(test)] mod tests` must be the **last item** in any Rust file (`items_after_test_module` lint).
- **TOML formatter**: taplo (config in `taplo.toml`)
- **No ESLint/Prettier** for TypeScript code in editors/vscode
- **GitHub organization**: Pipelex (repo: `Pipelex/vscode-pipelex`)
- **Upstream remote**: `tamasfe/taplo` (read-only, for syncing upstream changes only)
- **`gh` CLI**: Always target our repo explicitly (`--repo Pipelex/vscode-pipelex` or equivalent) — do not rely on implicit repo detection, which may resolve to upstream

## MTHDS Language
- MTHDS files use `.mthds` extension
- **Concept reference syntax:** Concept names in string values (e.g. `output = "..."`, `refines = "..."`, input values) can have an optional domain prefix (`domain.ConceptName`) and/or multiplicity suffix (`ConceptName[]` for indefinite, `ConceptName[5]` for specific count). When resolving references, strip both to get the bare concept name for DOM lookup.
- Grammar generated by `editors/vscode/src/syntax/mthds/` (run `yarn build:syntax`)
- **Generated grammar:** `mthds.tmLanguage.json` — produced by the generator, do not hand-edit
- **Static injection wrappers:** `mthds.frontmatter.tmLanguage.json` and `mthds.markdown.tmLanguage.json` — hand-edited files that delegate to `source.mthds` (same pattern as upstream `toml.frontmatter.tmLanguage.json` / `toml.markdown.tmLanguage.json`)
- Semantic tokens: mthdsConcept, mthdsPipeType, mthdsDataVariable, mthdsPipeName, mthdsPipeSection, mthdsConceptSection, mthdsModelRef
- MTHDS extension code lives in `editors/vscode/src/pipelex/`

## LSP Handler Architecture (crates/taplo-lsp)
- **Reference resolution:** `handlers/mthds_resolution.rs` is the shared module for resolving pipe/concept references from cursor position. Used by both `goto_definition.rs` and `hover.rs`. Contains `resolve_reference()`, `ReferenceKind`, `ResolvedReference`, and helpers.
- **Handler tests:** `handlers/tests/` — tests call resolution functions directly (not full LSP roundtrips). Shared helpers (`parse_and_query`, `offset_inside_string`, `offset_inside_string_after`) live in `tests/mod.rs`. Test fixtures live in `test-data/mthds/<feature>/`.
- **MTHDS hover:** For `.mthds` files, hover on reference fields shows rich content (type, description, inputs, output for pipes; description, refines, fields for concepts). Falls through to schema-based hover for non-reference strings.

## Graph Rendering (ReactFlow)

The extension includes a webview panel that renders method/pipe graphs using ReactFlow. The extension receives a **GraphSpec** (JSON with nodes and edges) from `pipelex-agent validate --view` and renders the graph itself using ReactFlow in the webview. This gives full control over layout, styling, and interactivity.

### Extension-side code
- `editors/vscode/src/pipelex/graph/methodGraphPanel.ts` — webview panel manager (extension host); builds the `setData` config payload
- `editors/vscode/src/pipelex/graph/graphConfig.ts` — resolves render config (edge type, layout, theme) from `~/.pipelex/pipelex.toml` + VS Code settings
- `editors/vscode/src/pipelex/graph/webview/adapter.ts` — webview entry; mounts `@pipelex/mthds-ui`'s `GraphViewer` (the actual ReactFlow renderer) and bridges VS Code messages. Bundled to `graph.js`.
- `editors/vscode/src/pipelex/graph/webview/graph.html` — webview HTML template
- `editors/vscode/src/pipelex/graph/webview/graph.css` — host-side webview chrome / VS Code theme detection (the graph's node/edge colors come from the renderer, not here)

### Theming (light/dark)
The `GraphViewer` from `@pipelex/mthds-ui` **owns the palette**: it applies the full light or dark token set (`getPaletteForTheme(theme)`) as inline styles on its full-bleed `.react-flow-container`, and the in-graph toolbar's theme button toggles it. The host therefore drives the theme through GraphViewer's theme props and **must never send `config.paletteColors`**: GraphViewer merges that *over* the theme palette (`{ ...themePalette, ...overrides }`), which pins node/edge colors to one theme and silently breaks the light/dark toggle.

`config.theme` is the theme *mode* (`'system' | 'dark' | 'light'`), not a resolved color. It defaults to `'system'` (follow the active VS Code color theme); `pipelex.graph.theme` (`auto`/`dark`/`light`) pins it. Because the webview's own `prefers-color-scheme` is unreliable, the host also injects the resolved binary theme via GraphViewer's `systemTheme` prop (carried on the `setData` `config` and extracted in `adapter.ts`). When the user switches VS Code between a light and dark theme, `methodGraphPanel.onColorThemeChanged` (wired to `vscode.window.onDidChangeActiveColorTheme`) posts a lightweight `{ type: 'setSystemTheme', systemTheme }` message; the adapter re-renders with the new `systemTheme` prop so a `'system'`-mode graph repaints live without re-running analysis or resetting the viewport. A manual in-graph theme pin survives the switch because GraphViewer ignores `systemTheme` unless its mode is `'system'`.

**Persisting the in-graph toggle.** The in-graph theme button is itself a control over `pipelex.graph.theme` — there is one source of truth, not a second hidden store. GraphViewer reports every mode change through its `onThemeChange(mode, resolvedTheme)` callback; `adapter.ts` forwards only a genuine *mode* change (deduped against the host-seeded `config.theme`, so an environment-driven `'system'` re-resolve is not mistaken for a user pick) as a `{ type: 'themeModeChanged', mode }` message. `methodGraphPanel.persistThemeMode` maps the renderer mode onto the setting enum (`'system'`→`auto`, else verbatim) and writes it via `config.update`. **The writer must mirror the reader's scope.** `resolveGraphConfig` reads `pipelex.graph.theme` through `getConfiguration('pipelex')` with **no resource**, so its `workspaceFolderValue` term is dead — it effectively reads `workspaceValue ?? globalValue`. `persistThemeMode` therefore also uses the unscoped accessor and targets `Workspace` (when a workspace value already exists, so the toggle "sticks") or otherwise `Global` — **never `WorkspaceFolder`**, which the unscoped reader cannot see, so a folder-scoped write would persist but never be read back. The no-op guard compares against the *effective* value **including the contributed `auto` default** (`workspaceValue ?? globalValue ?? defaultValue`): toggling to `'system'` while nothing is explicitly set is a no-op, so it does not pin an explicit `auto` that would clobber a `pipelex.toml` `style.theme`. A *non-default* toggle (dark/light, or system over an existing explicit value) does write an explicit `pipelex.graph.theme`, which then overrides any toml `style.theme` — intended, since it's a deliberate user action. There is **no** config-change listener for the graph, so persisting never re-renders or resets the live viewport; the value is picked up by `resolveGraphConfig` on the next open / restart.

### Toolbar position

The GraphViewer's built-in floating toolbar (direction toggle, fold/expand, zoom, theme) is anchored via the `pipelex.graph.toolbarPosition` setting (eight anchors: `top-left` … `center-right`, default `top-right`). Unlike `theme`, there is **no** `pipelex.toml` source — pipelex's `reactflow_config` has no toolbar key — so the VS Code setting is the only source. `resolveGraphConfig` reads it (guarded by `isToolbarPosition`, falling back to `top-right` on a malformed value) into `GraphRenderConfig.toolbarPosition`; `methodGraphPanel.sendGraphspecToWebview` forwards it on the `setData` `config` payload, and GraphViewer reads `config.toolbarPosition` reactively on every render. There is no live config-change listener (same as `edgeType`/`direction`/`foldMode`), so a changed setting takes effect on the next graph open/refresh. The toolbar has no in-graph "move me" control, so nothing is persisted back (contrast the theme toggle above).

### Key cross-repo dependency
When modifying graph rendering, always consult `../pipelex/pipelex/graph/graphspec.py` to understand the GraphSpec data model (node types, edge types, metadata) that the extension must consume. Changes to graphspec.py in pipelex directly affect the JSON the extension receives.

## Don't Edit
- `Cargo.lock` - Auto-generated by cargo
- `mthds.tmLanguage.json` / `toml.tmLanguage.json` - Generated TextMate grammars (edit source generators instead). Note: the `*.frontmatter.tmLanguage.json` and `*.markdown.tmLanguage.json` files are static wrappers and may be edited directly.
- `node_modules/` and `target/` - Build artifacts

## CI/CD
- **Branching:** feature branches PR into `dev`; `dev` (via `release/*`) feeds `main`. Both `dev` and `main` are protected.
  - **PR base by branch type:** a `release/*` branch targets **`main`** (that merge is what triggers auto-tagging + publishing). Every other branch targets **`dev`**. Don't open a release PR into `dev` — it lands the version bump without publishing.
- **PR quality gate (required, Makefile-driven so CI = local gate):**
  - `check.yml` → runs `make check` (fmt + clippy + crate/extension tests + locked compile checks, incl. both WASM crates)
  - `test-all.yml` → runs `make test-all` (every fast suite + the Python library smoke test)
  - Both trigger on PRs into `main`+`dev` and are **required status checks** on both branches (branch protection: PR required, force-push/delete blocked, conversation resolution required, `enforce_admins` off). The workflows' `branches:` filter must track the protected-branch set. See `docs/dev/ci-and-branch-protection.md`.
- `ci.yaml` — what the make gates don't cover: release auto-tagging (push to `main`), the e2e `pipelex-tools-py` wheel build/install, `toml-test` conformance, and MSRV (1.74) builds. Triggers on push/PR to `main` **only** (gates the `dev`→`main` boundary, not every feature PR). Not required checks.
- Releases: `releases.yaml` — PyPI, VS Code Marketplace, Open VSX
- Auto-tagging via inline shell in `ci.yaml`
- **Enterprise allowlist:** Pipelex Enterprise restricts third-party actions. Only 4 are allowed (`Swatinem/rust-cache`, `PyO3/maturin-action`, `pypa/gh-action-pypi-publish`, `peaceiris/actions-gh-pages`) — all SHA-pinned in workflows. See `docs/dev/release-publishing.md` for details and allowlist management.
- **When adding a new third-party action:** either replace with inline shell, or add its `owner/repo@*` pattern to the enterprise allowlist at `github.com/enterprises/Pipelex/settings/actions/policies` and SHA-pin in the workflow.
