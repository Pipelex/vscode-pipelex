<!-- GENERATED: do not edit editors/vscode/CHANGELOG.md directly.
     Edit CHANGELOG.md and docs/pipelex/CHANGELOG.header.md and run scripts/compose-docs.sh -->

# Pipelex IDE Extension and `plxt` CLI Changelog

## [0.10.0] - 2026-06-21

### Added
 - **Selectable validation backends:** New `pipelex.backend` setting chooses between `cli` (default, zero-config) and `api` (opt-in) for validating `.mthds` bundles and rendering method graphs. The `api` backend validates over HTTP via the `mthds` client, configurable through `pipelex.api.baseUrl` (defaults to `https://api.pipelex.com`).
 - **API key management:** Added `Pipelex: Set Hosted API Key` and `Pipelex: Clear Hosted API Key` commands. Keys are stored securely in VS Code's `SecretStorage` and resolved automatically by the API backend.
 - **Cross-file diagnostics:** Validation errors are now placed on their declaring file (resolved from the error's `source` field) rather than defaulting to the currently saved file.
 - **Interactive error view in graph panel:** Failed validations now display a clickable list of errors; clicking one opens the owning file (even a sibling) at the offending line. Includes a **Retry** button for transient failures and an "API key required" state with one-click **Set API Key** / **Get an API Key** actions for HTTP 401/403 rejections.
 - **Privacy safeguard:** Added a one-time confirmation prompt before the `api` backend sends directory-wide bundle contents to a non-localhost remote server.
 - **Documentation & tooling:** Added documentation for the new backends (`docs/features/validation-backends.md`) and a Claude skill (`.claude/skills/bump-pipelex-version/SKILL.md`) to standardize bumping the minimum `pipelex-agent` CLI version.

### Changed
 - **Minimum CLI version bumped to `0.34.0`:** Required for the structured `validation_errors[]` fields (`source`, `field_name`) that power cross-file diagnostics. The version floor is now strictly enforced *before* trusting CLI output, preventing older CLIs (which exit 0 but lack structured fields) from silently degrading diagnostics.
 - **Direct structured error consumption:** Both backends now consume the runtime's structured `validation_errors[]` directly. The `api` backend reads the 200-response `/validate` body and treats invalid bundles as a produced verdict (`is_valid: false`) rather than catching an HTTP 422, and dry-run failures now ride a graph-level `dry_run` item.
 - **Diagnostic source label** changed from `pipelex-agent` to `pipelex`, reflecting that errors can originate from either backend.
 - **Tolerate signature stubs:** On-save validation and the method graph now pass `--allow-signatures` to `pipelex-agent validate bundle`, allowing WIP bundles with `PipeSignature` stubs to validate and render.
 - **Method graph theme follows the editor:** The graph now opens in the palette matching the active VS Code color theme by default. The new `pipelex.graph.theme` setting (`auto`/`dark`/`light`) pins it, and the in-graph theme button still toggles live. Toggling it now **persists** your choice back into `pipelex.graph.theme` (Workspace scope when a value already lives there, otherwise Global — the same scopes the renderer reads), so a dark/light/system pick is restored on the next open and after restarting VS Code. Toggling to *system* when nothing is explicitly set is a no-op, so it never pins an explicit `auto` over a `pipelex.toml` `style.theme`. A `pipelex.toml` `style.theme` pin is also honored — only an *explicitly set* `pipelex.graph.theme` overrides it, so the contributed `auto` default no longer silently clobbers the toml value.
 - **Dependencies:** Pinned `@pipelex/mthds-ui` to `0.9.0` (was a floating `npm:latest`, which could pull a renderer with a changed theme contract on any lockfile refresh) and added `mthds` `0.12.0`.
 - **Language label renamed to "MTHDS Language":** The VS Code language alias for `.mthds` files changed from "Pipelex Language" to "MTHDS Language", completing the retirement of the "Pipelex Language" branding (the language is MTHDS; Pipelex is the runtime).

### Fixed
 - **MTHDS syntax highlighting in light themes:** `.mthds` code is now readable in light VS Code themes instead of the dark-tuned colors bleeding through. The extension ships its palette via `configurationDefaults`, but VS Code ignores theme-scoped keys from that source, so a declarative light variant is impossible. Instead, when a light theme is active with a `.mthds` file open, the extension offers a one-time prompt (**Apply** / **Not now** / **Don't ask again**) to write a managed `[*Light*]` block into the user's own `editor.tokenColorCustomizations` — a merge-safe, idempotent write. Each rule the extension writes is tagged with a sentinel `name`, so apply and remove only ever touch the extension's own rules and never disturb a user-authored rule that happens to target the same MTHDS scope. The light palette covers the full `pipelex-light` storybook look (brand colors plus strings, property names, booleans, numbers, punctuation, and Jinja/HTML), every scope `.mthds`-suffixed so it never recolors other languages, and matches on any light theme. Dark-only users get zero settings changes. New commands **Pipelex: Apply / Remove Light Theme Colors for MTHDS** opt in later or clean up.
 - **Method graph light mode:** Toggling the in-graph theme button to Light now applies the full light palette to nodes and edges. The extension previously forced a fixed dark palette over the renderer's theme, so node/edge colors stayed dark in light mode while only the background switched.
 - **Method graph follows live theme switches:** An open method-graph panel set to follow the editor (the default) now repaints when you switch VS Code between a light and a dark theme, instead of keeping its original palette until the next save. The host sends the theme *mode* (`system` by default) and injects the resolved theme into the renderer's `system` mode — the webview's own `prefers-color-scheme` is unreliable — re-sending it on each color-theme change. A manual in-graph theme pin is preserved across the switch.
 - **Stale graph prevention:** An open method-graph panel no longer shows a stale graph when on-save analysis fails or is skipped; backend/transport failures render the error directly in the panel.
 - **Race condition on skipped saves:** A skipped save (e.g., when another extension reports syntax errors) now cancels any in-flight analysis for that file, preventing a slow prior run from re-publishing stale diagnostics.
 - **Concurrent sibling-save race:** Saving two `.mthds` files in the same directory in quick succession no longer lets a slower earlier run overwrite the newer save's diagnostics. Diagnostics are written per directory but analyses are cancelled per file, so each save is now stamped with a per-directory generation and a stale run's write is dropped.

### Removed
 - **`pipelex.graph.palette` setting:** Dropped the `dracula`/`yellow_blue` palette override. It duplicated and overrode the renderer's own light/dark palette (which is what broke light mode); theming is now driven by `pipelex.graph.theme` and the in-graph toggle.
 - **Fabricated diagnostics:** Removed the synthesized `blueprint_validation` diagnostics at the backend sites. Exit-1 CLI envelopes with empty error lists are now surfaced as infrastructure errors instead of synthesized stand-ins.
 - **`.plx` file extension:** Dropped the deprecated `.plx` extension entirely. In the extension, the `mthds` language no longer associates `.plx` files, on-save bundle gathering no longer includes them, and the file watcher and one-time deprecation prompt are gone. Use `.mthds`.
 - **`.plx` in the CLI and language server:** `plxt` no longer discovers, formats, or lints `.plx` files (the default glob is now `**/*.{toml,mthds}`), and the language server no longer treats `.plx` as MTHDS or emits the `.plx` deprecation diagnostic. (plxt 0.7.0)

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

---

## Taplo Changelog (from upstream)

# Change Log

## 0.21.2

### Fixes

- Re-release for VS Marketplace since the token for publishing extension was expired

## 0.21.1

### Fixes

- Re-release for VS Marketplace since the token for publishing extension was expired
- Bump VS Code engine to 1.90.0 which is a minimum version required due to NodeJS v20 dependency that includes webcrypto

## 0.21.0

### Fixes

- Update `@taplo/lsp` to `0.8.0`
- Update `which` dependency to `0.5.0`
- Remove activation events auto-generated by VS Code

### Features

- Add `uv.lock` to recognised filenames [#668](https://github.com/tamasfe/taplo/pull/668)
- Add option to reorder inline tables and `reorderInlineTables` configuration option [#671](https://github.com/tamasfe/taplo/pull/671)

## 0.20.2

### Fixes

- Re-release that fixes release CI workflow

## 0.20.1

### Fixes

- Remove crypto workaround since VS Code imports own

## 0.20.0

### Fixes

- Fix VS Code LSP crash ([#462](https://github.com/tamasfe/taplo/pull/462))

## 0.19.1

### Features

- Added `align_single_comments` formatter setting ([#409](https://github.com/tamasfe/taplo/pull/409))

### Fixes

- Fixed incorrectly modifying file extensions in catalog rules ([#426](https://github.com/tamasfe/taplo/pull/426))
- Fixed non-deterministic `--diff` output ([#424](https://github.com/tamasfe/taplo/pull/424))
- Fixed incorrect path handling of `--stdin-filepath` ([#418](https://github.com/tamasfe/taplo/pull/418))
- Fixed incorrect path handling in LSP rule matching ([#378](https://github.com/tamasfe/taplo/pull/378))
- Fixed incorrect support of LSP shutdown requests ([#354](https://github.com/tamasfe/taplo/pull/354))

## 0.19.0

### Features

- Added `reorder_arrays` (`evenBetterToml.formatter.reorderArrays`) formatter option that allows for sorting values within arrays. ([#343](https://github.com/tamasfe/taplo/pull/343))

## 0.18.3

### Fixed

- Fixed crash caused by setting environment variables in WASM. Unfortunately this reverted `HTTP_PROXY` support.

## 0.18.2

### Fixes

- Fixed TOML parser issues.
- Fixed rules being ignored.
- `HTTP(S)_PROXY` environment variables are now respected.

## 0.18.1

### Fixes

- Fixed the language server crashing on startup.

## 0.18.0

### Features

- Added `evenBetterToml.formatter.inlineTableExpand` option.

### Fixes

- Fixed some filepath-related issues on windows.
- Fixed completion crashes on `null` default values.

## 0.17.1

### Fixes

- The bundled language server was not updated in `0.17.0`.

## 0.17.0

### Features

- The language server now accepts Taplo rules in the `evenBetterToml.rules` setting
- Show schema title in hover
- Added builtin schema for `taplo.toml`

### Fixes

- Fixed path handling on Windows
- Completion of literal strings now works
- Schema directives now should work more reliably

### Other

- Schemas now will only be fetched from the [schema store](https://schemastore.org) by default

## 0.16.5

### Fixes

- Fixed the language server ignoring the given path to the configuration file in `evenBetterToml.taplo.configFile.path`
- Environment variables are now correctly passed to the bundled language server

## 0.16.4

### Fixes

- Fixed incorrect default formatting options
- Changed auto-closing behaviour ([#273](https://github.com/tamasfe/taplo/pull/273))

## 0.16.3

### Fixes

- Fixed wrong configuration for multiple workspaces

## 0.16.2

### Other

- Web extension compatibility

## 0.16.1

### Fixes

- Even more syntax highlight fixes
- Configuration parameter fixes

## 0.16.0

### Changes

- Changed syntax highlight scopes for table and array of tables keys

### Fixes

- Syntax highlight enhancements and bug fixes

## 0.15.2

### Fixes

- Extension readme images

## 0.15.1

### Fixes

- Fixed default formatting options

## 0.15.0

### Features

- Wide-range JSON schema Draft 4 support
- Support for schema store schemas
- Support for multiple workspaces
- It is now possible to specify schemas with either `#:schema <URL>` or `"$schema" = "<URL>"` in TOML files
- Added rename feature that lets you rename keys that appear at multiple locations
- Added support for `tomlValidation` in extensions

### Other

- Almost a complete internal rewrite with various fixes and improvements. ([#211](https://github.com/tamasfe/taplo/pull/211))

## 0.14.3

### Fixes

- Formatter fixes

## 0.14.2

### Fixes

- Respect exclude rules in Taplo config.

## 0.14.1

### Fixes

- Formatter fixes

## 0.14.0

### Features

- Syntax highlight for comment directives (comments starting with `#:`)
- Syntax highlight in markdown 

### Fixes

- Formatter fixes regarding comments

## 0.13.1

### Features

- Added `indentEntries` formatter option that was supposed to be in `0.13.0`

### Fixes

- Formatter indentation fixes

## 0.13.0

### Features

- New formatting options: `alignComments` and `compactEntries`

### Fixes

- Completely reworked formatting code
- Fixed various false errors
- The `columnWidth` formatter option is more closely enforced

## 0.12.3

### Fixes

- Fixed formatting comments inside arrays
- Relative paths inside comments are relative to the document ([#119](https://github.com/tamasfe/taplo/pull/119))

## 0.12.2

### Fixes

- Fixed handling Windows-specific paths ([#114](https://github.com/tamasfe/taplo/pull/114))
- Fixed LSP crash on invalid schema URLs.

## 0.12.1

### Fixes
- Fixed LSP crash when editing table keys

## 0.12.0

### Features
- Improved refactoring code actions
- Schema directive support

## 0.11.1

### Fixes
- Fixed previous broken release

## 0.11.0

### Features
- Basic refactoring actions
  - inline array of tables -> array of tables
  - inline table -> table

### Fixes
- Formatting fixes
- Fixed semantic highlights

## 0.10.0

### Features
- Conversion commands from JSON to TOML
- Remote schema repository

### Fixes
- Better comment formatting
- Several schema fixes

## 0.9.4

### Features
- Added `rustfmt.toml` schema ([#65](https://github.com/tamasfe/taplo/pull/65))
## 0.9.3
### Fixes
- Fixed syntax highlights (again...)

## 0.9.2
### Fixes

- Fixed unusable config files

## 0.9.1

### Fixes
- Fixed missing syntax highlights

## 0.9.0

### Features
- Support for [Taplo CLI's](https://taplo.tamasfe.dev/configuration/#configuration-file) configuration file
- Support for remote (http/https) schemas

### Fixes
- Several incorrect parsing errors, mainly concerning arrays of tables.
- Rewritten parsing for increased performance
- A lot more accurate completions

## 0.8.7

### Fixes
- Python schema fixes

## 0.8.6

### Fixes
- Major Python schema improvements ([PR](https://github.com/tamasfe/taplo/pull/45))
- Quoted and unquoted keys are properly compared

## 0.8.5

### Fixes
- Python schema fix

## 0.8.4

### Fixes
- Comments inside arrays should be handled a bit better

## 0.8.3

### Fixes
- Fixed false errors in arrays of tables
- Fixed some incorrect schemas

## 0.8.2

### Fixes
- Syntax highlighting fixes
- Some completion fixes

## 0.8.1

#### Fixes
- Fixed comment highlighting ([#30](https://github.com/tamasfe/taplo/issues/30))
- Fixed validation for `pyproject.toml` schema

## 0.8.0

#### New Features
- Schemas are enabled by default
- pyproject.toml schema with Poetry

#### Fixes
- Better schema key completions
- Fixed excessive links in schemas

#### Other
- Links have to be enabled explicitly for schemas

## 0.7.2

#### Fixes
- Extension config should be properly applied now
- Removed separate language for `Cargo.lock`

## 0.7.1

#### Fixes
- Fixed incorrectly accepted arrays
- Fixed infinite loop caused by invalid arrays
- Better formatter indentation

#### Other
- Disabled formatter `alignEntries` and `formatKeys` by default ([#29](https://github.com/tamasfe/taplo/issues/29))

## 0.7.0

#### New Features
- Added allowed blank lines formatter option. (default 2)
- TextMate grammar
- Semantic highlighting option

#### Other
- Automatic indentation for the formatter is disabled by default

#### Fixes
- Document close events are not ignored anymore

## 0.6.2
- Invalid inline tables don't cause an infinite loop anymore
- Hover and links are now better handled in dotted keys

## 0.6.1

#### Fixes
- Fixed false negative error regarding dotted key and top level table conflicts
- Added another check for dotted key and top level table conflicts
- Fixed an error when enabling schemas

#### Other
- More user-friendly error messages coming from the LSP

## 0.6.0

#### New Features
- Added compact arrays formatter option
- Added compact inline tables formatter option
- Completion and validation based on JSON schema (disabled by default)

#### Fixes
- Fixed broken document symbols

## 0.5.1

### Fixes
- Fixed incorrect parsing of floats
- Fixed some incorrectly accepted table headers
- Incorrect underscores in numbers are no longer accepted
- Fixed wrong internal DOM representation (relevant to JSON conversions)
- Array and table keys are different colors again in the default theme (with a workaround until there are proper textmate scopes)
- CR (`\r`) characters are now allowed in multi-line strings

### Other
- Foundations of JSON schema support (cannot be enabled without manually building yet)
- Added DOM tree debug command

## 0.5.0

#### New Features
- Added formatter entry alignment setting

## 0.4.2

### Fixes
- Restored accidentally deleted README

## 0.4.1

### Fixes
- Use the VSCode clipboard API instead of clipboardy
- Remote workspaces should be supported
- Fixed incorrect detection of top level table conflicts with dotted keys

## 0.4.0

#### New Features
- Activation message in the status bar
- Paste as JSON command

#### Fixes
- Tables that conflict with dotted keys are no longer accepted
- Fixed too many new lines at the end when formatting
- Fixed incorrect indentation

#### Other
- Non-debug commands are always visible in the palette unless disabled
- Better error notifications

## 0.3.0

#### New Features
- Multi-line strings and string literals can be folded
- Arrays of tables have the same color as arrays. They should be easier to immediately distinguish from regular tables this way.

#### Fixes
- Non-ASCII characters should now work correctly
- Table folding ranges now start on the correct line
- Fixed parsing error that ocurred when there was no new line after multi-line strings or string literals
- Potentially misleading semantic errors are not shown anymore if there are any syntax errors

#### Other
- Added debug commands

## 0.2.0

#### New Features
- Copy selection as JSON command (enabled in TOML documents only)

#### Fixes
- Fixed incorrect array parsing

#### Other
- Bundling with webpack, and stricter packaging

## 0.1.1

#### Fixes
- Symbol tree fixes, values inside arrays are now also part of the tree

## 0.1.0
- Initial preview release