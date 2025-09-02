# Pipelex PLX Support

This fork of the Even Better TOML extension adds support for PLX (Pipelex Language) files alongside the existing TOML support.

## Features Added

### PLX Language Support
- **File Extension**: `.plx` files are recognized and highlighted
- **Language ID**: `plx` 
- **Aliases**: "PLX", "Pipelex Language"

### PLX-Specific Syntax Highlighting
The extension provides enhanced syntax highlighting for PLX-specific constructs:

- **Concepts**: `[concept.Name]` sections and concept types
- **Pipes**: `[pipe.name]` sections and pipe types (PipeLLM, PipeSequence, etc.)
- **Data Variables**: snake_case variable names and data injection (`@variable`)
- **Template Variables**: `$variable` syntax
- **Jinja2 Templates**: `{{ }}` and `{% %}` blocks
- **HTML Templates**: Basic HTML tag support within strings

### Semantic Tokens
Custom semantic token providers for context-aware highlighting:

- `plxConcept`: PascalCase concept names
- `plxPipeType`: Pipe type identifiers (PipeLLM, etc.)
- `plxDataVariable`: snake_case data variables
- `plxPipeName`: snake_case pipe names
- `plxPipeSection`: Pipe section headers
- `plxConceptSection`: Concept section headers

## Architecture

The PLX support is implemented as an **additive layer** on top of the existing TOML functionality:

```
editors/vscode/
├── src/
│   ├── pipelex/                    # All PLX-specific code
│   │   ├── semanticTokenProvider.ts
│   │   └── pipelexExtension.ts
│   ├── extension.ts                # Minimal changes to register PLX
│   └── client.ts                    # Added PLX to document selector
├── plx.tmLanguage.json             # PLX TextMate grammar
├── plx.frontmatter.tmLanguage.json
└── plx.markdown.tmLanguage.json
```

## Maintenance Strategy

This fork is designed to minimize merge conflicts with upstream:

1. **Isolated Code**: All PLX-specific code is in the `src/pipelex/` directory
2. **Minimal Changes**: Only essential modifications to existing files
3. **Additive Only**: PLX support is added alongside TOML, not replacing it
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
# - src/extension.ts (PLX registration)
# - src/client.ts (document selector)
```

## Future Enhancements

Potential areas for PLX-specific features:

- PLX-specific validation rules
- Concept and pipe completion providers
- PLX-specific code actions and quick fixes
- Integration with Pipelex toolchain
- PLX-specific formatting options
