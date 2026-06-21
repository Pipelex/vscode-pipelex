---
name: bump-pipelex-version
description: >
  Bump the minimum pipelex-agent CLI version required by the Pipelex VS Code
  extension. Use when the user says "bump pipelex version", "raise the minimum
  pipelex-agent version", "require pipelex X.Y.Z", "update the min CLI
  version", "the extension needs a newer pipelex", or any variation of
  changing the pipelex CLI version floor that the extension enforces at
  runtime.
---

# Bump Minimum pipelex-agent Version

The extension cannot enforce a Python package version at install time — `pipelex` lives in the user's environment (often a per-project `uv` env). Instead it probes `pipelex-agent --version` at runtime and gates features that need a newer CLI, surfacing an actionable upgrade message when the installed CLI is too old. The whole mechanism rests on one constant.

**Single source of truth:** the exported minimum-version constant in `editors/vscode/src/pipelex/validation/agentCliVersion.ts` (currently `MIN_FORMAT_JSON_VERSION`). It is a `Semver` tuple `[major, minor, patch]`, not a string.

## Workflow

### 1. Determine the new version and the reason

You need two things: the target version `X.Y.Z`, and the motivating feature — which CLI capability the extension now relies on. The reason matters as much as the number: it goes in the doc comment and the changelog, and it's what tells the next person why the floor is where it is. If the user gave a version without a reason, infer it from the current branch's work or ask.

Show the current floor by reading the constant, then sanity-check that the target version actually exists: if the sibling `../pipelex` repo is present, confirm the version appears in its `CHANGELOG.md` or `pyproject.toml`; otherwise check PyPI (`curl -s https://pypi.org/pypi/pipelex/json | python3 -c "import json,sys; print(json.load(sys.stdin)['info']['version'])"`). Requiring a version that isn't released yet would break every user on update.

### 2. Update the constant

Edit `agentCliVersion.ts`:

- Set the tuple to the new version.
- Update the doc comment on the constant (and the module-level comment if it names the old floor) to record which feature requires the new minimum and which CLI version it landed in.
- If the constant's name no longer matches the motivating feature (e.g. it's named after `--format json` but the bump is for something else), rename it and update all importers (`grep -rn "MIN_" editors/vscode/src --include="*.ts"`). Prefer generalizing to `MIN_AGENT_VERSION` as soon as more than one feature shares the floor — list each feature and the version it landed in inside the doc comment. A feature-named constant that lies about its reason is worse than no name at all.

### 3. Check enforcement sites and stale references

Grep the constant name across `editors/vscode/src` to find consumers. The method graph panel (`graph/methodGraphPanel.ts`) enforces the floor and renders the "too old, needs ≥ X" upgrade message. The version *numbers* in those messages interpolate the constant via `formatSemver` and need no edit — but the *reason* text does not: the message explains in prose why the floor exists (e.g. "the `--format json` option landed in that release"), and that sentence becomes false after the bump. Rewrite it to name the new motivating feature, and read the surrounding comments for the same problem.

Distinguish two kinds of version mentions when sweeping (`grep -rn "<old X.Y.Z>" editors/vscode/src docs`):

- **Statements about the current floor** — update these.
- **Historical facts** (e.g. "`--format json` landed in 0.29.0", or released CHANGELOG entries) — leave them alone; they stay true forever.

If the motivating feature affects the diagnostics validator (`validation/pipelexValidator.ts`), note that it does not currently version-gate at all — flag this to the user and ask whether to extend the same check there, rather than silently widening scope.

### 4. Changelog

Add an entry to `CHANGELOG.md` under `## [Unreleased]` (create that section right below the title if it doesn't exist), in a `### Changed` block:

```
- Minimum supported `pipelex-agent` raised to X.Y.Z — required for <feature>
```

### 5. Verify

Run `cd editors/vscode && yarn test`. The existing tests use version strings only as mock probe output, not as assertions about the floor, so they normally pass unchanged — if one fails on a version literal, update the mock to a version at or above the new floor. For the full quality gate, run `make check` from the repo root.

### 6. Report

Show the version change `OLD → NEW`, the recorded reason, and the list of modified files.
