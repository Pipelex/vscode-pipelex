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
  // Host only, no version path. Defaults to the hosted Pipelex API.
  "pipelex.api.baseUrl": "https://api.pipelex.com"
}
```

`pipelex.backend` and `pipelex.api.baseUrl` are resource-scoped, so a multi-root workspace can mix backends per folder.

## Hosted endpoint and API keys

The `api` backend's default `baseUrl` is the hosted Pipelex API (`https://api.pipelex.com`). To use it, store a key:

- Run **`Pipelex: Set Hosted API Key`** from the Command Palette — the key is saved in VS Code **SecretStorage**, never in plaintext settings.
- **`Pipelex: Clear Hosted API Key`** removes it.

Token resolution is **SecretStorage → `MTHDS_API_KEY` environment variable**: a stored key wins; with none stored, the client falls back to the env var.

## Running a local `pipelex-api`

To validate against a locally self-hosted runner instead of the hosted API, start one:

```bash
docker run --rm -p 8081:8081 pipelex/pipelex-api
```

Then point `pipelex.api.baseUrl` at wherever your server listens — e.g. `http://localhost:8081` (host only — the client composes `{baseUrl}/v1/...`). With a localhost URL everything stays on your machine and no API key is needed.

## Privacy

The `api` backend sends file contents to `baseUrl` on each save. The default `baseUrl` is the hosted endpoint, so before the **first** request to a **non-localhost** host, the extension asks for confirmation once, and states clearly that it sends the **whole directory's `.mthds` contents** (not just the active file) — mirroring how the CLI resolves a bundle via `--library-dir`. Point `baseUrl` at a localhost runner and contents never leave your machine (no confirmation prompt).

## Multi-file bundles and cross-file diagnostics

For a saved `.mthds` file, the extension gathers every `.mthds` file in the **same directory** (matching the CLI's `--library-dir <dir>`, a non-recursive directory glob). A validation error is placed on its **declaring file** — resolved from the error's `source` field, falling back to a declaration scan (`[pipe.<code>]` / `[concept.<code>]`), then to the saved file. So an error caused by a sibling file lands on that sibling, not on the file you happened to save.

> Known divergence: gathering is flat (one directory). Nested directories, installed/configured libraries, and symlink resolution are not followed yet — a follow-up. For the common single-directory bundle it matches the CLI.

## When a backend can't produce a verdict

A backend failure is distinct from "the bundle is invalid":

- **CLI** — if `pipelex-agent` can't be found you get a one-time warning; if it is too old (below the required minimum) you get a targeted upgrade message; setup/infrastructure errors are logged to the Pipelex output channel.
- **API** — any failure to produce a verdict shows an actionable notification, clears any stale diagnostics, and does **not** silently fall back to the CLI. The wording distinguishes three cases by what actually happened:
    - **Unreachable** — the extension never got an answer (network error, timeout, or an unparseable/non-`problem+json` body): "Pipelex API unreachable at …".
    - **Authentication required** (HTTP 401/403) — the server answered but rejected the request for auth. This is its own case with one-click remedies: a **Set API Key** button (runs `Pipelex: Set Hosted API Key`) and, against the hosted endpoint, a **Get an API Key** button that opens [app.pipelex.com](https://app.pipelex.com/). The method-pane message spells out all three paths with clickable links: get a key at app.pipelex.com, self-host the open-source [pipelex-api](https://github.com/Pipelex/pipelex-api) (`docker run -p 8081:8081 pipelex/pipelex-api`) and point `pipelex.api.baseUrl` at it, or switch `pipelex.backend` to `cli` to validate locally without a key. (Against a self-hosted server the platform/self-host options are omitted — you configure auth on the server you run.)
    - **API error** (other 4xx / 5xx, including a request-shape 422) — the server answered with a non-validation error: "Pipelex API error at … (HTTP 5xx) …". Not "unreachable", since the server was reached.

    `/validate` is a **200-diagnostic** endpoint: a produced verdict — valid *or invalid* — rides a 200 whose body is discriminated on `is_valid`, and only that invalid verdict (`is_valid: false`, with its structured `validation_errors[]`) becomes diagnostics. A non-2xx never means "your bundle is bad" — it means no verdict could be produced (a malformed request, auth, a server fault), which is why it surfaces as a backend error rather than a diagnostic.

In every failure case stale diagnostics are cleared, so the Problems panel never shows a wrong-but-leftover verdict.

When the **method graph view** can't render because the backend failed (CLI missing or too old, API unreachable, API key required, an API error, send declined, or an unexpected error), it shows the reason with a **Retry** button — plus, for the API-key case, **Set API Key** / **Get an API Key** buttons — that re-run the analysis for the open file, so a transient failure (server still starting, a network blip, a just-installed CLI, a key just set) recovers without reopening the panel.

## Version expectations

- **CLI** — the `pipelex-agent` floor is enforced at runtime by probing `--version`; an older CLI is reported as too old.
- **API** — on first use against a base URL, the extension probes `GET /v1/version` and warns once if the server's `implementation_version` is a clean release below the expected minimum. Prerelease / dev / non-semver versions are treated as capable (no hard block). The remedy in the warning depends on the host: against a self-hosted server it asks you to upgrade pipelex-api (or its pipelex pin); against the hosted `api.pipelex.com` — which you don't operate — it instead suggests switching `pipelex.backend` to `cli` (or pointing at a self-hosted server) until the capability has rolled out.
