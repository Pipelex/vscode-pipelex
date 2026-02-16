<!-- GENERATED: do not edit README.md directly.
     Edit docs/pipelex/README.header.md and run scripts/compose-docs.sh -->

<div align="center"><img src="https://d2cinlfp2qnig1.cloudfront.net/banners/pipelex_vs_code_extension_v1.png" alt="Pipelex VS Code extension banner" width="800" style="max-width: 100%; height: auto;"></div>

# vscode-pipelex

This repo is a fork of [Taplo](https://github.com/tamasfe/taplo) extended with MTHDS support. It ships a **VS Code / Cursor extension**, the **`plxt` CLI**, and the **`pipelex-tools` PyPI package**.

> **What is MTHDS?** — An open standard for defining AI methods as typed, composable, human-readable files. A `.mthds` file describes what an AI should do — its inputs, outputs, logic, and data types — in plain TOML that both people and machines can read. [Pipelex](https://github.com/Pipelex/pipelex) is the runtime that executes them. Learn more at [docs.pipelex.com](https://docs.pipelex.com).

## `plxt` CLI

A drop-in replacement for the `taplo` CLI with Pipelex config discovery. Install via PyPI:

```bash
pip install pipelex-tools
# or
uv add pipelex-tools
```

| Command | Description |
|---------|-------------|
| `plxt fmt` | Format TOML and MTHDS documents |
| `plxt lint` | Lint TOML and MTHDS documents |
| `plxt lsp stdio` | Start the language server (stdio transport) |
| `plxt get` | Extract a value from a TOML document |
| `plxt config` | Print default config or its JSON schema |
| `plxt completions` | Generate shell completions |

**Configuration:** `plxt` looks for `.pipelex/plxt.toml` (preferred) or `plxt.toml` in your project root (falls back to `.taplo.toml`).

## VS Code / Cursor Extension

First-class editing support for `.mthds` files and TOML — syntax highlighting, semantic tokens, formatting, completions, schema validation, and more.

```bash
code --install-extension Pipelex.pipelex
# or
cursor --install-extension Pipelex.pipelex
```

See [`editors/vscode/README.md`](editors/vscode/README.md) for full details.

## What we offer in addition to Taplo

- **MTHDS language support**: Rich syntax highlighting, semantic tokens, and language features for `.mthds` files
- **Concept definitions**: `[concept.Name]` sections with specialized highlighting
- **Pipe definitions**: `[pipe.name]` sections for method steps
- **Data injection**: `@variable` syntax with smart highlighting
- **Template variables**: `$variable` support with Jinja2 templates
- **Pipelex config discovery**: `.pipelex/plxt.toml` or `plxt.toml`
- **All Taplo features retained**: Complete TOML 1.0.0 support and tooling

## Where to file issues

- **Taplo behavior/bugs** → [upstream Taplo project](https://github.com/tamasfe/taplo)
- **MTHDS-specific issues** → [this repository](https://github.com/Pipelex/vscode-pipelex/issues)

## MTHDS Example

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

---

"Pipelex" is a trademark of Evotis S.A.S.

---

## Original Taplo README (kept in sync)

<div style="text-align:left"><img src="taplo-icon.png" width="128"></div>

[![Continuous integration](https://github.com/tamasfe/taplo/workflows/Continuous%20integration/badge.svg)](https://github.com/tamasfe/taplo/actions?query=workflow%3A%22Continuous+integration%22)
[![Latest Version](https://img.shields.io/crates/v/taplo.svg)](https://crates.io/crates/taplo)
[![Documentation](https://docs.rs/taplo/badge.svg)](https://docs.rs/taplo)

[**Website**](https://taplo.tamasfe.dev)

# Taplo

This is the repository for Taplo, a TOML v1.0.0 toolkit, more details on the [website](https://taplo.tamasfe.dev).


- [Taplo](#taplo)
  - [Status](#status)
  - [Contributing](#contributing)

## Status

The project is very young, so bugs and incomplete features are expected, so [any help is welcome](CONTRIBUTING.md)!

The correctness of the TOML parsing and decoding is not yet entirely guaranteed (as there is no official 1.0.0 compliance test suite yet).

## Contributing

All kinds of contributions are welcome. Make sure to read the [CONTRIBUTING.md](CONTRIBUTING.md) first!
