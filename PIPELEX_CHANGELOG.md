# Pipelex Changelog

All notable changes to the Pipelex-specific features of this project will be documented in this file.

## [Unreleased]

### Added
- Documentation composition system for maintaining Pipelex docs alongside Taplo upstream
- Pipelex banner image in VS Code extension README
- "About Pipelex" section explaining the language and its purpose
- Trademark notice for Pipelex

### Changed
- Updated installation instructions to include Cursor IDE support
- Changed PML variable syntax from `@variable` to `$variable` in examples
- Improved README structure with cleaner separation of Pipelex and Taplo content

## [0.1.0] - 2024-01-XX (Initial Fork)

### Added
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

---

For Taplo-specific changes, see the main [CHANGELOG.md](CHANGELOG.md).
