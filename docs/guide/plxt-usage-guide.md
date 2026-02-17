# Pipelex Tools Guide

How to use the Pipelex toolchain to lint and format `.mthds` and `.toml` files in your projects.

## Overview

The Pipelex toolchain provides formatting, linting, and language-server support for `.mthds` and `.toml` files. It is built on the [Taplo](https://github.com/tamasfe/taplo) TOML toolkit.

| Method | Use case |
|--------|----------|
| **VS Code extension** (bundled LSP) | Editor experience: diagnostics, formatting, completions, hover |
| **`plxt` CLI** | CI checks, scripting, pre-commit hooks |
| **LSP protocol** | Any editor (Neovim, Helix, Zed, etc.) via `plxt lsp` |

---

## Installation

### CLI via pip (recommended)

```sh
pip install pipelex-tools
# or
uv add pipelex-tools
```

This installs the `plxt` binary.

### VS Code Extension

The Pipelex extension bundles its own WASM-based LSP — no extra install needed.

```sh
code --install-extension Pipelex.pipelex
# or
cursor --install-extension Pipelex.pipelex
```

### CLI Commands at a Glance

| Command | Aliases | Description |
|---------|---------|-------------|
| `plxt fmt` | `plxt format` | Format TOML and MTHDS files in-place |
| `plxt lint` | `plxt check`, `plxt validate` | Lint/validate TOML and MTHDS files |
| `plxt get` | — | Extract a value from a TOML document |
| `plxt lsp` | — | Start the language server (stdio or tcp) |
| `plxt config default` | `plxt cfg default` | Print a default config file |
| `plxt config schema` | `plxt cfg schema` | Print JSON schema for the config file |
| `plxt completions` | — | Generate shell completions |

---

## The Language Server (LSP)

### Bundled LSP (default)

The VS Code extension ships with a WASM-based LSP (`@pipelex/lsp`) that runs automatically via Node IPC. No configuration required.

The LSP provides:
- **Diagnostics** — syntax errors, DOM validation, schema validation
- **Formatting** — on save, on demand, range formatting
- **Completion** — key names, values, schema-driven suggestions
- **Hover** — schema descriptions for keys and values
- **Rename** — rename keys across the document
- **Semantic tokens** — syntax-aware highlighting

### External LSP

To use the native `plxt` binary as the language server instead of the bundled one:

1. Set `pipelex.server.bundled` to `false`
2. Either:
   - Set `pipelex.server.path` to the absolute path of your `plxt` binary, **or**
   - Ensure `plxt` is on your `PATH`

### LSP for Other Editors

```sh
# stdio mode (Neovim, Helix, etc.)
plxt lsp stdio

# TCP mode (default: 0.0.0.0:9181)
plxt lsp tcp
plxt lsp tcp --address 127.0.0.1:9999
```

---

## Configuration

### Config File Discovery

`plxt` searches for a config file in this order:

1. `.pipelex/plxt.toml` (preferred)
2. `plxt.toml`
3. `.taplo.toml` (fallback)
4. `taplo.toml`

You can override this with:

| Method | Example |
|--------|---------|
| CLI flag | `plxt fmt --config path/to/plxt.toml` |
| VS Code setting | `pipelex.server.configFile.path` (absolute or workspace-relative) |

Set `pipelex.server.configFile.enabled` to `false` to disable config file usage entirely.

### Annotated Example `plxt.toml`

Based on how this repository dogfoods its own config:

```toml
# Glob patterns for files to process (default: "**/*.toml")
include = ["**/*.toml", "**/*.mthds"]

# Glob patterns to exclude (takes priority over include)
exclude = [
  "**/node_modules/**",
  "target",
]

# Global formatting options (apply to all matched files)
[formatting]
align_entries = true
column_width  = 100

# ── Per-file rules ────────────────────────────────────────
# Rules are evaluated in order; later rules override earlier ones.

# Rule 1: Cargo.toml — keep arrays compact
[[rule]]
include = ["**/Cargo.toml"]

[rule.formatting]
array_auto_expand   = false
inline_table_expand = false

# Rule 2: Cargo.toml dependencies — sort keys, align comments
[[rule]]
include = ["**/Cargo.toml"]
keys    = ["dependencies", "*-dependencies", "workspace"]

[rule.formatting]
reorder_keys   = true
align_comments = true

# Rule 3: Cargo.toml features — sort array values
[[rule]]
include = ["**/Cargo.toml"]
keys    = ["features"]

[rule.formatting]
reorder_arrays = true

# ── Schema validation ─────────────────────────────────────

# Rule 4: Validate MTHDS files against a local schema
[[rule]]
include = ["**/*.mthds"]

[rule.options.schema]
path = "./schemas/mthds-schema.json"
# Or use a URL:
# url = "https://example.com/mthds-schema.json"
```

### Config File Sections Reference

| Section | Purpose |
|---------|---------|
| `include` | Glob patterns for files to process |
| `exclude` | Glob patterns to skip (overrides `include`) |
| `[formatting]` | Global formatting options |
| `[[rule]]` | A formatting/schema rule scoped to specific files/keys |
| `[[rule]].include` | Glob patterns this rule applies to |
| `[[rule]].exclude` | Glob patterns this rule skips |
| `[[rule]].keys` | Dotted key patterns (e.g., `"dependencies"`, `"package.*"`) |
| `[[rule]].name` | Optional name, usable in `plxt::<name>` comments |
| `[rule.formatting]` | Formatting overrides for this rule |
| `[rule.options.schema]` | Schema association for this rule |

---

## Formatting Options Reference

All options are available in both `plxt.toml` (snake_case) and VS Code settings (camelCase with `pipelex.formatter.` prefix).

| `plxt.toml` key | VS Code setting | Type | Default | Description |
|--------------------|-----------------|------|---------|-------------|
| `align_entries` | `pipelex.formatter.alignEntries` | bool | `false` | Align entries vertically |
| `align_comments` | `pipelex.formatter.alignComments` | bool | `true` | Align consecutive comments after entries |
| `array_trailing_comma` | `pipelex.formatter.arrayTrailingComma` | bool | `true` | Trailing commas for multiline arrays |
| `array_auto_expand` | `pipelex.formatter.arrayAutoExpand` | bool | `true` | Auto-expand arrays exceeding `column_width` |
| `array_auto_collapse` | `pipelex.formatter.arrayAutoCollapse` | bool | `true` | Auto-collapse arrays fitting on one line |
| `inline_table_expand` | `pipelex.formatter.inlineTableExpand` | bool | `true` | Expand values inside inline tables |
| `compact_arrays` | `pipelex.formatter.compactArrays` | bool | `true` | Omit whitespace padding in single-line arrays |
| `compact_inline_tables` | `pipelex.formatter.compactInlineTables` | bool | `false` | Omit whitespace padding in inline tables |
| `compact_entries` | `pipelex.formatter.compactEntries` | bool | `false` | Omit whitespace around `=` |
| `column_width` | `pipelex.formatter.columnWidth` | int | `80` | Target max column width for array expansion |
| `indent_tables` | `pipelex.formatter.indentTables` | bool | `false` | Indent subtables if they come in order |
| `indent_entries` | `pipelex.formatter.indentEntries` | bool | `false` | Indent entries under tables |
| `indent_string` | `pipelex.formatter.indentString` | string | `"  "` | Indentation string (tabs or spaces) |
| `trailing_newline` | `pipelex.formatter.trailingNewline` | bool | `true` | Add trailing newline to file |
| `reorder_keys` | `pipelex.formatter.reorderKeys` | bool | `false` | Alphabetically reorder keys |
| `reorder_arrays` | `pipelex.formatter.reorderArrays` | bool | `false` | Alphabetically reorder array values |
| `reorder_inline_tables` | `pipelex.formatter.reorderInlineTables` | bool | `false` | Alphabetically reorder inline tables |
| `allowed_blank_lines` | `pipelex.formatter.allowedBlankLines` | int | `2` | Max consecutive blank lines |
| `crlf` | `pipelex.formatter.crlf` | bool | `false` | Use CRLF line endings |

---

## Schema Validation for MTHDS Files

`plxt` supports JSON Schema validation for TOML and MTHDS files. There are three ways to associate a schema with your files:

### 1. In `plxt.toml` (recommended for repos)

```toml
[[rule]]
include = ["**/*.mthds"]

[rule.options.schema]
# Local path (relative to project root):
path = "./schemas/mthds-schema.json"

# Or an absolute URL:
# url = "https://example.com/mthds-schema.json"
```

Schema authors can use the `x-plxt` extension key to embed Pipelex-specific metadata (docs, links, init keys) directly in JSON Schema files. When both `x-plxt` and `x-taplo` are present, `x-plxt` takes priority.

### 2. In VS Code settings

```jsonc
{
  "pipelex.schema.associations": {
    // Regex pattern → schema URL
    ".+\\.mthds$": "file:///absolute/path/to/mthds-schema.json"
  }
}
```

The key is a **regular expression** matched against the absolute document URI. The value must be an absolute URI to the JSON schema.

### 3. In the TOML file itself

**Using the `#:schema` directive** (first comment in the file):

```toml
#:schema https://example.com/mthds-schema.json

[section]
key = "value"
```

**Using a `$schema` key** at the document root:

```toml
"$schema" = "https://example.com/mthds-schema.json"

[section]
key = "value"
```

Both support absolute URLs, and the `#:schema` directive also supports relative file paths.

### Schema Catalogs

The extension uses the [JSON Schema Store](https://www.schemastore.org/) catalog by default. You can add more catalogs via:

```jsonc
{
  "pipelex.schema.catalogs": [
    "https://json.schemastore.org/api/json/catalog.json",
    "https://your-org.example.com/schema-catalog.json"
  ]
}
```

### Note on MTHDS Schemas

Currently, no MTHDS JSON Schema exists in this repo. The MTHDS layer provides **syntax coloring and semantic tokens only**, not structural validation. Creating a JSON Schema for MTHDS would be a separate effort. If you create one, place it in a `schemas/` directory and reference it from your `plxt.toml` as shown above.

---

## CLI Usage in CI / Pre-commit

### Formatting Check

```sh
# Dry-run: exits non-zero if any file is not correctly formatted
plxt fmt --check

# With diff output (shows what would change)
plxt fmt --check --diff

# With explicit config
plxt fmt --check --config plxt.toml
```

### Linting / Validation

```sh
# Basic lint (syntax + structure)
plxt lint

# Lint with schema validation
plxt lint --schema https://example.com/schema.json

# Lint using default schema catalogs (Schema Store)
plxt lint --default-schema-catalogs

# Disable schema validation
plxt lint --no-schema
```

### GitHub Actions Example

```yaml
name: TOML & MTHDS
on: [push, pull_request]

jobs:
  toml-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install plxt
        run: pip install pipelex-tools

      - name: Check formatting
        run: plxt fmt --check --diff

      - name: Lint
        run: plxt lint
```

### Pre-commit Hook

As a simple git hook (`.git/hooks/pre-commit`):

```sh
#!/bin/sh
plxt fmt --check --diff || {
  echo "Formatting check failed. Run 'plxt fmt' to fix."
  exit 1
}
```

---

## VS Code Settings Quick Reference

Beyond formatting (covered above), these settings control the extension behavior:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `pipelex.server.bundled` | bool | `true` | Use the bundled LSP |
| `pipelex.server.path` | string | `null` | Absolute path to external `plxt` binary |
| `pipelex.server.extraArgs` | string[] | `[]` | Additional args for external LSP |
| `pipelex.server.environment` | object | `{}` | Environment variables for the LSP |
| `pipelex.server.configFile.path` | string | `null` | Path to config file |
| `pipelex.server.configFile.enabled` | bool | `true` | Enable config file usage |
| `pipelex.schema.enabled` | bool | `true` | Enable JSON Schema validation |
| `pipelex.schema.links` | bool | `false` | Show clickable links for keys |
| `pipelex.schema.associations` | object | `{}` | Regex → schema URL mappings |
| `pipelex.schema.catalogs` | string[] | `["https://json.schemastore.org/..."]` | Schema catalog URLs |
| `pipelex.schema.cache.memoryExpiration` | int | `60` | Schema memory cache TTL (seconds) |
| `pipelex.schema.cache.diskExpiration` | int | `600` | Schema disk cache TTL (seconds) |
| `pipelex.semanticTokens` | bool | `false` | Semantic tokens for inline tables/arrays |
| `pipelex.syntax.semanticTokens` | bool | `true` | Semantic tokens for tables and arrays |
| `pipelex.mthds.semanticTokens` | bool | `true` | MTHDS-specific semantic tokens |
| `pipelex.completion.maxKeys` | int | `5` | Max dotted-key segments in completions |
| `pipelex.rules` | array | `[]` | Additional rules in JSON format |
