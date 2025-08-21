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
git clone https://github.com/Pipelex/vscode-pipelex.git
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


- [Contributing](#contributing)
  - [Pull Request Process](#pull-request-process)
  - [Repository Overview](#repository-overview)
    - [scripts](#scripts)
    - [taplo](#taplo)
    - [taplo-cli](#taplo-cli)
    - [taplo-ide](#taplo-ide)
    - [js](#js)
      - [cli](#cli)
      - [lib](#lib)
    - [vscode](#vscode)
    - [util](#util)
  - [Code of Conduct](#code-of-conduct)

# Contributing

When contributing to this repository, please first discuss the change you wish to make via an issue before you start working on it. This is to make sure that no one is working on the same thing at the same time, and that your work will still be relevant when it is ready to be merged.

## Pull Request Process

1. Ensure any local files are removed from the PR, including secrets and temporary files.
2. Update the relevant README.md, and/or the [site](site) if any of the public API, interface was affected by the change.
3. Feel free to ping a maintainer if your PR seems to be ignored.

## Repository Overview

Taplo is a simple project, but it's starting to grow in size.

Here's a quick overview so that everything is easier to find:

### [scripts](scripts)

Scripts for development, this might be the most useful if you're about to ask `how do I...`, it's almost certain there's a script that does what you want.

### [taplo](crates/taplo)

This is the main Rust library, that contains the parser, formatter, and DOM, and every utility that is required for the core features.
Every other package (with the exception of [lsp-async-stub](lsp-async-stub)) depends on it in this repository.

### [taplo-cli](crates/taplo-cli)

A CLI tool that uses Taplo, it is the home of `taplo.config` as well.

### [taplo-ide](crates/taplo-ide)

An IDE-agnostic language server, right now it expects to run within a `wasm32` environment only, however other than that it contains no IDE-specific code or settings.
Originally designed to run alongside a VSCode extension, but with minimal work it can be made into a standalone executable.

### [js](js)

Directory containing everything related to Node.js and JavaScript.

#### [cli](js/cli)

A Node.js wrapper over [taplo-cli](crates/taplo-cli).

#### [lib](js/lib)

A JavaScript wrapper over the core [taplo](crates/taplo) library exposing a high-level API.

### [vscode](editors/vscode)

The VSCode extension, and a Node.js wrapper for [taplo-ide](crates/taplo-ide).

### [util](util)

Contains utilities for schemas and tests.

The [schema-gen](util/schema-gen) was intended for `Cargo.toml` schema generation from the official cargo library, however it turned out to not to be worth it, as it is barely maintainable. It will be removed eventually, and the schema JSON should be edited instead if possible.

## Code of Conduct

Taplo's code of conduct is very simple: **don't be an ass**. I hope this includes everything. Conflicts happen, however most conflicts can and must be resolved in a humanly way (<s>*or with git*</s>). Behaviour that hurts anyone on an emotional or even a physical level will not be tolerated.
