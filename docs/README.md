# Documentation

## Project docs

| Directory | Purpose |
|-----------|---------|
| [`dev/`](dev/) | Developer setup, build instructions |
| [`design/`](design/) | Architecture decisions & plans |
| [`features/`](features/) | Feature specs & references |
| [`guide/`](guide/) | User-facing how-to guides |

## Upstream doc composition

The repo-root `README.md`, `CONTRIBUTING.md`, and `editors/vscode/README.md` are **generated** by prepending Pipelex-specific headers to upstream Taplo content. Never edit them directly.

| Directory | Purpose |
|-----------|---------|
| [`pipelex/`](pipelex/) | Pipelex-specific headers (edit these) |
| [`upstream/`](upstream/) | Upstream content (auto-pulled) |

To regenerate:

```bash
./scripts/compose-docs.sh
```
