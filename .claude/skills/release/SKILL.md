---
name: release
description: >
  Cut a release of vscode-pipelex, the repo that ships four independently
  versioned artifacts from one tree — the Pipelex VS Code extension, the plxt
  CLI on PyPI as pipelex-tools, the importable pipelex-tools-py library, and the
  @pipelex/tools-wasm npm package: the release/vX.Y.Z worktree, the version
  files that move and the Cargo.lock that follows, the changelog entry with its
  per-artifact annotations, the make check and make test-all gates, the
  regenerated extension changelog, one commit, and a pull request to main. Use
  when the user says "release", "cut a release", "bump version", "prepare a
  release", "make a release", "ship it", "create release branch", "promote dev
  to main", "publish the extension", "publish plxt", or any variation of
  shipping a new version of the extension or the MTHDS toolchain. Changelog
  content passed inline ("/release Fixed graph pipe navigation") becomes the
  entry. The merge is landed by /ledger-land, never by this skill.
---

# Releasing vscode-pipelex

The procedure is the workspace release play, [`docs/releasing.md`](../../../../docs/releasing.md) at the workspace root — `../docs/releasing.md` from this repo's own root, which resolves the same from the main checkout and from any worktree. Read it first, then run it with what follows. The repo key is `vscode-pipelex`, the base is `dev`, and the pull request targets `main`: a `release/*` branch is the only branch here that does, and a release pull request opened into `dev` by mistake lands the version bump without publishing anything. The release worktree is `_vscode-pipelex--release`, made with `wt add vscode-pipelex release --branch release/vX.Y.Z`, and the `vX.Y.Z` in that branch name is the extension's new version — falling back, when the extension was not bumped, to the CLI's, then the library's, then `@pipelex/tools-wasm`'s.

The repo declares neither `.worktree.toml` nor `.worktreeinclude`, and the Makefile has no `install` target, so `wt` resolves the base from `origin/dev` and provisions nothing. A fresh worktree therefore starts cold, and the gates below name the two setup commands `check.yml` and `test-all.yml` run for the same reason.

## What ships

Publishing here is two stages, and the tag between them is what selects which of the four artifacts is being released.

**Stage one, on the push to `main`:** `ci.yaml`'s `auto_tag` job reads all four version fields, creates every corresponding tag that does not already exist, and pushes them **one `git push` per tag**. That loop is load-bearing: GitHub creates no ref event at all when more than three tags move in a single push, and `releases.yaml`'s only push trigger is `push: tags:`, so a batched push publishes nothing while the job still reports success. The job needs the `WORKFLOW_PAT` secret, because a push made with the default `GITHUB_TOKEN` triggers no workflow.

**Stage two, on each tag push:** `releases.yaml` fires once per tag and publishes just that artifact, after its `wait_for_ci` job has waited for the `Test on Rust stable` check on the tagged commit to conclude successfully.

| Artifact | Version file | Tag | Registry |
|---|---|---|---|
| Pipelex VS Code extension | `editors/vscode/package.json` | `pipelex-vscode-ext/v*` | VS Code Marketplace (`vsce publish`) and Open VSX (`ovsx publish`) |
| `plxt` CLI | `crates/pipelex-cli/Cargo.toml` | `plxt-cli/v*` | PyPI as `pipelex-tools`, wheels built by maturin across the OS/arch matrix |
| `pipelex_tools` library | `crates/pipelex-py/Cargo.toml` | `pipelex-tools-py/v*` | PyPI as `pipelex-tools-py` |
| `@pipelex/tools-wasm` | `js/tools-wasm/package.json` | `pipelex-tools-wasm/v*` | npm, built with `RELEASE=true` and published with `--provenance` |

Both PyPI publishes and the npm publish use OIDC trusted publishing, so there is no token secret for them; the two extension marketplaces use `VSCE_TOKEN` and `OPEN_VSX_TOKEN`.

One more publish fires outside those two stages and outside the tag mechanism entirely: `site.yaml` builds the VitePress site under `site/` on a push to `main` and pushes it to GitHub Pages. It is path-filtered to `site/**/*`, so a bump-only release never triggers it — but it is inherited from the Taplo fork and still deploys with `cname: taplo.tamasfe.dev`, a domain this fork does not control, so a release promoting a `site/**` change would publish a website nobody here reads. Raise that with the user rather than letting it ship unremarked.

