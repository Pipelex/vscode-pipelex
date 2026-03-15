---
name: release
description: Prepare a release for the Pipelex IDE extension and/or plxt CLI — detect changed components, bump versions in all relevant files, and update CHANGELOG.md with proper annotations. Invoke with /release when ready to cut a release.
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
- Which components have code changes (extension, cli, common)
- Current versions of all components
- Whether `[Unreleased]` in CHANGELOG.md has content

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
- Internal crates (pipelex-common, pipelex-lsp): only ask if they have changes; suggest keeping current unless public API changed

## Step 3b: Create release branch

If not already on a release branch, create one:

```bash
git checkout -b release/vX.Y.Z
```

where X.Y.Z is the new extension version (or CLI version if extension wasn't bumped).

## Step 4: Bump versions

Read `references/version-map.md` for file locations and the dependency cascade.

Edit version strings in:
- `editors/vscode/package.json` `.version` field (if extension bump)
- `crates/pipelex-cli/Cargo.toml` `version` under `[package]` (if CLI bump)
- Internal crate Cargo.toml files (if bumping those)
- Dependency version strings that reference bumped internal crates

After any Cargo.toml change, run:
```bash
cargo update --workspace
```

## Step 5: Update CHANGELOG.md

Read CHANGELOG.md and the commit history since the last release tag (use `git log <last_tag>..HEAD --oneline`).

The `[Unreleased]` section (if there is one) may already contain some entries, but it is often incomplete or empty. Your job is to **reconcile** it with the actual changes:

1. **Review commits** since the last release to understand what changed.
2. **Keep** any existing `[Unreleased]` entries that are still accurate.
3. **Add** entries for changes visible in the commit history that are not yet listed.
4. **Remove or correct** any entries that are outdated or inaccurate.

Use the standard subsections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) as appropriate. Write entries in the same style as existing changelog entries — concise, user-facing descriptions.

Then apply these transformations **as a single edit**:

1. **Rename** `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` where:
   - X.Y.Z = new extension version (or new CLI version if extension wasn't bumped)
   - YYYY-MM-DD = today's date
2. **Annotate** CLI-specific entries with `(plxt X.Y.Z)` using the new CLI version
3. **Replace** any `(plxt >=X.Y.Z)` placeholders with `(plxt X.Y.Z)` using the actual new version
4. Entries that are extension-only or affect both: leave without annotation

**Do NOT add a new empty `## [Unreleased]` section.** The versioned heading replaces `[Unreleased]` and becomes the first section in the file (after the title). An `[Unreleased]` section is added manually later when new work begins.

The result should look like:
```
# Pipelex IDE Extension and `plxt` CLI Changelog

## [X.Y.Z] - YYYY-MM-DD

### Changed
- (entries that were under [Unreleased])

## [previous version] - ...
```

## Step 6: Validate

Run checks for affected targets:
```bash
# If CLI changed:
cargo check -p pipelex-cli
# If extension/common changed:
cargo check -p pipelex-wasm --target wasm32-unknown-unknown
```

Report any failures before proceeding.

## Step 7: Summary

Show the user:
- All files modified and their old -> new versions
- The updated changelog section
- Remind them: pushing to `main` triggers CI auto-tagging and release publishing
