# Pipelex Extension Changelog

## [0.2.0] - 2025-09-02

### Changed

- Set file extension to `.plx` for Pipelex Language files

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

## [0.1.0] - 2025-08-21 (Initial Fork 🎉)

### Added
- Documentation composition system for maintaining Pipelex docs alongside Taplo upstream
- **PLX Language Support**: Full support for `.plx` files (Pipelex Language)
- **Semantic Token Provider**: Context-aware highlighting for PLX constructs
  - Concept definitions: `[concept.Name]` sections
  - Pipe definitions: `[pipe.name]` sections
  - Variable injection: `$variable` syntax
  - Template support: Jinja2 `{{ }}` and `{% %}` blocks
- **TextMate Grammars**: 
  - `plx.tmLanguage.json` - Main PLX grammar
  - `plx.frontmatter.tmLanguage.json` - Frontmatter support
  - `plx.markdown.tmLanguage.json` - Markdown code block support
- **File Associations**: Automatic recognition of `.plx` files
- **Example Files**: `test-data/example.plx` demonstrating PLX syntax

### Technical Implementation
- Created isolated `src/pipelex/` directory for all PLX-specific code
- Minimal modifications to existing Taplo files
- Additive-only approach preserving all TOML functionality

### Documentation
- Added `PIPELEX.md` documenting the implementation
- Added `PIPELEX_CHANGES.md` tracking technical changes
- Created comprehensive VS Code extension README
