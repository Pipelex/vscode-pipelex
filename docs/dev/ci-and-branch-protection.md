# CI and branch protection

The PR quality gate is driven by the **Makefile** so that what CI runs is exactly what a developer runs locally — there is no hand-mirrored list of steps to drift out of sync. Two workflows are the gate; a third holds the coverage those two don't.

> **Branching context:** feature branches are PR'd into `dev`; `dev` (via `release/*`) feeds `main`. Both `dev` and `main` are protected, and the gate runs on PRs into either. `ci.yaml` (below) is deliberately kept `main`-only.

## The required gate (runs on PRs into `dev` or `main`)

| Workflow | Make target | Job / status-check name | Covers |
| --- | --- | --- | --- |
| `.github/workflows/check.yml` | `make check` | `make check` | `fmt-check` (Rust + TOML/MTHDS), Clippy (workspace + the feature-on PyO3 bindings, `-D warnings`), the full crate + VS Code extension test suite, and the locked compile checks (`pipelex-cli`, `pipelex-py`, and both WASM crates `taplo-wasm` + `pipelex-wasm`). |
| `.github/workflows/test-all.yml` | `make test-all` | `make test-all` | Everything `make test` runs (Rust crates + extension) **plus** the `pipelex_tools` Python library smoke test (builds the wheel via `maturin develop`, imports it). |

Both job names — `make check` and `make test-all` — are the **required status checks** configured on `dev` and `main` (see below). The workflows' `pull_request` trigger is scoped to `branches: [main, dev]`, which must stay in sync with the protected-branch set: if you protect another branch, add it to that filter too, or PRs into it will hang on a required check that never runs. `make test` runs inside both targets, so the crate + extension suites execute in each workflow; that's the cost of gating on two distinct, locally-runnable targets.

### Why the workflows aren't one-liners

`make check` / `make test-all` assume a developer's already-provisioned environment, so each workflow does a little setup the targets don't:

- **VS Code extension `node_modules`** — `make test` → `test-ext` type-checks and runs vitest inside `editors/vscode` but does not `yarn install` there (the `js/lsp` deps it *does* install via the `lsp-types` prerequisite). Each workflow runs `corepack enable && yarn install --immutable` in `editors/vscode` first.
- **`maturin` in the venv** — `make test-all` → `test-pipelex-lib` → `pipelex-lib` → `env` creates `./.venv` via `uv` but does not install `maturin`. `test-all.yml` pre-creates the venv and `uv pip install maturin` so `make env` is a no-op and `maturin develop` resolves.
- **`uv` install** — the enterprise actions allowlist permits only `actions/*` and four third-party actions (see `release-publishing.md`), so `uv` is installed via its official `curl` script, not `astral-sh/setup-uv`.
- **`file:` dependency guard** — `check.yml` fails fast if `editors/vscode/package.json` carries a `file:`/portal dep (left over from `make use-local`); run `make un` to switch back to the npm spec before pushing.

## Auxiliary CI (`ci.yaml`) — runs but not required

`ci.yaml` holds the coverage the make gates don't:

- **`auto_tag`** — on push to `main` (and `workflow_dispatch`), creates the per-component release tags. Not a PR check.
- **`test-python-bindings`** — the **e2e-against-the-shipped-artifact** guard: builds the real `pipelex-tools-py` wheel with `maturin build --release --locked`, `pip install`s it, and imports `pipelex_tools`. This is deliberately kept distinct from `make test-all`'s smoke, which uses `maturin develop` (dev mode); only the build-and-install path catches a `[lib] name` / `#[pymodule]` / `PyInit_` symbol mismatch that produces a valid wheel that fails at import.
- **`toml_test`** — BurntSushi `toml-test` conformance against `taplo`.
- **`test-msrv-{lib,bin,wasm}`** — builds against the MSRV (Rust 1.74).

These run on push to `main` and on PRs **into `main` only** — they are kept off the `dev` PR path on purpose (the e2e wheel + MSRV + toml-test gate at the `dev`→`main` boundary, not on every feature PR). They are **not** required status checks. To require any of them, add its job name to the protection config below.

## Branch protection on `dev` and `main`

Both branches carry the **same** config, applied via the REST API (`PUT /repos/Pipelex/vscode-pipelex/branches/{dev,main}/protection`):

- **Required status checks:** `make check`, `make test-all` (non-strict — PRs are not forced to be up to date with the base before merging).
- **Require a pull request before merging:** yes, with `0` required approving reviews (a PR is required; an approval is not).
- **Require conversation resolution before merging:** yes.
- **Force pushes / deletions:** blocked.
- **`enforce_admins`:** off — admins can still push directly for emergencies. Flip this on to make the rules apply to admins too.

Inspect or change with:

```sh
gh api repos/Pipelex/vscode-pipelex/branches/dev/protection
gh api repos/Pipelex/vscode-pipelex/branches/main/protection
```