The landing verifies the publish — the runs, the tags, the registries:

```bash
gh run list --workflow=ci.yaml --branch main --limit 3 --json conclusion,headSha,url   # auto_tag on the merge SHA: success
git fetch --tags --prune origin && git tag --points-at <merge SHA>                     # one tag per artifact bumped
gh run list --workflow=releases.yaml --limit 10 --json conclusion,headBranch,event,url # one run per tag that was pushed
pip index versions pipelex-tools && pip index versions pipelex-tools-py                # the PyPI answers
npm view @pipelex/tools-wasm version                                                   # the npm answer
```

The extension is confirmed on its two marketplace listings for the publisher/name pair `Pipelex.pipelex`. A tag that exists with **no `Releases` run against it** is the v0.16.0 failure mode — the recovery is to delete and re-push that tag, one at a time and from a real user account, and `docs/dev/release-publishing.md` carries the exact commands.

## Version files and the lock

Which of the four versions move is not a judgement call: run the detection script and read its `--- AFFECTED COMPONENTS ---` block, then ask the play's bump question once per affected artifact in a single `AskUserQuestion` call. It only reads, so it can be run before the worktree exists; `--base <ref>` overrides the per-artifact tag it diffs from. When that block reports `ci_docs_only: true`, nothing that ships has moved since the last tags — say so and ask whether to release at all, before asking for any bump.

```bash
bash .claude/skills/release/scripts/detect_changes.sh
```

The four published version fields, and nothing else:

- **`editors/vscode/package.json`** — the `.version` field.
- **`crates/pipelex-cli/Cargo.toml`** — `version` under `[package]`. The root `pyproject.toml` declares `dynamic = ["version"]` with `manifest-path = "crates/pipelex-cli/Cargo.toml"`, so maturin reads the published `pipelex-tools` version straight out of the crate.
- **`crates/pipelex-py/Cargo.toml`** — `version` under `[package]`. Same arrangement for `pipelex-tools-py`: **never edit `crates/pipelex-py/pyproject.toml`**, which is `dynamic` too.
- **`js/tools-wasm/package.json`** — the `.version` field, and the only version to touch for that artifact. `crates/pipelex-tools-wasm/Cargo.toml` is `publish = false`, nothing reads its version, and `auto_tag` derives the tag from the `package.json`; bumping the crate creates a second apparent source of truth that ships nowhere.

- **The lock** — `make lock` (`cargo update --workspace`) after any `Cargo.toml` version change, so `Cargo.lock` records the new number. The `js/tools-wasm/package.json` edit needs no lock refresh: no workspace member references that version. A stale lock is caught by the `--locked` compile checks in `make check`, not by a dedicated CI job.
- **The internal crates** — `crates/pipelex-common` and `crates/pipelex-lsp` carry versions of their own and are normally left alone; they publish nowhere. Bumping `pipelex-common` means editing the `version =` in its dependency line in `crates/pipelex-cli/Cargo.toml` and `crates/pipelex-lsp/Cargo.toml` as well, which are the two consumers that pin it (`pipelex-py`, `pipelex-wasm` and `pipelex-tools-wasm` reference it by path only).
- **Also stamped:** nothing beyond the version files and the changelogs. `.claude/skills/release/references/version-map.md` is the fuller map, including which crates are deliberately inert.

## Gates

Run in the worktree, in this order. The first two are exactly the required status checks on the pull request, so a red one here is a red pull request there.

