# Release Publishing

Automated publishing for Pipelex-specific artifacts via `.github/workflows/releases.yaml`.

| Artifact | Registry | Tag pattern | Trigger |
|----------|----------|-------------|---------|
| `pipelex-tools` CLI (`plxt`) | PyPI | `plxt-cli/v{version}` | Version bump in `crates/pipelex-cli/Cargo.toml` |
| `pipelex-tools-py` library (`import pipelex_tools`) | PyPI | `pipelex-tools-py/v{version}` | Version bump in `crates/pipelex-py/Cargo.toml` |
| `@pipelex/tools-wasm` WASM bindings | npm | `pipelex-tools-wasm/v{version}` | Version bump in `js/tools-wasm/package.json` |
| Pipelex VS Code extension | VS Code Marketplace + Open VSX | `pipelex-vscode-ext/v{version}` | Version bump in `editors/vscode/package.json` |

Inline shell in `ci.yaml` reads version fields on each push to `main` and creates the corresponding tag if it doesn't already exist (requires `WORKFLOW_PAT` secret).

The CLI (`pipelex-tools`) and the library (`pipelex-tools-py`) are **two separate PyPI packages** built from this one repo — maturin cannot pack a native binary and a pyo3 extension module into the same wheel. The CLI ships the real `plxt` executable (`bindings = "bin"`, root `pyproject.toml`); the library ships the importable `pipelex_tools` module (`bindings = "pyo3"`, `crates/pipelex-py/pyproject.toml`). Their release paths are fully independent — separate tags, versions, and build/test/publish jobs. See [`pipelex-tools-python-bindings.md`](pipelex-tools-python-bindings.md) for the library surface.

`@pipelex/tools-wasm` is the third binding over that **same** shared lint/format engine (`pipelex_common::tools`), compiled to WASM for Node consumers — see [`mthds-engine-bindings.md`](mthds-engine-bindings.md). Two things about it differ from every other artifact here and are worth stating plainly:

- **Its version lives in `js/tools-wasm/package.json`, not in a `Cargo.toml`.** The crate behind it (`crates/pipelex-tools-wasm`) is `publish = false` and its version is inert — the npm package is the published receipt. Same split as `crates/pipelex-wasm` vs `js/lsp`. Both the `auto_tag` step and the `/release` skill read the `package.json`.
- **It is not bundled into the extension.** Unlike `js/lsp`, nothing in `editors/vscode/` depends on it, so it neither rides along on an extension release nor forces one.

Because the MTHDS JSON Schema is `include_str!`-embedded into all three engine bindings, **a schema refresh must ship all three** (`plxt`, `pipelex-tools-py`, `@pipelex/tools-wasm`) or the ones left behind keep serving the stale schema.

---

## One-time setup

### PyPI — Trusted Publishing (no API token needed)

OIDC trusted publishing lets GitHub Actions publish to PyPI without storing an API token.

