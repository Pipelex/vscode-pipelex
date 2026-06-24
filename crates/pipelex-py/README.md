# pipelex-tools-py

Python bindings for Pipelex Tools. This package installs the importable
`pipelex_tools` module for formatting and linting MTHDS content in-process,
without shelling out to the `plxt` CLI.

> **What is MTHDS?** MTHDS is an open standard for defining AI methods as
> typed, composable, human-readable TOML files. A `.mthds` file describes what
> an AI should do: its inputs, outputs, logic, and data types. Pipelex is the
> runtime that executes them.

## Installation

```bash
pip install pipelex-tools-py
```

```bash
uv add pipelex-tools-py
```

## Usage

```python
import pipelex_tools

formatted = pipelex_tools.format_mthds("a=1")
print(formatted["formatted"])
# a = 1

linted = pipelex_tools.lint_mthds("""
domain = "example"

[concept]

[pipe]
""")
print(linted["diagnostics"])
```

## API

`format_mthds(content: str, *, options: dict | None = None) -> dict`

Returns:

```python
{
    "formatted": str,
    "changed": bool,
    "diagnostics": list[dict],
}
```

`lint_mthds(content: str, *, source: str | None = None) -> dict`

Returns:

```python
{
    "diagnostics": list[dict],
}
```

Diagnostics use this shape:

```python
{
    "kind": "syntax" | "semantic" | "schema",
    "severity": "error",
    "message": str,
    "location": str | None,
    "range": {
        "start_offset": int,
        "end_offset": int,
        "start_line": int,
        "start_col": int,
        "end_line": int,
        "end_col": int,
    } | None,
}
```

Malformed MTHDS content is returned as diagnostics, not raised as an exception.
Malformed formatter option values may raise `ValueError`.

## CLI package

This is the Python library package. To install the `plxt` command-line tool,
use the separate `pipelex-tools` package:

```bash
uv tool install pipelex-tools
```

## Links

- [GitHub](https://github.com/Pipelex/vscode-pipelex)
- [Documentation](https://docs.pipelex.com)
- [Issues](https://github.com/Pipelex/vscode-pipelex/issues)

TOML support built on [Taplo](https://github.com/tamasfe/taplo).

"Pipelex" is a trademark of Evotis S.A.S.