1. **`make check`** — `check-no-local-deps`, `fmt-check` (Rust plus TOML/MTHDS through `plxt fmt --check`), Clippy over the workspace and over the feature-on `pipelex-py` and `pipelex-common` with `-D warnings`, the full crate and extension test suites, and the `--locked` compile checks for `pipelex-cli`, `pipelex-py` and all three WASM crates. It rewrites nothing — `fmt-check` only reports — so the cure for a format failure is `make fmt`, and the cure for anything else is the code. Two prerequisites the target does not install itself: run `corepack enable && yarn install --immutable` in `editors/vscode` first, because `test-ext` type-checks and tests there without installing its `node_modules`; and if `check-no-local-deps` fails, `@pipelex/mthds-ui` is on a portal link from `make use-local`, so run `make use-npm` (`make un`) before going further.
2. **`make test-all`** — everything `make check` tested plus `test-pipelex-lib`, which builds the `pipelex-tools-py` wheel with `maturin develop --release` and runs its Python smoke test. `make env` creates `.venv` through `uv` but does not put `maturin` in it, so install it there once (`uv pip install maturin`) exactly as `test-all.yml` does.
3. **`make docs`, after the changelog entry is final** — see the changelog note below; it rewrites files that join the commit.

When the full gate is genuinely impractical, the per-artifact fast checks are `cargo check -p pipelex-cli --locked`, `cargo check -p pipelex-py --features python --locked`, and `cargo check -p pipelex-wasm -p pipelex-tools-wasm --target wasm32-unknown-unknown --locked` — all of which `make check` already covers, the feature-on PyO3 path through its Clippy step. Whichever path was taken, **state plainly in the summary which commands actually ran and whether a full `make check` was among them.**

**Regenerating the extension changelog.** `editors/vscode/CHANGELOG.md` is generated: `scripts/compose-docs.sh` composes it from the root `CHANGELOG.md`, the header in `docs/pipelex/`, and the upstream Taplo changelog. Nothing in CI runs it, so it goes stale unless it is regenerated here, once the root entry is written:

```bash
git fetch origin upstream
git branch -f upstream origin/upstream
make docs
```

The `upstream` branch is not optional. `compose-docs.sh` reads the upstream files with `git show upstream:<path>`, and when that ref is missing it deletes `docs/upstream/*` and replaces the upstream half of `README.md`, `CONTRIBUTING.md` and `editors/vscode/CHANGELOG.md` with `_(No upstream file present…)_` — a destructive change that looks like a no-op. So review `git diff` afterwards: `editors/vscode/CHANGELOG.md` should now lead with the new version section, and `README.md`, `CONTRIBUTING.md` and `docs/upstream/*` should be untouched unless the upstream mirror actually moved. **Stop and investigate** on any `_(No upstream file present…)_`, and commit nothing gutted.

## The release commit

Staged by name: whichever of `editors/vscode/package.json`, `crates/pipelex-cli/Cargo.toml`, `crates/pipelex-py/Cargo.toml` and `js/tools-wasm/package.json` moved; `Cargo.lock` when a `Cargo.toml` did; `CHANGELOG.md`; `editors/vscode/CHANGELOG.md` from `make docs`; and `README.md`, `CONTRIBUTING.md` or `docs/upstream/*` only in the case where the upstream mirror genuinely moved.

## CI on the release pull request

- **`check.yml`** (job `make check`) and **`test-all.yml`** (job `make test-all`) — the two required status checks on both `dev` and `main`, per `docs/dev/ci-and-branch-protection.md`. `check.yml` additionally fails fast on a `"file:` dependency in `editors/vscode/package.json`, and ends with `git diff-index --quiet HEAD --`, so anything a step rewrites must already be committed.
- **`ci.yaml`** — runs on pull requests into `main` only: `test-python-bindings` (the job named `Test on Rust stable`, which builds the real `pipelex-tools-py` wheel with `maturin build --release --locked`, installs it and runs its tests — and is the very check `releases.yaml` later waits for on the tag), `toml_test`, and the three MSRV jobs on Rust 1.74. `auto_tag` does not run on a pull request: its `if:` admits a `workflow_dispatch`, or a push whose `github.ref_type` is `branch`. That `ref_type` test is load-bearing, because `ci.yaml` also triggers on the `plxt-cli`, `pipelex-vscode-ext` and `pipelex-tools-py` tag prefixes — it is what keeps `auto_tag` from re-running on the very tags it just pushed. None of these is a required check.
- **`releases.yaml`** — also runs on pull requests into `main`, as the packaging rehearsal: the extension is built and packaged with `vsce package`, and both wheel matrices are built and then installed and tested on Linux, macOS and Windows. Every publish is gated on `github.event_name == 'push'` — step by step inside the extension job, and at the job level for both PyPI publish jobs, which are skipped outright. `npm_publish_tools_wasm` is skipped outright as well and takes its build and test with it, deliberately, because it holds `id-token: write` while executing repository code — which is what leaves `@pipelex/tools-wasm` the one artifact with no pull-request rehearsal.

