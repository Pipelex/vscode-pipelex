<!-- GENERATED: do not edit editors/vscode/README.md directly.
     Edit docs/pipelex/VSCODE_README.header.md and run scripts/compose-docs.sh -->

<div align="center"><img src="https://d2cinlfp2qnig1.cloudfront.net/banners/pipelex_vs_code_extension_v1.png" alt="Pipelex VS Code extension banner" width="800" style="max-width: 100%; height: auto;"></div>

# Pipelex Extension

**Define, compose, and run AI methods in `.mthds` files — with full TOML support**

A VS Code and Cursor extension that brings first-class editing support for [MTHDS](https://docs.pipelex.com) files and TOML. Rich syntax highlighting, semantic tokens, formatting, schema validation, completions, and more — built on [Taplo](https://github.com/tamasfe/taplo) and tracking upstream.

> **What is MTHDS?** — An open standard for defining AI methods as typed, composable, human-readable files. A `.mthds` file describes what an AI should do — its inputs, outputs, logic, and data types — in plain TOML that both people and machines can read. [Pipelex](https://github.com/Pipelex/pipelex) is the runtime that executes them. Learn more at [docs.pipelex.com](https://docs.pipelex.com).

## 🚀 MTHDS Language Support

Context-aware highlighting and semantic tokens for every MTHDS construct — concepts, pipes, typed inputs and outputs, model references, Jinja2 templates, data injection, and more. Each construct gets its own distinct color so you can read a `.mthds` file at a glance.

```toml
domain = "hr_screening"
description = "Analyze a job offer to build a scorecard, batch process CVs"
main_pipe = "screen_candidates"

[concept.Scorecard]
description = "Evaluation scorecard built from a job offer"

[concept.Scorecard.structure]
job_title = { type = "text", required = true }
company = { type = "text" }
required_skills = { type = "list", item_type = "text" }
criteria = { type = "list", item_type = "concept", item_concept_ref = "hr_screening.Criterion" }

[pipe.screen_candidates]
type = "PipeSequence"
inputs = { job_offer = "Document", cvs = "Document[]" }
output = "CvResult[]"
steps = [
    { pipe = "extract_job_offer", result = "job_pages" },
    { pipe = "build_scorecard", result = "scorecard" },
    { pipe = "evaluate_cv", batch_over = "cvs", result = "results" },
]

[pipe.build_scorecard]
type = "PipeLLM"
inputs = { job_pages = "Page[]" }
output = "Scorecard"
model = "claude-4.6-opus"
prompt = """Analyze this job offer and build a scorecard..."""
```

See the [MTHDS language reference](https://docs.pipelex.com) for the full standard.

## 🔧 Full TOML Support

Beyond MTHDS, this extension replaces your TOML extension with complete language support — formatting, completions, hover documentation, go-to-definition, rename, diagnostics, schema validation via [JSON Schema Store](https://www.schemastore.org/json/).

## ⚙️ Configuration

The extension looks for a settings file at **`.pipelex/toml_config.toml`** in your project root. The format is the same as a standard [Taplo configuration file](https://taplo.tamasfe.dev/configuration/file.html) — use it to configure formatting rules, schema associations, and linting options for both `.mthds` and `.toml` files.

## 📦 Installation

1. **Extensions marketplace** — Search for "Pipelex" in the Extensions view
2. **Command line** — `code --install-extension Pipelex.pipelex` or `cursor --install-extension Pipelex.pipelex`
3. **Manual** — Download `.vsix` from [releases](https://github.com/Pipelex/vscode-pipelex/releases)

---

"Pipelex" is a trademark of Evotis S.A.S.

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
