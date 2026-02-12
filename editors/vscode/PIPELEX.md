# Pipelex MTHDS Support

This fork of the Even Better TOML extension adds support for MTHDS (Pipelex Language) files alongside the existing TOML support.

## Features Added

### MTHDS Language Support
- **File Extension**: `.mthds` files are recognized and highlighted
- **Language ID**: `mthds`
- **Aliases**: "MTHDS", "Pipelex Language", "PLX"

### MTHDS-Specific Syntax Highlighting
The extension provides enhanced syntax highlighting for MTHDS-specific constructs:

- **Concepts**: `[concept.Name]` sections and concept types
- **Pipes**: `[pipe.name]` sections and pipe types (PipeLLM, PipeSequence, etc.)
- **Data Variables**: snake_case variable names and data injection (`@variable`)
- **Template Variables**: `$variable` syntax
- **Jinja2 Templates**: `{{ }}` and `{% %}` blocks
- **HTML Templates**: Basic HTML tag support within strings

### Semantic Tokens
Custom semantic token providers for context-aware highlighting:

- `mthdsConcept`: PascalCase concept names
- `mthdsPipeType`: Pipe type identifiers (PipeLLM, etc.)
- `mthdsDataVariable`: snake_case data variables
- `mthdsPipeName`: snake_case pipe names
- `mthdsPipeSection`: Pipe section headers
- `mthdsConceptSection`: Concept section headers

## Architecture

The MTHDS support is implemented as an **additive layer** on top of the existing TOML functionality:

```
editors/vscode/
├── src/
│   ├── pipelex/                    # All MTHDS-specific code
│   │   ├── semanticTokenProvider.ts
│   │   └── pipelexExtension.ts
│   ├── extension.ts                # Minimal changes to register MTHDS
│   └── client.ts                    # Added MTHDS to document selector
├── mthds.tmLanguage.json             # MTHDS TextMate grammar
├── mthds.frontmatter.tmLanguage.json
└── mthds.markdown.tmLanguage.json
```

## Maintenance Strategy

This fork is designed to minimize merge conflicts with upstream:

1. **Isolated Code**: All MTHDS-specific code is in the `src/pipelex/` directory
2. **Minimal Changes**: Only essential modifications to existing files
3. **Additive Only**: MTHDS support is added alongside TOML, not replacing it
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
# - src/extension.ts (MTHDS registration)
# - src/client.ts (document selector)
```

## Future Enhancements

Potential areas for MTHDS-specific features:

- MTHDS-specific validation rules
- Concept and pipe completion providers
- MTHDS-specific code actions and quick fixes
- Integration with Pipelex toolchain
- MTHDS-specific formatting options
