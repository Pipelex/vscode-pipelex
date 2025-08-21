# Pipelex VS Code Extension

**Rich language support for Pipelex Markup Language (PML) and TOML files**

This is the **Taplo** extension enhanced with **Pipelex Markup Language (PML)** support. It provides comprehensive language support for both PML files (`.pml`) and TOML files (`.toml`), featuring advanced syntax highlighting, semantic tokens, and intelligent language features.

![Pipelex Logo](pipelex-icon.png)

## 🚀 **PML Features**

### 📝 **Pipelex Markup Language Support**
- **Rich syntax highlighting** for PML-specific constructs
- **Concept definitions**: `[concept.Name]` sections with specialized highlighting  
- **Pipe definitions**: `[pipe.name]` sections for workflow steps
- **Data injection**: `@variable` syntax with smart highlighting
- **Template variables**: `$variable` support
- **Jinja2 templates**: `{{ }}` and `{% %}` blocks with keyword highlighting
- **HTML templates**: Basic HTML tag support within strings
- **Semantic tokens** for context-aware highlighting

### 🎨 **PML Syntax Highlighting**
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
Analyze this user query: @query
Extract the key information and intent.
"""
```

## 📦 **Installation**
1. **From VS Code Marketplace**: Search for "Pipelex" in the Extensions view
2. **From Command Line**: `code --install-extension Pipelex.pipelex`
3. **Manual Installation**: Download `.vsix` from [releases](https://github.com/PipelexLab/vscode-pipelex/releases)

---

## Original Taplo VS Code README (kept in sync)

Everything below is the original Taplo README, kept in sync with upstream for your reference.
