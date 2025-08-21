<div style="text-align:left"><img src="pipelex-icon.png" width="128"></div>

[![Build Status](https://github.com/PipelexLab/vscode-pipelex/workflows/CI/badge.svg)](https://github.com/PipelexLab/vscode-pipelex/actions)

# vscode-pipelex (Taplo fork)

This fork adds **Pipelex Markup Language (PML)** support while tracking Taplo upstream closely.

## What's different here
- **PML language support**: Rich syntax highlighting, semantic tokens, and language features for `.pml` files
- **Concept definitions**: `[concept.Name]` sections with specialized highlighting  
- **Pipe definitions**: `[pipe.name]` sections for workflow steps
- **Data injection**: `@variable` syntax with smart highlighting
- **Template variables**: `$variable` support with Jinja2 templates
- **All Taplo features retained**: Complete TOML 1.0.0 support and tooling

## Where to file issues
- **Taplo behavior/bugs** → [upstream Taplo project](https://github.com/tamasfe/taplo)
- **PML-specific issues** → [this repository](https://github.com/PipelexLab/vscode-pipelex/issues)

## Quick Start with PML
```toml
# example.pml - Pipelex workflow definition
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

---

## Original Taplo README (kept in sync)