1. Log in to [pypi.org](https://pypi.org) as the **pipelex** account
2. If the `pipelex-tools` project **does not exist yet**:
   - Go to **Your Account → Publishing → Add Pending Publisher**
   - Fill in:
     - PyPI project name: `pipelex-tools`
     - Owner: `Pipelex`
     - Repository: `vscode-pipelex`
     - Workflow name: `releases.yaml`
     - Environment: *(leave blank)*
3. If `pipelex-tools` **already exists** on PyPI:
   - Go to **Project → Settings → Publishing → Add Trusted Publisher**
   - Same values as above
4. Repeat steps 2–3 for the **`pipelex-tools-py`** project (the importable library). It is a distinct PyPI project published from the same repo and `releases.yaml` workflow — set PyPI project name `pipelex-tools-py`, everything else identical.

### npm — Trusted Publishing (no API token needed)

Same credential-free OIDC model as PyPI above, and the same one `mthds-ui`, `mthds-js` and `pipelex-sdk-js` already use — **there is no `NPM_TOKEN` secret in this repo and there should not be one.**

1. Log in to [npmjs.com](https://www.npmjs.com) as an account with admin rights on the **`@pipelex`** scope
2. Go to the **`@pipelex/tools-wasm`** package → **Settings → Trusted Publisher → GitHub Actions**
3. Fill in:
   - Organization or user: `Pipelex`
   - Repository: `vscode-pipelex`
   - Workflow filename: `releases.yaml`
   - Environment: *(leave blank)*
4. Nothing to add to GitHub secrets — the job requests an OIDC token via `permissions: id-token: write`

The workflow filename is part of the trust relationship: **renaming `releases.yaml` breaks the npm publish** (and the PyPI publishes, which name it in their trusted-publisher config too). If you rename it, update all four publisher registrations.

Two details this depends on:

- **`npm install -g npm@latest` runs before publishing.** Trusted publishing needs npm ≥ 11.5.1 and the runner image ships older; without the upgrade the publish falls back to looking for a token and fails with `ENEEDAUTH`.
- **`--provenance` requires a public repo.** `Pipelex/vscode-pipelex` is public, so this works. It would fail on a private repo.

### VS Code Marketplace

1. Ensure the **"Pipelex"** publisher exists at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Generate a Personal Access Token (PAT) from [Azure DevOps](https://dev.azure.com) with **Marketplace → Manage** scope
3. Add it as GitHub secret **`VSCE_TOKEN`** at `github.com/Pipelex/vscode-pipelex/settings/secrets/actions`

### Open VSX

1. Log in to [open-vsx.org](https://open-vsx.org) as **lchoquel**
2. Create or claim the **"Pipelex"** namespace (must match the `publisher` field in `editors/vscode/package.json`)
3. Generate an access token at [open-vsx.org/user-settings/tokens](https://open-vsx.org/user-settings/tokens)
4. Add it as GitHub secret **`OPEN_VSX_TOKEN`**

### GitHub

- Verify the **`WORKFLOW_PAT`** secret exists (needed by the auto-tagging step to create tags that trigger the release workflow)

---

### GitHub Actions — Enterprise allowlist & SHA pinning

The Pipelex Enterprise enforces an actions allowlist. Only GitHub-owned actions (`actions/*`) and explicitly allowed third-party actions can run.

**Allowlist location:** [github.com/enterprises/Pipelex/settings/actions/policies](https://github.com/enterprises/Pipelex/settings/actions/policies) → "Allow enterprise actions, and select non-enterprise actions"

Currently allowed third-party actions (beyond GitHub-owned):

| Pattern | Action | Why |
|---------|--------|-----|
| `Swatinem/rust-cache@*` | Rust build caching | Complex cache key logic, target cleanup |
| `PyO3/maturin-action@*` | Python wheel builds from Rust | Cross-platform maturin + sccache setup |
| `pypa/gh-action-pypi-publish@*` | Publish to PyPI via OIDC | Trusted publishing without API tokens |
| `peaceiris/actions-gh-pages@*` | Deploy to GitHub Pages | Site deployment |

All four are **SHA-pinned** in the workflow files (e.g. `Swatinem/rust-cache@779680da...  # v2.8.2`) so that no one — including the action maintainer — can silently change what code runs. The allowlist uses `@*` wildcards to permit SHA refs. The enterprise setting **"Require actions to be pinned to a full-length commit SHA"** is enabled to enforce this.

Simple actions (`nick-fields/retry`, `lewagon/wait-on-check-action`, `docker/login-action`, `docker/setup-qemu-action`) were replaced with inline shell to avoid unnecessary trust dependencies.

> **TODO:** Enable [Dependabot for GitHub Actions](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file#package-ecosystem) to get automatic PRs when SHA-pinned actions have newer versions. Add a `.github/dependabot.yml` with:
> ```yaml
> version: 2
> updates:
>   - package-ecosystem: "github-actions"
>     directory: "/"
>     schedule:
>       interval: "weekly"
> ```

---

## How to trigger a release

### pipelex-tools CLI

1. Bump `version` in `crates/pipelex-cli/Cargo.toml`
2. Merge to `main`
3. The `auto_tag` job creates `plxt-cli/v{version}`
4. `releases.yaml` runs: build wheels → test → publish to PyPI

### Pipelex VS Code extension

1. Bump `version` in `editors/vscode/package.json`
2. Merge to `main`
3. The `auto_tag` job creates `pipelex-vscode-ext/v{version}`
4. `releases.yaml` runs: build extension → publish to VS Code Marketplace + Open VSX

### @pipelex/tools-wasm

1. Bump `version` in `js/tools-wasm/package.json` (**not** `crates/pipelex-tools-wasm/Cargo.toml`)
2. Merge to `main`
3. The `auto_tag` job creates `pipelex-tools-wasm/v{version}`
4. `releases.yaml` runs: build the release bundle (`RELEASE=true`) → run its vitest suite against that bundle → publish to npm via OIDC with `--provenance`

The publish step queries the registry first and exits green if the version is already on npm — npm has no `--skip-existing`, and republishing is a hard 403 that would otherwise turn a harmless re-run red.

**The npm job is the one job in `releases.yaml` that does not run on pull requests**, and that is deliberate. It is also the only job that holds `id-token: write` *while executing repository code* (`yarn install`, `yarn build`, `yarn test`) — the two PyPI publish jobs hold the OIDC identity but run nothing but `download-artifact` + `gh-action-pypi-publish`. On a PR that code is attacker-controlled, and the `github.event_name == 'push'` guard on the publish step is no defense: any build step can read `$ACTIONS_ID_TOKEN_REQUEST_URL` and mint the token itself, then publish out of band. So the job is gated to tag pushes and `workflow_dispatch` only, and the publish identity never exists in a PR run. Little coverage is lost — `test-all.yml` already builds `@pipelex/tools-wasm` and runs its vitest suite on every PR (via `make test` → `test-tools-wasm-js`, debug profile), and `make check` cargo-checks the crate for `wasm32`. What moves to the dry run below is the `RELEASE=true` profile rehearsal.

**This repo tags, then publishes; the sibling JS repos publish straight off `main`.** `mthds-ui` / `mthds-js` / `pipelex-sdk-js` each ship a single npm package, so "merged to main" *is* the release signal and their workflow creates the tag afterwards. This repo ships four artifacts on independent versions, so the tag is what selects *which* one is being released — `auto_tag` creates it and `releases.yaml` reacts. The npm authentication is identical; only the trigger differs.

### Several at once

You can bump any combination of versions in the same PR. The `auto_tag` job creates every missing tag, and the release workflow triggers separately for each.

**`auto_tag` pushes one tag per `git push`, and it must stay that way.** GitHub creates no ref event *at all* when more than three tags move in a single push, and `releases.yaml` is triggered exclusively by `push: tags:` — so a batched `git push --tags` publishes nothing while `auto_tag` still reports success. This is not hypothetical: it is how v0.16.0 shipped nothing. That release was the first to carry a fourth tag (`pipelex-tools-wasm`, added in v0.16.0 itself); all four tags landed on the merge commit, zero `Releases` runs fired, and every artifact silently stayed on its previous version. Every release before it bumped at most three components and so never crossed the limit. Pushing the tags individually keeps each push at one tag, so the ceiling cannot be reached however many components this repo grows to ship.

**Recovering from a release that tagged but never published.** Re-pushing an existing tag is a no-op and creates no event, so the tag has to be deleted and recreated — one at a time, from a real user account (a push made with the default `GITHUB_TOKEN` never triggers a workflow; `auto_tag` uses `WORKFLOW_PAT` for exactly this reason):

```bash
git push origin :refs/tags/plxt-cli/v0.8.0 && git push origin plxt-cli/v0.8.0
```

Nothing else needs redoing: the tag still points at the same merge commit, `releases.yaml`'s `wait_for_ci` finds the `Test on Rust stable` check that already passed there, and the tag-vs-`package.json` guard still agrees.

---

## Dry run

Manually trigger the workflow via **Actions → Releases → Run workflow** (`workflow_dispatch`). All build/test jobs will run but publish steps are guarded by `github.event_name == 'push'`, so nothing gets published.

For `@pipelex/tools-wasm` this is the **only** pre-merge rehearsal, since that job no longer runs on pull requests (see above). Dispatch is safe to grant the publish identity: triggering a `workflow_dispatch` requires write access, so the code it builds is already trusted. Use it after changing anything in `js/tools-wasm/`, the `npm_publish_tools_wasm` job, or the toolchain versions it pins — a break there would otherwise surface for the first time on the tag push.

---

## Tag pattern reference

| Tag prefix | Matches | Example |
|------------|---------|---------|
| `pipelex-vscode-ext/v` | VS Code extension | `pipelex-vscode-ext/v0.4.0` |
| `plxt-cli/v` | pipelex-tools CLI | `plxt-cli/v0.2.0` |
| `pipelex-tools-py/v` | pipelex-tools-py library | `pipelex-tools-py/v0.2.0` |
| `pipelex-tools-wasm/v` | @pipelex/tools-wasm npm package | `pipelex-tools-wasm/v0.2.0` |

The prefixes are unambiguous — each artifact has its own distinct tag namespace. Note that `pipelex-tools-py/v` and `pipelex-tools-wasm/v` share a prefix up to `pipelex-tools-`, so the `startsWith` guards in `releases.yaml` must always include the trailing `py/v` / `wasm/v` — never match on `pipelex-tools/` alone.
