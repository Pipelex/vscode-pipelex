<div align="center"><img src="https://d2cinlfp2qnig1.cloudfront.net/banners/pipelex_vs_code_extension_v1.png" alt="Pipelex VS Code extension banner" width="800" style="max-width: 100%; height: auto;"></div>

# vscode-pipelex

The reference toolchain for the MTHDS open standard — editing, formatting, linting, and language-server support for `.mthds` and `.toml` files. Built on a [Taplo](https://github.com/tamasfe/taplo) fork. Ships a **VS Code / Cursor extension**, the **`plxt` CLI**, and the **`pipelex-tools` PyPI package**.

> **What is MTHDS?** — An open standard for defining AI methods as typed, composable, human-readable files. A `.mthds` file describes what an AI should do — its inputs, outputs, logic, and data types — in plain TOML that both people and machines can read. [Pipelex](https://github.com/Pipelex/pipelex) is the runtime that executes them. Learn more at [docs.pipelex.com](https://docs.pipelex.com).

## `plxt` CLI

The Pipelex CLI for formatting and linting MTHDS and TOML files. Install via PyPI:

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

## Features

- **MTHDS language support**: Rich syntax highlighting, semantic tokens, and language features for `.mthds` files
- **Concept definitions**: `[concept.Name]` sections with specialized highlighting
- **Pipe definitions**: `[pipe.name]` sections for method steps
- **Jinja2 template syntax**: Colorized highlighting for Jinja2 expressions in prompt fields
- **Template variables**: `@variable` and `$variable` syntax for inserting data into Jinja2 templates
- **Pipelex config discovery**: `.pipelex/plxt.toml` or `plxt.toml`
- **Complete TOML 1.0.0 support and tooling**

## Where to file issues

File all issues at [this repository](https://github.com/Pipelex/vscode-pipelex/issues).

## MTHDS Example

<img src="https://d2cinlfp2qnig1.cloudfront.net/images/mthds-sample-code.png" alt="MTHDS sample code" width="800" style="max-width: 100%; height: auto;">

See the [MTHDS language reference](https://docs.pipelex.com) for the full standard.

---

"Pipelex" is a trademark of Evotis S.A.S.

---

## Original Taplo README
