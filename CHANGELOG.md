# Pipelex IDE Extension and `plxt` CLI Changelog

## [Unreleased]

### Changed
- Dedicated PyPI README for pipelex-tools
- README branding improvements (screenshot image)

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
