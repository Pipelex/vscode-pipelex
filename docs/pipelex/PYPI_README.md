# pipelex-tools

CLI for formatting, linting, and language-server support for MTHDS and TOML files.

> **What is MTHDS?** — An open standard for defining AI methods as typed, composable, human-readable files. A `.mthds` file describes what an AI should do — its inputs, outputs, logic, and data types — in plain TOML that both people and machines can read. [Pipelex](https://github.com/Pipelex/pipelex) is the runtime that executes them. Learn more at [docs.pipelex.com](https://docs.pipelex.com).

## Installation

```bash
pip install pipelex-tools
```

```bash
uv add pipelex-tools
```

```bash
pipx install pipelex-tools
```

## Commands

| Command | Description |
|---------|-------------|
| `plxt format` (alias `fmt`) | Format TOML and MTHDS documents |
| `plxt lint` (aliases `check`, `validate`) | Lint TOML and MTHDS documents |
| `plxt lsp stdio` | Start the language server (stdio transport) |
| `plxt get` | Extract a value from a TOML document |
| `plxt config default` | Print the default configuration file |
| `plxt config schema` | Print the JSON schema of the configuration file |
| `plxt completions <shell>` | Generate shell completions |

## Configuration

`plxt` discovers configuration in this order:

1. `.pipelex/plxt.toml` (preferred)
2. `plxt.toml`
3. `.taplo.toml` (fallback)

## MTHDS Example

<img src="https://d2cinlfp2qnig1.cloudfront.net/images/mthds-sample-code.png" alt="MTHDS sample code" width="800" style="max-width: 100%; height: auto;">

See the [MTHDS language reference](https://docs.pipelex.com) for the full standard.

## VS Code / Cursor Extension

For rich editor support (syntax highlighting, semantic tokens, formatting, completions, schema validation), install the [Pipelex extension](https://marketplace.visualstudio.com/items?itemName=Pipelex.pipelex) for VS Code or Cursor.

## Links

- [GitHub](https://github.com/Pipelex/vscode-pipelex)
- [Documentation](https://docs.pipelex.com)
- [Issues](https://github.com/Pipelex/vscode-pipelex/issues)

---

TOML support built on [Taplo](https://github.com/tamasfe/taplo).

"Pipelex" is a trademark of Evotis S.A.S.
