# Pipelex VS Code Extension

**Rich language support for Pipelex Markup Language (PML) and TOML files**

The Pipelex extension provides comprehensive language support for both PML files (`.pml`) and TOML files (`.toml`), featuring advanced syntax highlighting, semantic tokens, and intelligent language features powered by the Taplo language server.

![Pipelex Logo](https://raw.githubusercontent.com/Pipelex/pipelex/main/.github/assets/logo.png)

---

## 🚀 Features

### 📝 **Pipelex Markup Language (PML) Support**
- **Rich syntax highlighting** for PML-specific constructs
- **Concept definitions**: `[concept.Name]` sections with specialized highlighting  
- **Pipe definitions**: `[pipe.name]` sections for workflow steps
- **Data injection**: `@variable` syntax with smart highlighting
- **Template variables**: `$variable` support
- **Jinja2 templates**: `{{ }}` and `{% %}` blocks with keyword highlighting
- **HTML templates**: Basic HTML tag support within strings
- **Semantic tokens** for context-aware highlighting

### 🔧 **TOML Support**
- **Full TOML 1.0.0 support** - Complete compatibility with the TOML specification
- **Syntax highlighting** with TextMate grammar
- **Validation** with error detection and reporting
- **Formatting** with customizable options
- **Symbol navigation** and document outline
- **Folding** for better code organization

### ⚡ **Smart Language Features**
- **Auto-completion** for keys and values
- **JSON Schema validation** for structured configuration
- **Document symbols** and navigation
- **Hover information** and inline documentation
- **Format on save** with customizable rules
- **Error highlighting** and diagnostics

---

## 🎨 **PML Syntax Highlighting**

The extension provides rich, context-aware highlighting for PML files:

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
inputs = { query = "UserQuery" }
output = "QueryAnalysis"
prompt_template = """
Analyze this user query:

@query

Extract the key information and intent.
"""
```

---

## 📦 **Installation**

1. **From VS Code Marketplace**: Search for "Pipelex" in the Extensions view
2. **From Command Line**: `code --install-extension Pipelex.pipelex`
3. **Manual Installation**: Download `.vsix` from [releases](https://github.com/Pipelex/vscode-pipelex/releases)

---

## ⚙️ **Configuration**

The extension can be configured through VS Code settings:

### Language Server Settings
```json
{
  "pipelex.server.bundled": true,
  "pipelex.server.path": null,
  "pipelex.server.environment": {},
  "pipelex.server.extraArgs": []
}
```

### Schema and Validation
```json
{
  "pipelex.schema.enabled": true,
  "pipelex.schema.links": false,
  "pipelex.schema.associations": {}
}
```

### Formatting Options
```json
{
  "pipelex.formatter.alignEntries": false,
  "pipelex.formatter.alignComments": false,
  "pipelex.formatter.arrayTrailingComma": true,
  "pipelex.formatter.columnWidth": 80,
  "pipelex.formatter.indentTables": false
}
```

---

## 🎯 **File Associations**

The extension automatically recognizes:
- **`.pml`** files - Pipelex Markup Language
- **`.toml`** files - TOML configuration files
- **Special files**: `Cargo.lock`, `uv.lock`

---

## 🔗 **Commands**

Access these commands through the Command Palette (`Ctrl+Shift+P`):

- **TOML: Select Schema** - Choose JSON schema for validation
- **TOML: Copy as JSON** - Convert TOML selection to JSON
- **TOML: Copy as TOML** - Format TOML selection  
- **TOML: Paste as JSON** - Convert clipboard TOML to JSON
- **TOML: Paste as TOML** - Convert clipboard JSON to TOML

---

## 🛠️ **Development**

### Building from Source
```bash
git clone https://github.com/Pipelex/vscode-pipelex.git
cd vscode-pipelex/editors/vscode
yarn install
yarn build
```

### Contributing
We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

---

## 📄 **License**

This project is licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.

---

## 🙏 **Acknowledgments**

This extension is built on top of the excellent [Taplo](https://taplo.tamasfe.dev) language server, providing robust TOML language support. Special thanks to the Taplo team for their foundational work.

---

## 🐛 **Issues & Support**

- **Bug Reports**: [GitHub Issues](https://github.com/Pipelex/vscode-pipelex/issues)
- **Feature Requests**: [GitHub Discussions](https://github.com/Pipelex/vscode-pipelex/discussions)
- **Documentation**: [Pipelex Docs](https://docs.pipelex.com)

---

**Made with ❤️ by the Pipelex team**