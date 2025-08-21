<!-- GENERATED: do not edit CONTRIBUTING.md directly.
     Edit docs/pipelex/CONTRIBUTING.header.md and run scripts/compose-docs.sh -->

# Contributing to vscode-pipelex

Please read the upstream Taplo guidelines below. Here are the key differences for this fork:

## PML-specific contributions
- **PML grammar/schemas**: Located in `editors/vscode/src/pipelex/` - PRs welcome
- **Language features**: Semantic tokens, syntax highlighting for PML constructs
- **VS Code integration**: PML-specific commands and configuration

## Contribution workflow
1. **For Taplo core/editor behavior**: Consider contributing to [upstream Taplo](https://github.com/tamasfe/taplo) first
2. **For PML-specific features**: Contribute directly to this repository
3. **For bugs**: Check if it's Taplo-related (upstream) or PML-specific (here)

## Development setup
```bash
# Clone and setup
git clone https://github.com/PipelexLab/vscode-pipelex.git
cd vscode-pipelex/editors/vscode
yarn install
yarn build

# Run in development
code . # Open in VS Code
# Press F5 to launch Extension Development Host
```

## Testing PML features
- Create `.pml` test files in `test-data/`
- Test syntax highlighting, semantic tokens, and language features
- Verify both PML and TOML functionality work correctly

---

## Original Taplo CONTRIBUTING (kept in sync)
