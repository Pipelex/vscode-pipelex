# Validation backends (CLI vs API)

The extension validates `.mthds` bundles on save and renders method graphs. Both happen through a **backend**, selected by the `pipelex.backend` setting:

- **`cli`** (default, zero-config) — spawns the local `pipelex-agent` Python CLI, exactly as before. Nothing to configure: if `pipelex-agent` is on `PATH` or in a workspace `.venv`, it just works.
- **`api`** (opt-in) — calls a Pipelex API server over HTTP via the `mthds` client. Use this when you run a [`pipelex-api`](https://github.com/Pipelex/pipelex-api) server (self-hosted or the hosted endpoint) and want validation/graphs without a local Python install.

Both backends produce the same diagnostics and the same `GraphSpec`, so the editor experience is identical. The graph webview, the Problems panel, and the on-save flow do not know which backend ran.

## Choosing a backend

Set it in Settings (UI or `settings.json`):

```jsonc
{
  // "cli" (default) or "api"
  "pipelex.backend": "api",
  // Host only, no version path. Default targets a locally self-hosted pipelex-api.
  "pipelex.api.baseUrl": "http://localhost:8081"
}
```

`pipelex.backend` and `pipelex.api.baseUrl` are resource-scoped, so a multi-root workspace can mix backends per folder.

## Running a local `pipelex-api`

The `api` backend's default `baseUrl` points at a locally self-hosted runner:

```bash
docker run --rm -p 8081:8080 pipelex/pipelex-api
```

Point `pipelex.api.baseUrl` at wherever your server listens (host only — the client composes `{baseUrl}/v1/...`). Everything stays on your machine with the localhost default.

## Hosted endpoint and API keys

To use the hosted API, set `pipelex.api.baseUrl` to `https://api.pipelex.com` and store a key:

- Run **`Pipelex: Set Hosted API Key`** from the Command Palette — the key is saved in VS Code **SecretStorage**, never in plaintext settings.
- **`Pipelex: Clear Hosted API Key`** removes it.

Token resolution is **SecretStorage → `MTHDS_API_KEY` environment variable**: a stored key wins; with none stored, the client falls back to the env var.

## Privacy

The `api` backend sends file contents to `baseUrl` on each save. With the localhost default this never leaves your machine. Before the **first** request to a **non-localhost** host, the extension asks for confirmation once, and states clearly that it sends the **whole directory's `.mthds` contents** (not just the active file) — mirroring how the CLI resolves a bundle via `--library-dir`.

## Multi-file bundles and cross-file diagnostics

For a saved `.mthds` file, the extension gathers every `.mthds` file in the **same directory** (matching the CLI's `--library-dir <dir>`, a non-recursive directory glob). A validation error is placed on its **declaring file** — resolved from the error's `source` field, falling back to a declaration scan (`[pipe.<code>]` / `[concept.<code>]`), then to the saved file. So an error caused by a sibling file lands on that sibling, not on the file you happened to save.

> Known divergence: gathering is flat (one directory). Nested directories, installed/configured libraries, and symlink resolution are not followed yet — a follow-up. For the common single-directory bundle it matches the CLI.

## When a backend can't produce a verdict

A backend failure is distinct from "the bundle is invalid":

- **CLI** — if `pipelex-agent` can't be found you get a one-time warning; if it is too old (below the required minimum) you get a targeted upgrade message; setup/infrastructure errors are logged to the Pipelex output channel.
- **API** — a server-unreachable, auth, timeout, or non-`problem+json` response shows an actionable notification ("Pipelex API unreachable at …"), clears any stale diagnostics, and does **not** silently fall back to the CLI. Only a real validation failure (HTTP 422 with structured errors) becomes diagnostics.

In every failure case stale diagnostics are cleared, so the Problems panel never shows a wrong-but-leftover verdict.

## Version expectations

- **CLI** — the `pipelex-agent` floor is enforced at runtime by probing `--version`; an older CLI is reported as too old.
- **API** — on first use against a base URL, the extension probes `GET /v1/version` and warns once if the server's `implementation_version` is a clean release below the expected minimum. Prerelease / dev / non-semver versions are treated as capable (no hard block).
