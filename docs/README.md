# Documentation

## Project docs

| Directory | Purpose |
|-----------|---------|
| [`dev/`](dev/) | Developer setup, build instructions |
| [`design/`](design/) | Architecture reference |
| [`features/`](features/) | Feature specs & references |
| [`guide/`](guide/) | User-facing how-to guides |

## Upstream doc composition

The repo-root `README.md` and `CONTRIBUTING.md` are **generated** by prepending Pipelex-specific headers to upstream Taplo content. Never edit them directly. The VS Code extension README (`editors/vscode/README.md`) is manually maintained.

| Directory | Purpose |
|-----------|---------|
| [`pipelex/`](pipelex/) | Pipelex-specific headers (edit these) |
| [`upstream/`](upstream/) | Upstream content (auto-pulled) |

To regenerate:

```bash
./scripts/compose-docs.sh
```