**Nothing in CI checks the version against the branch name, and nothing checks the changelog.** There is no version-check, no changelog-check and no branch guard in this repo, so those are this skill's job alone. The failure mode that follows is quiet rather than loud: a merge to `main` whose versions did not move leaves `auto_tag` finding every tag already present, no tag pushed, no `Releases` run, nothing published — and a green report. The registries have a quiet green of their own underneath that: both PyPI publishes pass `skip-existing: true`, and the npm job asks the registry first and turns an already-published version into a skip, so a re-run or a re-pushed tag on a version that is already out succeeds while publishing nothing. That is why the landing above reads the registries' answers and not only the runs.

## Particulars

- **The changelog headings carry no `v`.** They read `## [0.16.1] - 2026-08-14`, so write `## [X.Y.Z] - YYYY-MM-DD` here where the play's default would put a `v`. The branch name and the tags do carry it.
- **Entries are annotated per artifact.** A CLI-specific entry ends `(plxt X.Y.Z)`, a library one `(pipelex-tools-py X.Y.Z)`, an npm one `(@pipelex/tools-wasm X.Y.Z)`; one that ships in several names every one of them, comma-separated, which is the whole point of the convention. Extension-only entries carry no annotation. Earlier work leaves `(plxt >=X.Y.Z)`-style placeholders in `[Unreleased]`, and replacing them with the real numbers is part of writing the entry. The conventions are spelled out in `references/version-map.md`.
- **A schema refresh must ship all three engine bindings.** The MTHDS JSON Schema is `include_str!`-embedded into `plxt`, `pipelex-tools-py` and `@pipelex/tools-wasm`, so any one of them left behind keeps serving the stale schema. A `crates/pipelex-common` change reaches all three for the same reason, which is why the detection script marks them together.
- **`@pipelex/tools-wasm` is not bundled into the extension.** Nothing under `editors/vscode/` depends on it, so a change to `js/tools-wasm/` neither rides along on an extension release nor forces one — and it is also the artifact with no pull-request rehearsal, so after touching `js/tools-wasm/` or its publish job, run the `workflow_dispatch` dry run of `releases.yaml` before merging.
- **The extension pins `@pipelex/mthds-ui` to an exact version.** `editors/vscode/package.json` carries it as `npm:X.Y.Z`, an exact release of the sibling workspace repo whose graph renderer the extension bundles, so a release promoting graph work promotes whatever pin the base happens to hold. Read it against `npm view @pipelex/mthds-ui version` while summarizing what the release promotes rather than assuming it is current. Moving it is ordinary work that lands on the base first, not something the release commit carries.
- **No pre-release form.** No workflow here reads the branch name or the version shape at all, so nothing would refuse `release/v0.17.0-rc.1` — `auto_tag` would tag the version verbatim and publish it. Ship a plain `X.Y.Z`.
- **`git branch -f upstream origin/upstream` is work, not a landing gesture.** It moves a local ref, which the workspace guard classifies as work, so it is refused in the main checkout and belongs in the release worktree with the rest of the release.
- **Renaming `releases.yaml` breaks every publish.** The workflow filename is part of all four trusted-publisher registrations, on PyPI and on npm. That, the enterprise actions allowlist, the one-time publisher setup and the tag-recovery procedure are in `docs/dev/release-publishing.md`.
- **`publish-tools-wasm.sh` is the CI-down escape hatch only.** It defaults to publishing the committed version without bumping, deliberately: the version bump belongs to this skill and the publish belongs to CI. The other root-level publish script, `publish-lsp.sh`, is not part of a release and must not be run as one — it bumps `js/lsp/package.json`, publishes `@pipelex/lsp` to npm by hand, and then runs `yarn add @pipelex/lsp@latest` inside `editors/vscode`, which swaps the committed `portal:../../js/lsp` spec for a registry version that no gate in this repo catches.
