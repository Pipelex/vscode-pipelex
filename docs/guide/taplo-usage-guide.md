# Taplo Usage Guide for External Repos

How to use Taplo to lint and format `.toml` and `.mthds` files in your projects.

## Architecture Overview

The **Pipelex VS Code extension** is a fork of [Taplo](https://github.com/tamasfe/taplo), a TOML toolkit written in Rust. On top of Taplo's TOML support, it adds an MTHDS syntax-coloring and semantic-token layer for the Pipelex language.

There are three ways to use Taplo:

| Method | Use case |
|--------|----------|
| **VS Code extension** (bundled LSP) | Editor experience: diagnostics, formatting, completions, hover |
| **Standalone CLI** | CI checks, scripting, pre-commit hooks |
| **LSP protocol** | Any editor (Neovim, Helix, Zed, etc.) via `taplo lsp` |

---

## Installation Methods

### VS Code Extension (already installed)

The Pipelex extension bundles its own JavaScript-based LSP — no extra install needed. It communicates with VS Code via Node IPC.

### CLI via Cargo

```sh
cargo install taplo-cli --features lsp
```

The `--features lsp` flag includes the language server subcommand. Omit it if you only need `fmt` and `lint`.

### CLI via npm

```sh
npx @taplo/cli fmt .
npx @taplo/cli lint .
```

### CLI via pip

```sh
pip install taplo
```

This PyPI package wraps the Rust binary.

### CLI via Homebrew

```sh
brew install taplo
```

### CLI Commands at a Glance

| Command | Aliases | Description |
|---------|---------|-------------|
| `taplo fmt` | `taplo format` | Format TOML files in-place |
| `taplo lint` | `taplo check`, `taplo validate` | Lint/validate TOML files |
| `taplo get` | — | Extract a value from a TOML document |
| `taplo lsp` | — | Start the language server (stdio or tcp) |
| `taplo config default` | `taplo cfg default` | Print a default `.taplo.toml` |
| `taplo config schema` | `taplo cfg schema` | Print JSON schema for `.taplo.toml` |

---

## The Language Server (LSP)

### Bundled LSP (default)

The VS Code extension ships with a JavaScript-based LSP (`@pipelex/lsp`) that runs automatically via Node IPC. No configuration required.

The LSP provides:
- **Diagnostics** — syntax errors, DOM validation, schema validation
- **Formatting** — on save, on demand, range formatting
- **Completion** — key names, values, schema-driven suggestions
- **Hover** — schema descriptions for keys and values
- **Rename** — rename keys across the document
- **Semantic tokens** — syntax-aware highlighting

### External LSP

To use a standalone `taplo` binary as the language server instead of the bundled one:

1. Set `pipelex.server.bundled` to `false`
2. Either:
   - Set `pipelex.server.path` to the absolute path of your `taplo` binary, **or**
   - Ensure `taplo` is on your `PATH`

### LSP for Other Editors

```sh
# stdio mode (Neovim, Helix, etc.)
taplo lsp stdio

# TCP mode (default: 0.0.0.0:9181)
taplo lsp tcp
taplo lsp tcp --address 127.0.0.1:9999
```

---

## Configuration: Where to Put Settings

### Config File Discovery

Taplo automatically looks for a config file at your project root:

- `.taplo.toml` (preferred)
- `taplo.toml`

You can override this with:

| Method | Example |
|--------|---------|
| CLI flag | `taplo fmt --config path/to/.taplo.toml` |
| Environment variable | `TAPLO_CONFIG=path/to/.taplo.toml` |
| VS Code setting | `pipelex.server.configFile.path` (absolute or workspace-relative) |

Set `pipelex.server.configFile.enabled` to `false` to disable config file usage entirely.

### Annotated Example `.taplo.toml`

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
| `[[rule]].name` | Optional name, usable in `taplo::<name>` comments |
| `[rule.formatting]` | Formatting overrides for this rule |
| `[rule.options.schema]` | Schema association for this rule |

---

## Formatting Options Reference

All options are available in both `.taplo.toml` (snake_case) and VS Code settings (camelCase with `pipelex.formatter.` prefix).

| `.taplo.toml` key | VS Code setting | Type | Default | Description |
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

Taplo supports JSON Schema validation for TOML files. There are three ways to associate a schema with your files:

### 1. In `.taplo.toml` (recommended for repos)

```toml
[[rule]]
include = ["**/*.mthds"]

[rule.options.schema]
# Local path (relative to project root):
path = "./schemas/mthds-schema.json"

# Or an absolute URL:
# url = "https://example.com/mthds-schema.json"
```

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

Currently, no MTHDS JSON Schema exists in this repo. The MTHDS layer provides **syntax coloring and semantic tokens only**, not structural validation. Creating a JSON Schema for MTHDS would be a separate effort. If you create one, place it in a `schemas/` directory and reference it from `.taplo.toml` as shown above.

---

## CLI Usage in CI / Pre-commit

### Formatting Check

```sh
# Dry-run: exits non-zero if any file is not correctly formatted
taplo fmt --check

# With diff output (shows what would change)
taplo fmt --check --diff

# With explicit config
taplo fmt --check --config .taplo.toml
```

### Linting / Validation

```sh
# Basic lint (syntax + structure)
taplo lint

# Lint with schema validation
taplo lint --schema https://example.com/schema.json

# Lint using default schema catalogs (Schema Store)
taplo lint --default-schema-catalogs

# Disable schema validation
taplo lint --no-schema
```

### GitHub Actions Example

```yaml
name: TOML
on: [push, pull_request]

jobs:
  toml-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Taplo
        run: |
          curl -fsSL https://github.com/tamasfe/taplo/releases/latest/download/taplo-full-linux-x86_64.gz \
            | gzip -d > /usr/local/bin/taplo
          chmod +x /usr/local/bin/taplo

      - name: Check formatting
        run: taplo fmt --check --diff

      - name: Lint
        run: taplo lint
```

### Pre-commit Hook

Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/ComPWA/taplo-pre-commit
    rev: v0.9.3
    hooks:
      - id: taplo-format
      - id: taplo-lint
```

Or as a simple git hook (`.git/hooks/pre-commit`):

```sh
#!/bin/sh
taplo fmt --check --diff || {
  echo "TOML formatting check failed. Run 'taplo fmt' to fix."
  exit 1
}
```

---

## VS Code Settings Quick Reference

Beyond formatting (covered above), these settings control the extension behavior:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `pipelex.server.bundled` | bool | `true` | Use the bundled LSP |
| `pipelex.server.path` | string | `null` | Absolute path to external `taplo` binary |
| `pipelex.server.extraArgs` | string[] | `[]` | Additional args for external LSP |
| `pipelex.server.environment` | object | `{}` | Environment variables for the LSP |
| `pipelex.server.configFile.path` | string | `null` | Path to `.taplo.toml` |
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
| `pipelex.rules` | array | `[]` | Additional Taplo rules in JSON format |
