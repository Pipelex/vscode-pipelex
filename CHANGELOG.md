# Pipelex IDE Extension and `plxt` CLI Changelog

## [0.6.2] - 2026-04-06

### Changed
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
