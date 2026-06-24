---
name: release
description: Prepare a release for the Pipelex IDE extension, the plxt CLI, and/or the pipelex-tools-py Python library — detect changed components, bump versions in all relevant files, and update CHANGELOG.md with proper annotations. Invoke with /release when ready to cut a release.
---

# Release Workflow

Run these steps in order.

## Step 1: Detect changes

Execute the detection script in the repo root:

```bash
bash .claude/skills/release/scripts/detect_changes.sh
```

If the user specified a base ref, pass `--base <ref>`.

Parse the structured output to identify:
- Which components have code changes (extension, cli, lib, common)
- Current versions of all components
- Whether `[Unreleased]` in CHANGELOG.md has content

`lib` is the `pipelex-tools-py` Python library (`crates/pipelex-py`) — an independently versioned, independently published artifact (its own `pipelex-tools-py/v*` tag), separate from the `plxt` CLI. It is built on the shared taplo/taplo-common engine, so a `common` change marks it affected too (the script already folds that in).

## Step 2: Report findings

Present to the user:
- Affected components and current versions
- File change counts by category
- Whether changelog has unreleased content

If only CI/docs changed (no code), inform the user and ask whether to proceed.

## Step 3: Ask bump type

Use AskUserQuestion to ask for each affected component:
- Extension: patch / minor / major (suggest patch)
- CLI: patch / minor / major (suggest patch)
- Library (`pipelex-tools-py`): patch / minor / major (suggest patch) — only ask if `lib: true`. Its version is independent of the CLI and extension.
- Internal crates (pipelex-common, pipelex-lsp): only ask if they have changes; suggest keeping current unless public API changed

## Step 3b: Create release branch

If not already on a release branch, create one:

```bash
git checkout -b release/vX.Y.Z
```

where X.Y.Z is the new extension version (or the CLI version if the extension wasn't bumped, or the library version if only the library was bumped).

## Step 4: Bump versions

Read `references/version-map.md` for file locations and the dependency cascade.

Edit version strings in:
- `editors/vscode/package.json` `.version` field (if extension bump)
- `crates/pipelex-cli/Cargo.toml` `version` under `[package]` (if CLI bump)
- `crates/pipelex-py/Cargo.toml` `version` under `[package]` (if library bump) — maturin reads this as the `pipelex-tools-py` PyPI version via `dynamic = ["version"]`; do not edit `crates/pipelex-py/pyproject.toml`
- Internal crate Cargo.toml files (if bumping those)
- Dependency version strings that reference bumped internal crates

After any Cargo.toml change, run:
```bash
cargo update --workspace
```

## Step 5: Update CHANGELOG.md

Read CHANGELOG.md and the commit history since the last release tag. Use the appropriate tag prefix for the component being released:
- Extension releases: `git log $(git tag -l 'pipelex-vscode-ext/v*' --sort=-v:refname | head -1)..HEAD --oneline`
- CLI-only releases: `git log $(git tag -l 'plxt-cli/v*' --sort=-v:refname | head -1)..HEAD --oneline`
- Library-only releases: `git log $(git tag -l 'pipelex-tools-py/v*' --sort=-v:refname | head -1)..HEAD --oneline`

The `[Unreleased]` section (if there is one) may already contain some entries, but it is often incomplete or empty. Your job is to **reconcile** it with the actual changes:

1. **Review commits** since the last release to understand what changed.
2. **Keep** any existing `[Unreleased]` entries that are still accurate.
3. **Add** entries for changes visible in the commit history that are not yet listed.
4. **Remove or correct** any entries that are outdated or inaccurate.

Use the standard subsections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) as appropriate. Write entries in the same style as existing changelog entries — concise, user-facing descriptions.

Then apply these transformations **as a single edit**:

1. If `## [Unreleased]` exists, **rename** it to `## [X.Y.Z] - YYYY-MM-DD`. If there is no `[Unreleased]` section, **create** a new `## [X.Y.Z] - YYYY-MM-DD` section at the top (after the title) with the reconciled entries. Where:
   - X.Y.Z = new extension version (or new CLI version if extension wasn't bumped)
   - YYYY-MM-DD = today's date
2. **Annotate** CLI-specific entries with `(plxt X.Y.Z)` using the new CLI version
3. **Annotate** library-specific entries with `(pipelex-tools-py X.Y.Z)` using the new library version
4. **Replace** any `(plxt >=X.Y.Z)` / `(pipelex-tools-py >=X.Y.Z)` placeholders with the actual new versions
5. Entries that are extension-only or affect both: leave without annotation

**Do NOT add a new empty `## [Unreleased]` section.** The versioned heading replaces `[Unreleased]` and becomes the first section in the file (after the title). An `[Unreleased]` section is added manually later when new work begins.

The result should look like:
```
# Pipelex IDE Extension and `plxt` CLI Changelog

## [X.Y.Z] - YYYY-MM-DD

### Changed
- (entries that were under [Unreleased])

## [previous version] - ...
```

## Step 5b: Regenerate generated docs

`editors/vscode/CHANGELOG.md` is a **generated** file (it carries a "do not edit directly" banner). It is composed from the root `CHANGELOG.md` plus the upstream Taplo changelog by `scripts/compose-docs.sh`. Nothing in CI runs that script — it only runs via `make docs` — so the generated changelog goes stale unless regenerated here. Now that the root `CHANGELOG.md` is finalized, regenerate it.

**Guard first — the script needs a local `upstream` mirror branch.** `compose-docs.sh` reads the Taplo docs from a branch named `upstream` (`git show upstream:...`). A normal checkout often only has the remote-tracking `origin/upstream`, not a local `upstream` branch. **If the local branch is missing the script silently deletes `docs/upstream/*` and replaces the upstream sections of `README.md`, `CONTRIBUTING.md`, and `editors/vscode/CHANGELOG.md` with a "_(No upstream file present)_" placeholder** — a destructive no-op-looking change. So ensure the mirror exists and is current first:

```bash
git fetch origin upstream
git branch -f upstream origin/upstream
make docs
```

Then review the result (`git status`, `git diff`). Expected:
- `editors/vscode/CHANGELOG.md` — now leads with the new `## [X.Y.Z]` section (this is the point of the step).
- `README.md`, `CONTRIBUTING.md`, `docs/upstream/*` — change **only** if the upstream mirror actually moved; otherwise they stay no-ops.

**Stop and investigate** if any upstream section collapses to "_(No upstream file present)_" — that means the `upstream` ref still wasn't found, and the fetch/branch step above must be fixed before continuing. Do not commit a gutted README/CONTRIBUTING/changelog.

Stage the regenerated files so they ship with the release.

## Step 6: Validate

Run checks for affected targets:
```bash
# If CLI changed:
cargo check -p pipelex-cli
# If extension/common changed:
cargo check -p pipelex-wasm --target wasm32-unknown-unknown
# If library changed (the PyO3 glue is behind the `python` feature, so a plain
# check skips the binding code that actually ships in the wheel):
cargo check -p pipelex-py --features python --locked
```

Report any failures before proceeding.

## Step 7: Summary

Show the user:
- All files modified and their old -> new versions
- The updated changelog section
- The regenerated docs from Step 5b (`editors/vscode/CHANGELOG.md`, plus any `README.md` / `CONTRIBUTING.md` / `docs/upstream/*` refreshed by `make docs`)
- Remind them: pushing to `main` triggers CI auto-tagging and release publishing
