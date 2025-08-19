# Pipelex PML Support

This fork of the Even Better TOML extension adds support for PML (Pipelex Markup Language) files alongside the existing TOML support.

## Features Added

### PML Language Support
- **File Extension**: `.pml` files are recognized and highlighted
- **Language ID**: `pml` 
- **Aliases**: "PML", "Pipelex Markup Language"

### PML-Specific Syntax Highlighting
The extension provides enhanced syntax highlighting for PML-specific constructs:

- **Concepts**: `[concept.Name]` sections and concept types
- **Pipes**: `[pipe.name]` sections and pipe types (PipeLLM, PipeSequence, etc.)
- **Data Variables**: snake_case variable names and data injection (`@variable`)
- **Template Variables**: `$variable` syntax
- **Jinja2 Templates**: `{{ }}` and `{% %}` blocks
- **HTML Templates**: Basic HTML tag support within strings

### Semantic Tokens
Custom semantic token providers for context-aware highlighting:

- `pmlConcept`: PascalCase concept names
- `pmlPipeType`: Pipe type identifiers (PipeLLM, etc.)
- `pmlDataVariable`: snake_case data variables
- `pmlPipeName`: snake_case pipe names
- `pmlPipeSection`: Pipe section headers
- `pmlConceptSection`: Concept section headers

## Architecture

The PML support is implemented as an **additive layer** on top of the existing TOML functionality:

```
editors/vscode/
├── src/
│   ├── pipelex/                    # All PML-specific code
│   │   ├── semanticTokenProvider.ts
│   │   └── pipelexExtension.ts
│   ├── extension.ts                # Minimal changes to register PML
│   └── client.ts                    # Added PML to document selector
├── pml.tmLanguage.json             # PML TextMate grammar
├── pml.frontmatter.tmLanguage.json
└── pml.markdown.tmLanguage.json
```

## Maintenance Strategy

This fork is designed to minimize merge conflicts with upstream:

1. **Isolated Code**: All PML-specific code is in the `src/pipelex/` directory
2. **Minimal Changes**: Only essential modifications to existing files
3. **Additive Only**: PML support is added alongside TOML, not replacing it
4. **Clear Separation**: Easy to identify what's original vs. what's added

## Syncing with Upstream

To sync with the upstream taplo repository:

```bash
# Add upstream remote if not already added
git remote add upstream https://github.com/tamasfe/taplo.git

# Fetch and merge upstream changes
git fetch upstream
git merge upstream/main

# Conflicts should be minimal and mostly in:
# - package.json (language definitions)
# - src/extension.ts (PML registration)
# - src/client.ts (document selector)
```

## Future Enhancements

Potential areas for PML-specific features:

- PML-specific validation rules
- Concept and pipe completion providers
- PML-specific code actions and quick fixes
- Integration with Pipelex toolchain
- PML-specific formatting options
