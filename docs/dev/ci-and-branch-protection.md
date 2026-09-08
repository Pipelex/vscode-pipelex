# CI and branch protection

The PR quality gate is driven by the **Makefile** so that what CI runs is exactly what a developer runs locally — there is no hand-mirrored list of steps to drift out of sync. Two workflows are the gate; a third holds the coverage those two don't.

> **Branching context:** feature branches are PR'd into `dev`; `dev` (via `release/*`) feeds `main`. Both `dev` and `main` carry a ruleset requiring the gate, and the gate runs on PRs into either. `ci.yaml` (below) is deliberately kept `main`-only.

## The required gate (runs on PRs into `dev` or `main`)

| Workflow | Make target | Job / status-check name | Covers |
| --- | --- | --- | --- |
| `.github/workflows/check.yml` | `make check` | `make check` | `fmt-check` (Rust + TOML/MTHDS), Clippy (workspace + the feature-on PyO3 bindings, `-D warnings`), the full crate + VS Code extension test suite, and the locked compile checks (`pipelex-cli`, `pipelex-py`, and both WASM crates `taplo-wasm` + `pipelex-wasm`). |
| `.github/workflows/test-all.yml` | `make test-all` | `make test-all` | Everything `make test` runs (Rust crates + extension) **plus** the `pipelex_tools` Python library smoke test (builds the wheel via `maturin develop`, imports it). |

Both job names — `make check` and `make test-all` — are the **required status checks** named by the `dev` and `main` rulesets (see below). The workflows' `pull_request` trigger is scoped to `branches: [main, dev]`, which must stay in sync with the protected-branch set: if you protect another branch, add it to that filter too, or PRs into it will hang on a required check that never runs. `make test` runs inside both targets, so the crate + extension suites execute in each workflow; that's the cost of gating on two distinct, locally-runnable targets.

### Why the workflows aren't one-liners

`make check` / `make test-all` assume a developer's already-provisioned environment, so each workflow does a little setup the targets don't:

- **VS Code extension `node_modules`** — `make test` → `test-ext` type-checks and runs vitest inside `editors/vscode` but does not `yarn install` there (the `js/lsp` deps it *does* install via the `lsp-types` prerequisite). Each workflow runs `corepack enable && yarn install --immutable` in `editors/vscode` first.
- **`maturin` in the venv** — `make test-all` → `test-pipelex-lib` → `pipelex-lib` → `env` creates `./.venv` via `uv` but does not install `maturin`. `test-all.yml` pre-creates the venv and `uv pip install maturin` so `make env` is a no-op and `maturin develop` resolves.
- **`uv` install** — the enterprise actions allowlist permits only `actions/*` and four third-party actions (see `release-publishing.md`), so `uv` is installed via its official `curl` script, not `astral-sh/setup-uv`.
- **`file:` dependency guard** — `check.yml` fails fast if `editors/vscode/package.json` carries a `file:`/portal dep (left over from `make use-local`); run `make use-npm VERSION=X.Y.Z` to pin the released version before pushing. Name the version: bare `make use-npm` (`make un`) installs `latest` and writes the literal spec `npm:latest`, which satisfies every guard while recording nothing — the manifest then states no version and `yarn.lock` is the only place the answer lives. The `bump-mthds-ui` skill walks the whole move, changelog included.

## Auxiliary CI (`ci.yaml`) — runs but not required

`ci.yaml` holds the coverage the make gates don't:

- **`auto_tag`** — on push to `main` (and `workflow_dispatch`), creates the per-component release tags. Not a PR check. It pushes each tag in its own `git push`, because GitHub creates no ref event when more than three tags move at once — batching them makes `releases.yaml` skip a release entirely while this job still reports success. See [`release-publishing.md`](release-publishing.md#several-at-once).
- **`test-python-bindings`** — the **e2e-against-the-shipped-artifact** guard: builds the real `pipelex-tools-py` wheel with `maturin build --release --locked`, `pip install`s it, and imports `pipelex_tools`. This is deliberately kept distinct from `make test-all`'s smoke, which uses `maturin develop` (dev mode); only the build-and-install path catches a `[lib] name` / `#[pymodule]` / `PyInit_` symbol mismatch that produces a valid wheel that fails at import.
- **`toml_test`** — BurntSushi `toml-test` conformance against `taplo`.
- **`test-msrv-{lib,bin,wasm}`** — builds against the MSRV (Rust 1.74).

These run on push to `main` and on PRs **into `main` only** — they are kept off the `dev` PR path on purpose (the e2e wheel + MSRV + toml-test gate at the `dev`→`main` boundary, not on every feature PR). They are **not** required status checks. To require any of them, add its job name to the `required_status_checks` rule of the `dev` and `main` rulesets described below.

## Rulesets on `dev`, `main` and `release/v*`

Protection is held by three repository **rulesets**. They replaced the classic branch protections that used to carry the same gate, which were deleted when the workspace-wide merge policy was applied — `gh api repos/Pipelex/vscode-pipelex/branches/{dev,main}/protection` now answers `Branch not protected`, and that is the expected answer, not a missing gate.

| Ruleset | Merge method | Required status checks | Pull request | Other rules |
| --- | --- | --- | --- | --- |
| `dev` | **squash only** | `make check`, `make test-all` — **non-strict** | required, `0` approvals, thread resolution required | creation, deletion and force-push blocked |
| `main` | **merge commit only** | `make check`, `make test-all` — **strict** | required, `0` approvals, thread resolution required | creation, deletion and force-push blocked |
| `release/v*` | — | none | not required | force-push blocked |

The rules that matter in daily use:

- **The merge method is the ruleset's, not a preference.** `dev` accepts only a squash, so a topic branch lands as one commit; `main` accepts only a merge commit, so it keeps `dev`'s ancestry and a release branch can still be deleted afterwards. Rebase merging is off on the repository. Passing `--squash` to a release PR into `main`, or `--merge` to a topic PR into `dev`, is refused by GitHub rather than quietly honoured.
- **`main` is strict; `dev` is not.** A PR into `main` — in practice a `release/vX.Y.Z` PR — must be up to date with `main` before it can merge, so a release cut behind `main` has to take `main` in first. A PR into `dev` does not, which is what keeps a queue of green feature PRs from having to be rebuilt against every landing ahead of them.
- **No approving review is required anywhere**, on either branch. Quality is gated before the PR opens by the `/rev` round recorded on the ledger item, and after it opens by the two required checks. An **unresolved review thread still blocks the merge** on both branches, because a thread means a person said something.
- **Both checks are pinned to the GitHub Actions app** (`integration_id` 15368), so a plain commit-status POST from any other token cannot satisfy the gate.
- **`release/v*` has no pull-request rule and requires no checks** — a release branch is pushed to directly while it is being prepared. Its gate is `main`'s ruleset, which applies when the release PR opens. It carries no `deletion` rule on purpose (GitHub deletes the branch at merge time) and no `creation` rule (a release branch is cut on demand); force-push is blocked.
- **The `pipelex-staff` team can bypass all three**, in `always` mode. That bypass exists for the one push the landing play makes by design — the post-release merge of `main` back into `dev`, which is a direct push and would otherwise hit `dev`'s pull-request rule — and for a person acting by hand in an emergency.

### Where the shape comes from

These rulesets are not maintained by hand in this repo. They are rendered from the workspace-wide merge policy: `github-rules.toml` at the workspace root states this repository's shape, the `github-rules` command renders it into rulesets, and `make check-github-rules` reports drift. The policy, the tool and its three verbs are documented in the workspace meta-repo's `docs/github-rules.md`.

The **check names are the exception** — the policy file deliberately does not carry them, because they differ per repo and per workflow. The tool reads them off the live ruleset of the branch it rewrites and carries them over unchanged. So renaming the `make check` or `make test-all` job in a workflow does **not** update the ruleset: rename the job and the required check together, or PRs will hang on a context that no longer reports.

Inspect with:

```sh
gh api repos/Pipelex/vscode-pipelex/rulesets                    # the three, by id
gh api repos/Pipelex/vscode-pipelex/rules/branches/dev          # everything that applies to a branch
gh api repos/Pipelex/vscode-pipelex/rules/branches/main
```

`rules/branches/<branch>` is the one to trust when a merge is refused and the reason is not obvious: it answers with every rule GitHub is actually applying to that branch, from every ruleset that matches it, which a per-ruleset read does not.
