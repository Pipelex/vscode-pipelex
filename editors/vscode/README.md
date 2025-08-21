<!-- GENERATED: do not edit editors/vscode/README.md directly.
     Edit docs/pipelex/VSCODE_README.header.md and run scripts/compose-docs.sh -->

<div align="center"><img src="https://d2cinlfp2qnig1.cloudfront.net/banners/pipelex_vs_code_extension_v1.png" alt="Pipelex VS Code extension banner" width="800" style="max-width: 100%; height: auto;"></div>

# Pipelex VS Code Extension

**Rich language support for Pipelex Markup Language (PML) and TOML files**

This extension provides comprehensive VS Code support for the **Pipelex Markup Language (PML)**, which is based on TOML syntax, along with full TOML language support. Built as a fork of the excellent [Taplo](https://github.com/tamasfe/taplo) language server, it tracks upstream closely while adding PML-specific features like advanced syntax highlighting, semantic tokens, and intelligent language features for `.pml` files.

## 🚀 **PML Features**

### 📝 **Pipelex Markup Language Support**
- **Rich syntax highlighting** for PML-specific constructs
- **Concept definitions**: `[concept.Name]` sections with specialized highlighting  
- **Pipe definitions**: `[pipe.name]` sections for workflow steps
- **Data injection**: `@variable` syntax with smart highlighting
- **Template variables**: `$variable` support
- **Jinja2 templates**: `{{ }}` and `{% %}` blocks with keyword highlighting
- **HTML templates**: Basic HTML tag support within strings
- **Semantic tokens** for context-aware highlighting

### 🎨 **PML Syntax Highlighting**
- **🔵 Concept sections** - `[concept.Name]` in teal (`#4ECDC4`)
- **🔴 Pipe sections** - `[pipe.name]` in red (`#FF6666`) 
- **🟢 Data variables** - `@variable`, `$variable` in green (`#98FB98`)
- **🟣 Template syntax** - Jinja delimiters in pink (`#FF79C6`)
- **🟡 HTML elements** - Tags and attributes in orange/yellow
- **🔷 Concept types** - `ConceptType` references highlighted
- **🔶 Pipe types** - `PipeLLM`, `PipeSequence` etc. highlighted

### Example PML File
```toml
# Pipelex workflow definition
[concept.UserQuery]
definition = "A user's natural language query"

[pipe.analyze_query]
type = "PipeLLM"
definition = "Analyzes a user's natural language query"
inputs = { query = "UserQuery" }
output = "QueryAnalysis"
prompt_template = """
Analyze this user query: $query
Extract the key information and intent.
"""
```

## 📦 **Installation**
1. **From extensions marketplace**: Search for "Pipelex" in the Extensions view
2. **From Command Line**: `code --install-extension Pipelex.pipelex` or `cursor --install-extension Pipelex.pipelex`
3. **Manual Installation**: Download `.vsix` from [releases](https://github.com/Pipelex/vscode-pipelex/releases)

---

## Original Taplo VS Code README (kept in sync)

Everything below is the original Taplo README, kept in sync with upstream for your reference.



A TOML language support extension backed by [Taplo](https://taplo.tamasfe.dev).

It is currently a **preview extension**, it might contain bugs, or might even crash. If you encounter any issues, please report them [on github](https://github.com/tamasfe/taplo/issues).

- [Features](#features)
  - [TOML version 1.0.0 support](#toml-version-100-support)
  - [Syntax highlighting](#syntax-highlighting)
    - [Additional Syntax Colors](#additional-syntax-colors)
  - [Semantic highlighting](#semantic-highlighting)
  - [Validation](#validation)
  - [Folding](#folding)
  - [Symbol tree and navigation](#symbol-tree-and-navigation)
  - [Refactors](#refactors)
    - [Renaming](#renaming)
  - [Formatting](#formatting)
  - [Completion and Validation with JSON Schema](#completion-and-validation-with-json-schema)
  - [Commands](#commands)
- [Configuration File](#configuration-file)
- [Special Thanks](#special-thanks)

# Features

## TOML version [1.0.0](https://toml.io/en/v1.0.0) support

This extension will try to support all the TOML versions in the future.

## Syntax highlighting

Syntax highlighting for TOML documents with TextMate grammar.

![Syntax Highlighting](images/highlight.png)

### Additional Syntax Colors

The extension defines custom scopes for array headers and arrays of tables.

In order to differentiate them from regular keys, you can set your own colors for them. Unfortunately this [has to be done manually](https://github.com/Microsoft/vscode/issues/32813).

You might also want to set a color for dates and times, as they don't have have one in most themes.

<details>
<summary>Custom color settings for the Dark+ theme</summary>

```json
{
  "editor.tokenColorCustomizations": {
      "textMateRules": [
          {
              "scope": "support.type.property-name.table",
              "settings": {
                  "foreground": "#4EC9B0",
              },
          },
          {
              "scope": "support.type.property-name.array",
              "settings": {
                  "foreground": "#569CD6",
              }
          },
          {
              "scope": "constant.other.time",
              "settings": {
                  "foreground": "#DCDCAA",
              }
          }
      ]
  },
}
```
</details>

![Extended Color Highlighting](images/extended_colors.png)

## Semantic highlighting

Semantic key highlighting for inline tables and arrays can be enabled in the settings.

**You need to set extended colors in order for this to have any practical effect.**

![Semantic Highlighting](images/semantic_colors.png)

## Validation

![Validation](images/validation.gif)

## Folding

Arrays, multi-line strings and top level tables and comments can be folded.

![Folding](images/folding.gif)

## Symbol tree and navigation

Works even for tables not in order.

![Symbols](images/symbols.gif)

## Refactors

### Renaming

![Rename](images/rename.gif)

## Formatting

The formatter is rather conservative by default, additional features can be enabled in the settings. If you're missing a configuration option, feel free to open an issue about it!

![Formatting](images/formatting.gif)

## Completion and Validation with [JSON Schema](https://json-schema.org/)

There is support for completion, hover text, links and validation.

Schemas can be associated with document URIs with the `evenBetterToml.schema.associations` configuration.

You can provide your own schemas or use existing schemas from the [JSON Schema Store](https://www.schemastore.org/json/). More details [here](https://taplo.tamasfe.dev/configuration/using-schemas.html#using-schemas).

![Schema](images/schema.gif)

## Commands

The extension provides commands for easy JSON<->TOML conversions.

# Configuration File

Taplo CLI's [configuration file](https://taplo.tamasfe.dev/configuration/file) is supported and automatically found in workspace roots, or can be manually set in the VS Code configuration.

# Special Thanks

- To [@GalAster](https://github.com/GalAster) and [@be5invis](https://github.com/be5invis) for letting me use their TextMate grammar.
- To every contributor.
- And to everyone else using this extension.
