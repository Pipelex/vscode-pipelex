# Pipelex IDE Extension and `plxt` CLI Changelog

## [Unreleased]

### Added
- Selectable analysis backend via `pipelex.backend` (`cli` default — zero-config preserved; `api` opt-in). The `api` backend validates bundles and renders method graphs by calling a Pipelex API server (`pipelex.api.baseUrl`, default the hosted `https://api.pipelex.com`; point it at e.g. `http://localhost:8081` for a self-hosted runner) over HTTP via the `mthds` client, with full structured-diagnostics parity. See [Validation backends](docs/features/validation-backends.md).
- Commands `Pipelex: Set Hosted API Key` / `Pipelex: Clear Hosted API Key` store a hosted Pipelex API key in VS Code SecretStorage (never in plaintext settings); the `api` backend resolves the token as SecretStorage → `MTHDS_API_KEY` env.
- Cross-file diagnostics: a bundle-validation error is now placed on its declaring file (resolved from the error's `source`), not only on the saved file, for directory-wide bundles on both backends.
- One-time confirmation before the `api` backend sends bundle contents to a non-localhost host (the whole directory's `.mthds` contents are sent on each save).
- The method graph view now shows a **Retry** button on its error states (CLI not found / too old, API unreachable, API error, API key required, send declined, unexpected error) that re-runs the analysis for the open file, so a transient failure recovers without reopening the panel.
- A Pipelex API auth rejection (HTTP 401/403) is now reported as its own "API key required" state — separate from "unreachable" and generic API errors — with one-click remedies on both the notification and the method graph view: **Set API Key** (runs `Pipelex: Set Hosted API Key`) and, against the hosted endpoint, **Get an API Key** (opens `app.pipelex.com`); the message also points to the `cli` backend for local validation without a key.

### Changed
- On-save validation and the method graph pass `--allow-signatures` to `pipelex-agent validate bundle`, so work-in-progress bundles containing `PipeSignature` stubs validate and render instead of failing with `SignaturesNotAllowedError`
- Minimum supported `pipelex-agent` raised to 0.34.0 — required for the structured `validation_errors[]` fields (`source` / `field_name`) that power cross-file diagnostics and parity with the API backend. This is a compatibility-floor break: an older `pipelex-agent` is reported as too old (the extension's behavior is otherwise unchanged).
- Validation diagnostics now use the source label `pipelex` (was `pipelex-agent`), reflecting that either backend can produce them.

### Fixed
- The `pipelex-agent` version floor is now enforced before trusting the CLI's output, not only on a spawn failure. A CLI in the `[0.31.0, 0.34.0)` range still validates and emits a structured error list (without the `source` / `field_name` fields), so the previous lazy check let it through silently and degraded cross-file diagnostics; an under-floor CLI is now reported as too old up front on both the validation and graph paths.
- An open method-graph panel no longer keeps showing a stale graph when an on-save analysis fails or is skipped: a backend/transport failure now renders the error in the panel, and a save skipped because another extension reported errors shows a short notice. Previously, with validation enabled, only the success path updated the panel.
- A save that is skipped because another extension already reported errors now cancels any in-flight analysis for that file first, so a slow prior run can no longer resolve afterward and re-publish diagnostics the skip just cleared.

## [0.9.0] - 2026-05-31

### Changed
- Update bundled MTHDS schema to v0.31.0 — adds the `PipeSignature` blueprint (a contract-only pipe that declares inputs and output with no implementation, so an in-progress pipeline can be dry-run validated before all its pipes are implemented) and a `PipeType` enum (plxt 0.6.0)

## [0.8.0] - 2026-05-20

### Added
- `plxt lint --schema-path <path>` overrides the resolved schema with a local file, so MTHDS bundles can be linted against an in-development schema without publishing it (plxt 0.5.0)
- Method graph panel now detects outdated `pipelex-agent` (< 0.29.0) and surfaces a targeted upgrade message with install commands instead of a generic error

### Changed
- Method graph panel passes `--format json` to `pipelex-agent validate bundle`; this is required by `pipelex-agent` 0.29.0+, which now defaults to markdown output
- Upgrade @pipelex/mthds-ui to v0.6.5

## [0.7.1] - 2026-05-13

### Changed
- Upgrade @pipelex/mthds-ui to v0.6.4

## [0.7.0] - 2026-05-12

### Added
- New setting `pipelex.graph.foldMode` (`folded` / `expanded` / `auto`, default `folded`) controls the initial fold state of pipe controllers when a method graph opens. Users can still fold/unfold individual controllers via the in-graph toolbar afterwards. `auto` is reserved for future renderer-defined heuristics and currently behaves like `expanded`

### Changed
- `pipelex.graph.showControllers` default flipped from `false` to `true` — controller group boxes are now shown by default in the method graph. Users who previously relied on the default-off behavior will need to set this to `false` in their settings
- Upgrade @pipelex/mthds-ui to v0.6.1 — adds `initialFoldMode` prop on `GraphViewer` and `foldMode` field on `GraphConfig` so the extension can seed the controller fold state on first render
- Update bundled MTHDS schema to v0.27.0 — adds `PipeStructure` blueprint, new `render_js`/`include_raw_html` PDF options, and `xhigh` reasoning effort level (plxt 0.4.0)

### Fixed
- Method graph webview no longer ignores `pipelex.graph.direction`, `pipelex.graph.showControllers`, and `pipelex.graph.foldMode` when opening a method graph. The webview adapter previously mounted `GraphViewer` once with an empty config before the host's `setData` arrived and then reconciled the same instance across file switches; those settings are `useState` values seeded only on first render, so they latched to mthds-ui defaults (or to the first graph's config) and never picked up the host's preferences on subsequent opens. The adapter now defers the mount until config arrives and remounts the viewer when the panel is reused for a different file URI

## [0.6.5] - 2026-05-05

### Fixed
- PDFs in the Method Graph viewer now display a clickable "Open externally" tile instead of a blank `<embed>` frame when previewing live-run GraphSpecs that contain PDF stuff (e.g. presigned S3 URLs). VS Code webviews run in Electron without the Chromium PDFium plugin, so inline PDF rendering was never going to work; clicking the tile hands the URL to `vscode.env.openExternal` so the OS PDF viewer or default browser takes over

### Changed
- Upgrade @pipelex/mthds-ui to v0.5.1 — adds `canEmbedPdf` and `onOpenExternally` props on `StuffViewer`/`ConceptDetailPanel`/`GraphViewer` so hosts that can't render `<embed type="application/pdf">` can fall back to a clickable open-externally tile
- Switch `@pipelex/mthds-ui` from GitHub-pinned to the npm registry; clean up the webview toolbar wiring on the way

## [0.6.4] - 2026-04-15

### Changed
- Upgrade @pipelex/mthds-ui to v0.3.4

## [0.6.3] - 2026-04-13

### Fixed
- Fix `plxt` crashing in sandboxed environments (Codex, CI containers) due to eager HTTP client initialization — `plxt lint`, `plxt fmt`, and `plxt config which` no longer require network/proxy access on startup (plxt 0.3.3)
- Make schema HTTP client lazy: `Schemas` and `SchemaAssociations` now accept `Option<reqwest::Client>` and only build the client when lint actually encounters `http://` or `https://` schema sources (plxt 0.3.3)
- Normal `.mthds` linting uses the builtin `pipelex://mthds.schema.json` schema without touching the network (plxt 0.3.3)

## [0.6.2] - 2026-04-06

### Changed
- Upgrade @pipelex/mthds-ui to v0.2.3 (built-in Detail Panel support)
- Replace custom Stuff Inspector side panel with mthds-ui's built-in Detail Panel inside GraphViewer — node details now render inline without a separate panel

## [0.6.1] - 2026-04-02

### Changed
- Upgrade @pipelex/mthds-ui to v0.2.2 (fix bullet alignment in StuffViewer HTML lists)

### Fixed
- Fix GraphSpec JSON context key not initialized when extension activates with a JSON file already open — "Show Run Graph" button was invisible until switching editors
- Fix pre-commit hook and Makefile local-deps guard using GNU-only grep syntax that silently passes on macOS

## [0.6.0] - 2026-04-02

### Added
- GraphSpec JSON viewer: display run-result graphs directly from GraphSpec JSON files without the CLI — detected via `meta.format = "mthds"`
- New command "Pipelex: Show Run Graph" with editor title button for GraphSpec JSON files
- StuffViewer inspector panel in the graph webview: click a data node to inspect its content in a side panel
- Makefile shortcut `make pmu` for `pin-mthds-ui`

### Changed
- Upgrade @pipelex/mthds-ui to v0.2.1 (StuffViewer support, graph improvements)
- Pre-commit hook now blocks `portal:` and `file:` dependency links from being committed

### Fixed
- Fix viewport flash when switching between graphs: hide graph during layout, reveal after fitView settles
- Fix zoom level incorrectly preserved across different files — each file switch now runs fitView fresh
- Strip VS Code default webview padding from graph panel for full-bleed rendering

## [0.5.5] - 2026-04-01

### Changed
- Pin @pipelex/mthds-ui to v0.2.0 and remove redundant or obsolete dependencies
- Improve Makefile dependency switcher for mthds-ui (local vs GitHub)

## [0.5.4] - 2026-03-19

### Added
- `--quiet` / `-q` global flag to suppress tracing and log output, printing only lint diagnostics (plxt 0.3.2)
- Integration tests for `plxt lint` quiet-mode behavior (plxt 0.3.2)
- `pipelex-cli` crate added to `make test` target

## [0.5.3] - 2026-03-16

### Changed
- Adopt standard TextMate scopes and add Pipelex Dark color theme
- Bundle React and ReactFlow locally from mthds-ui instead of loading from CDN
- Upgrade React and ReactDOM from v18 to v19

## [0.5.2] - 2026-03-15

### Changed
- Refactor graph webview from monolithic JS into typed TypeScript modules for testability and portability
- Add esbuild bundling step for webview TypeScript (replaces raw file copy)
- Add 30 unit tests for pure graph modules (analysis, builders, controllers, layout)

## [0.5.1] - 2026-03-09

### Added
- Compact one-line lint error output for `plxt lint`: `file:line:col: error[category]: message` format (plxt 0.3.1)
- Specific schema error messages instead of generic AnyOf/OneOf for MTHDS pipe validation (plxt 0.3.1)

### Fixed
- Fix PipeCondition branches rendering in single column instead of side-by-side in method graph
- Fix UTF-8 panic when truncating multi-byte schema error messages (plxt 0.3.1)
- Fix I/O and UTF-8 errors silently swallowed in compact lint mode (plxt 0.3.1)
- Fix compact lint dedup collapsing distinct errors at different file locations into one (plxt 0.3.1)
- Fix "more chars" count inflated for multi-byte UTF-8 content in error truncation (plxt 0.3.1)
- Fix non-lint command errors suppressed without verbose flag (plxt 0.3.1)

## [0.5.0] - 2026-03-04

### Added
- Controller group boxes in method graph: toggle to show pipe controller boundaries with labels and type annotations
- Graph toolbar replacing footer: direction toggle, zoom controls, and controller visibility switch
- Click-to-navigate on controller group boxes and pipe nodes in the graph
- Implicit PipeBatch detection: `batch_over` controllers show "implicit PipeBatch" type with no fabricated name
- Batch item stuff nodes rendered inside their PipeBatch controller box
- `pipelex.toml`-driven graph styling (palette colors, spacing, zoom, pan)
- Pipe run actions via VS Code Testing API (replaces CodeLens)
- Method Graph panel restored automatically after window reload
- Controller toggle state persisted as a VS Code workspace setting
- Update MTHDS schema to v0.20.0: remove SearchDepth from search settings (plxt 0.3.0)

### Fixed
- Fix PipeBatch inputs and branches collapsing onto same position in graph layout
- Fix PipeParallel branches collapsing onto same position in graph layout
- Fix controller toggle resetting zoom by caching layout positions
- Fix controller toggle setting update failing without a workspace
- Skip `--inputs` flag when pipe has no inputs

### Changed
- Redesigned graph rendering: ViewSpec-only path with dataflow graph builder
- Controller selection highlight softened to 2px accent ring

### Removed
- Remove legacy graph renderer (classic mode)
- Remove dead `pipelex.runPipe` command

## [0.4.4] - 2026-03-02

### Added
- Add PipeSearch pipe type to embedded MTHDS JSON schema (plxt 0.2.3)

### Fixed
- Fix graph direction setting field name mismatch (`left_right` → `left_to_right`)
- Fix webview data race by always buffering pending data before HTML reload
- Fix pre-React global message listener not being removed after React mounts

## [0.4.3] - 2026-03-01

### Added
- Editor title bar buttons for MTHDS files: "Show Method Graph" and "Toggle Run Pipe CodeLens"
- Toggle setting `pipelex.mthds.runPipeCodeLens` to show/hide per-pipe CodeLens
- Per-pipe CodeLens to run individual pipes from the editor
- Play button in editor title bar to run `.mthds` bundles
- Native concept hover support for built-in MTHDS types
- MTHDS semantic hover with shared reference resolution (plxt 0.2.2)
- Code quality gates: fmt-check, lint, and enhanced CI (plxt 0.2.2)

### Fixed
- Fix Windows support: PowerShell call operator, single-quote escaping, browser activation for runBundle
- Fix shell injection in runBundle terminal commands
- Fix false-positive concept coloring on non-reference keys
- Fix concept coloring for domain prefix, multiplicity suffixes, and input entries
- Fix pipe ref semantic coloring
- Fix empty hover rectangle and duplicated schema titles (plxt 0.2.2)
- Fix bare model hover text and coloring (plxt 0.2.2)
- Fix false-positive model hover on input parameters named "model" (plxt 0.2.2)
- Fix empty ref_name after stripping concept qualifiers (plxt 0.2.2)
- Narrow clippy suppression scope (plxt 0.2.2)

## [0.4.2] - 2026-02-27

### Added
- Built-in MTHDS schema bundled into the binary for automatic `.mthds` file validation (plxt 0.2.1)

### Fixed
- Fix `plxt fmt`/`plxt lint` crash when glob patterns match directories (e.g. `.mthds/`) (plxt 0.2.1)
- Fix format-on-save race condition where formatting could read stale document state, causing content to revert (plxt 0.2.1)
- Fix schema association accumulation on every config save by clearing caches before re-initialization (plxt 0.2.1)
- Preserve MANUAL schema associations across config reloads (plxt 0.2.1)

## [0.4.1] - 2026-02-25

### Fixed
- Fix validate CLI calls to use `validate pipe` subcommand for graph and diagnostics

## [0.4.0] - 2026-02-21

### Added
- Graph direction setting (`pipelex.graph.direction`): choose between top-down and left-to-right layout for the method graph
- Method graph webview panel for visualizing method dependencies
- On-save validation via `pipelex-agent` CLI with inline diagnostics and source location mapping
- `plxt config which` command to print the resolved config file path (plxt 0.2.0)
- Schema association improvements: stricter matching and better error propagation in LSP handlers (plxt 0.2.0)

### Fixed
- Graph panel now handles JSON result parsing more robustly

### Changed
- Dedicated PyPI README for pipelex-tools
- README branding improvements (screenshot image)
- `pipelex-tools` Makefile target for Python package builds

## [0.3.2] - 2026-02-14

### Added
- `x-plxt` schema extension support

### Fixed
- Fix suffix-based false positives in `is_config_file` for `plxt.toml` (plxt 0.1.4)

### Changed
- Removed `PIPELEX_CONFIG` environment variable — use `plxt.toml` / `.pipelex/plxt.toml` instead (plxt 0.1.4)

## [0.3.1] - 2026-02-13

### Added
- `.plx` legacy file extension support with deprecation warnings

### Changed
- CI hardening: enterprise action allowlist, SHA-pinned actions, streamlined release workflows
- Rewritten extension README

## [0.3.0] - 2026-02-12

### Added
- Go-to-definition for pipe references in MTHDS files
- Programmatic TextMate grammar generator (replaces hand-edited `mthds.tmLanguage.json`)
- Dedicated syntax coloring for model field sigil references (`$`, `@`, `~`)
- Hot-reload config file changes for formatting without window restart
- `plxt` CLI wrapper crates with Pipelex config discovery (plxt 0.1.0)
- Release publishing pipelines for PyPI, VS Code Marketplace, and Open VSX
- Semantic token provider unit tests

### Changed
- **MTHDS Standard Migration**: File extension `.plx` → `.mthds`, language ID `plx` → `mthds`
- Semantic token IDs renamed from `plx*` to `mthds*` prefix
- TextMate grammar files renamed from `plx.*` to `mthds.*`
- User-facing terminology: "workflow" → "method"
- Rewrote semantic token provider with improved color configuration

## [0.2.1] - 2025-09-05

### Fixed

- Extension activation on language = "mthds", enabling the extension to work in BlackBoxAI IDE

## [0.2.0] - 2025-09-02

### Changed

- Set file extension to `.mthds` for Pipelex Language files

### Removed

- Cleaned up unused package

## [0.1.3] - 2025-08-21

### Added

- Build scripts

## [0.1.2] - 2025-08-21

### Changed

- Rebranded syntax error messages to Pipelex

## [0.1.1] - 2025-08-21

### Added
- Documentation composition system for maintaining Pipelex docs alongside Taplo upstream now also manages the Changelog

## [0.1.0] - 2025-08-21 (Initial Fork)

### Added
- Documentation composition system for maintaining Pipelex docs alongside Taplo upstream
- **MTHDS Language Support**: Full support for `.mthds` files (Pipelex Language)
- **Semantic Token Provider**: Context-aware highlighting for MTHDS constructs
  - Concept definitions: `[concept.Name]` sections
  - Pipe definitions: `[pipe.name]` sections
  - Variable injection: `$variable` syntax
  - Template support: Jinja2 `{{ }}` and `{% %}` blocks
- **TextMate Grammars**:
  - `mthds.tmLanguage.json` - Main MTHDS grammar
  - `mthds.frontmatter.tmLanguage.json` - Frontmatter support
  - `mthds.markdown.tmLanguage.json` - Markdown code block support
- **File Associations**: Automatic recognition of `.mthds` files
- **Example Files**: `test-data/example.mthds` demonstrating MTHDS syntax

### Technical Implementation
- Created isolated `src/pipelex/` directory for all MTHDS-specific code
- Minimal modifications to existing Taplo files
- Additive-only approach preserving all TOML functionality

### Documentation
- Added `PIPELEX.md` documenting the implementation
- Added `PIPELEX_CHANGES.md` tracking technical changes
- Created comprehensive VS Code extension README
