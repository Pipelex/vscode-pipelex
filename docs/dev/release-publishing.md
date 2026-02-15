# Release Publishing

Automated publishing for Pipelex-specific artifacts via `.github/workflows/releases.yaml`.

| Artifact | Registry | Tag pattern | Trigger |
|----------|----------|-------------|---------|
| `pipelex-tools` CLI (`plxt`) | PyPI | `release-pipelex-cli-{version}` | Version bump in `crates/pipelex-cli/Cargo.toml` |
| Pipelex VS Code extension | VS Code Marketplace + Open VSX | `release-pipelex-{version}` | Version bump in `editors/vscode/package.json` |

Both use `tamasfe/auto-tag` — when a version field changes on `main`, the corresponding tag is created automatically (requires `WORKFLOW_PAT` secret).

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

- Verify the **`WORKFLOW_PAT`** secret exists (needed by `auto-tag` to create tags that trigger the release workflow)

---

### GitHub Actions — Enterprise allowlist & SHA pinning

The Pipelex Enterprise enforces an actions allowlist. Only GitHub-owned actions (`actions/*`) and explicitly allowed third-party actions can run.

**Allowlist location:** [github.com/enterprises/Pipelex/settings/actions/policies](https://github.com/enterprises/Pipelex/settings/actions/policies) → "Allow enterprise actions, and select non-enterprise actions"

Currently allowed third-party actions (beyond GitHub-owned):

| Pattern | Action | Why |
|---------|--------|-----|
| `Swatinem/rust-cache@*` | Rust build caching | Complex cache key logic, target cleanup |
| `PyO3/maturin-action@*` | Python wheel builds from Rust | Cross-platform maturin + sccache setup |
| `tamasfe/auto-tag@*` | Auto-create release tags | Upstream custom tagging logic |
| `pypa/gh-action-pypi-publish@*` | Publish to PyPI via OIDC | Trusted publishing without API tokens |
| `peaceiris/actions-gh-pages@*` | Deploy to GitHub Pages | Site deployment |

All five are **SHA-pinned** in the workflow files (e.g. `Swatinem/rust-cache@779680da...  # v2.8.2`) so that no one — including the action maintainer — can silently change what code runs. The allowlist uses `@*` wildcards to permit SHA refs. The enterprise setting **"Require actions to be pinned to a full-length commit SHA"** is enabled to enforce this.

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
3. `auto-tag` creates `release-pipelex-cli-{version}`
4. `releases.yaml` runs: build wheels → test → publish to PyPI

### Pipelex VS Code extension

1. Bump `version` in `editors/vscode/package.json`
2. Merge to `main`
3. `auto-tag` creates `release-pipelex-{version}`
4. `releases.yaml` runs: build extension → publish to VS Code Marketplace + Open VSX

### Both at once

You can bump both versions in the same PR. `auto-tag` creates both tags, and the release workflow triggers separately for each.

---

## Dry run

Manually trigger the workflow via **Actions → Releases → Run workflow** (`workflow_dispatch`). All build/test jobs will run but publish steps are guarded by `github.event_name == 'push'`, so nothing gets published.

---

## Tag pattern reference

| Tag prefix | Matches | Example |
|------------|---------|---------|
| `release-pipelex-0` | VS Code extension (version starts with digit) | `release-pipelex-0.4.0` |
| `release-pipelex-cli-0` | pipelex-tools CLI (has `cli-` infix) | `release-pipelex-cli-0.2.0` |
| `release-taplo-cli-0` | Upstream taplo CLI | `release-taplo-cli-0.9.0` |
| `release-taplo-0` | Upstream taplo crate | `release-taplo-0.13.0` |

The `release-pipelex-0` and `release-pipelex-cli-0` prefixes are unambiguous because `startsWith` checks won't overlap (the CLI tag always has `-cli-` before the version digit).
