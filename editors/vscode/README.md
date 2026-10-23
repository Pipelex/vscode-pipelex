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

The extension looks for a settings file at **`.pipelex/plxt.toml`** (preferred) or **`plxt.toml`** in your project root. The format is the same as a standard [Taplo configuration file](https://taplo.tamasfe.dev/configuration/file.html) — use it to configure formatting rules, schema associations, and linting options for both `.mthds` and `.toml` files.

### Method validation

On every save, the extension validates your method on the hosted Pipelex API at `https://api.pipelex.com`, and reports the errors in the Problems panel and in the method graph. There is nothing to install and no setting to change: an API key is the only setup step (see Installation below). What it sends is the saved file's method tree, the files a run of the method would send: every file under the nearest directory holding a `METHODS.toml`, or else under the saved file's directory, such as the method's `.mthds` files, templates and Python modules, minus what the MTHDS membership rule keeps out, which includes every name starting with a dot and what a `.gitignore` inside the tree names. Before the first validation, the extension asks once for your consent to send it.

- **Use your own server:** point `pipelex.api.baseUrl` at a self-hosted Pipelex API server, version 0.90.0 or later, such as `http://localhost:8081`. The server is the [`api/` member of the pipelex repository](https://github.com/Pipelex/pipelex/tree/main/api), published as the `pipelex/pipelex-api` Docker image.
- **Validate locally:** set `pipelex.backend` to `cli` to validate with a local `pipelex-agent`, from pipelex 0.90.0 or later, so nothing leaves your machine.

### Usage statistics

The extension sends anonymous usage statistics: once a day that it was activated, and how many times its graph preview, validation, run and formatting were used, with the editor and extension versions. It never sends your methods, prompts, inputs, outputs, file names or pipe names. The first activation says so once:

> Pipelex collects anonymous usage statistics: counts of commands, runs, pipe types, models and tokens, and the country your IP address maps to; the address itself is never stored. It never collects your methods, prompts, inputs, outputs, file names or pipe names. To turn it off, run `Pipelex: Disable Usage Statistics` or set DO_NOT_TRACK=1. Details: https://docs.pipelex.com/latest/setup/usage-statistics/

VS Code's own telemetry setting (`telemetry.telemetryLevel`) governs them, and so do `DO_NOT_TRACK=1`, `PIPELEX_USAGE_STATS=0`, `[usage_stats] enabled = false` in a project's `.pipelex/pipelex.toml`, and `plxt usage-stats disable`, which turns them off for every Pipelex tool on the machine. The tools the extension starts, such as `pipelex-agent`, send none of their own.

## 📦 Installation

1. **Extensions marketplace** — Search for "Pipelex" in the Extensions view
2. **Command line** — `code --install-extension Pipelex.pipelex` or `cursor --install-extension Pipelex.pipelex`
3. **Manual** — Download `.vsix` from [releases](https://github.com/Pipelex/vscode-pipelex/releases)

Then, to validate your methods, get an API key at [app.pipelex.com](https://app.pipelex.com/) and store it with the **Pipelex: Set Hosted API Key** command. The key is kept in VS Code's secret storage. When no key is stored, the extension uses the `PIPELEX_API_KEY` environment variable if it is set.

The extension does not read the key that `pipelex login` (or `pipelex init` with the hosted API) saves in `~/.pipelex/.env`, or in the `.env` of `PIPELEX_HOME` when that is set. If you signed in from the terminal, give the extension a key with the **Pipelex: Set Hosted API Key** command, or export `PIPELEX_API_KEY` in a shell before starting VS Code from it (`code .`). `pipelex login` does not print its key, so create another one at [app.pipelex.com](https://app.pipelex.com/) or copy the value from that file.

---

"Pipelex" is a trademark of Evotis S.A.S.
