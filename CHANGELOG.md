# Pipelex Extension Changelog

## [0.1.1] - 2025-08-21

### Added
- Documentation composition system for maintaining Pipelex docs alongside Taplo upstream now also manages the Changelog

## [0.1.0] - 2025-08-21 (Initial Fork 🎉)

### Added
- Documentation composition system for maintaining Pipelex docs alongside Taplo upstream
- **PML Language Support**: Full support for `.pml` files (Pipelex Markup Language)
- **Semantic Token Provider**: Context-aware highlighting for PML constructs
  - Concept definitions: `[concept.Name]` sections
  - Pipe definitions: `[pipe.name]` sections
  - Variable injection: `$variable` syntax
  - Template support: Jinja2 `{{ }}` and `{% %}` blocks
- **TextMate Grammars**: 
  - `pml.tmLanguage.json` - Main PML grammar
  - `pml.frontmatter.tmLanguage.json` - Frontmatter support
  - `pml.markdown.tmLanguage.json` - Markdown code block support
- **File Associations**: Automatic recognition of `.pml` files
- **Example Files**: `test-data/example.pml` demonstrating PML syntax

### Technical Implementation
- Created isolated `src/pipelex/` directory for all PML-specific code
- Minimal modifications to existing Taplo files
- Additive-only approach preserving all TOML functionality

### Documentation
- Added `PIPELEX.md` documenting the implementation
- Added `PIPELEX_CHANGES.md` tracking technical changes
- Created comprehensive VS Code extension README
