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
