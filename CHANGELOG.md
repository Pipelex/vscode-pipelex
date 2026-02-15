# Pipelex Extension Changelog

## [0.3.0] - 2026-02-12

### Changed
- **MTHDS Standard Migration**: File extension changed from `.plx` to `.mthds`
- Language ID changed from `plx` to `mthds`
- Semantic token IDs renamed from `plx*` to `mthds*` prefix
- TextMate grammar files renamed from `plx.*` to `mthds.*`
- User-facing terminology: "workflow" → "method" for MTHDS concepts

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
