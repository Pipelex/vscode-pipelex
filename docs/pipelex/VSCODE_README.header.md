<div align="center"><img src="https://d2cinlfp2qnig1.cloudfront.net/banners/pipelex_vs_code_extension_v1.png" alt="Pipelex VS Code extension banner" width="800" style="max-width: 100%; height: auto;"></div>

# Pipelex VS Code Extension

**Rich language support for Pipelex Markup Language (PML) and TOML files**

This extension provides comprehensive VS Code support for the **Pipelex Markup Language (PML)**, which is based on TOML syntax, along with full TOML language support. Built as a fork of the excellent [Taplo](https://github.com/tamasfe/taplo) language server, it tracks upstream closely while adding PML-specific features like advanced syntax highlighting, semantic tokens, and intelligent language features for `.pml` files.

**About Pipelex:**

[Pipelex](https://github.com/Pipelex/pipelex) is an open-source language for building deterministic AI workflows. It enables agents and developers to transform natural language requirements into production-ready pipelines that process information reliably at scale. Unlike traditional workflow tools, Pipelex uses a declarative syntax that captures business logic directly, making pipelines readable by domain experts while remaining executable by any runtime. Write once, run anywhere, share with everyone.

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
definition = "Analyzes a user's natural language query"
inputs = { query = "UserQuery" }
output = "QueryAnalysis"
prompt_template = """
Analyze this user query: $query
Extract the key information and intent.
"""
```

## 📦 **Installation**
1. **From extensions marketplace**: Search for "Pipelex" in the Extensions view
2. **From Command Line**: `code --install-extension Pipelex.pipelex` or `cursor --install-extension Pipelex.pipelex`
3. **Manual Installation**: Download `.vsix` from [releases](https://github.com/Pipelex/vscode-pipelex/releases)

---

## Original Taplo VS Code README (kept in sync)

Everything below is the original Taplo README, kept in sync with upstream for your reference.
