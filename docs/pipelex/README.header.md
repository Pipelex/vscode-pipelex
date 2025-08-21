<div align="center"><img src="https://d2cinlfp2qnig1.cloudfront.net/banners/pipelex_vs_code_extension_v1.png" alt="Pipelex VS Code extension banner" width="800" style="max-width: 100%; height: auto;"></div>

# vscode-pipelex

This repo provides VS Code support for the **Pipelex Markup Language (PML)** which is based on TOML syntax. The repo is a fork of [Taplo](https://github.com/tamasfe/taplo) and it tracks Taplo upstream closely.

**About Pipelex:**

[Pipelex](https://github.com/Pipelex/pipelex) is an open-source language for building deterministic AI workflows. It enables agents and developers to transform natural language requirements into production-ready pipelines that process information reliably at scale. Unlike traditional workflow tools, Pipelex uses a declarative syntax that captures business logic directly, making pipelines readable by domain experts while remaining executable by any runtime. Write once, run anywhere, share with everyone.

## What we offer in addition to Taplo
- **PML language support**: Rich syntax highlighting, semantic tokens, and language features for `.pml` files
- **Concept definitions**: `[concept.Name]` sections with specialized highlighting  
- **Pipe definitions**: `[pipe.name]` sections for workflow steps
- **Data injection**: `@variable` syntax with smart highlighting
- **Template variables**: `$variable` support with Jinja2 templates
- **All Taplo features retained**: Complete TOML 1.0.0 support and tooling

## Where to file issues
- **Taplo behavior/bugs** → [upstream Taplo project](https://github.com/tamasfe/taplo)
- **PML-specific issues** → [this repository](https://github.com/Pipelex/vscode-pipelex/issues)

## Quick Start with PML
```toml
# example.pml - Pipelex workflow definition
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

---

## Original Taplo README (kept in sync)
