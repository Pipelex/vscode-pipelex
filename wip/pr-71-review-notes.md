# PR #71 — deferred review follow-ups

Notes from triaging the automated-review threads on [PR #71](https://github.com/Pipelex/vscode-pipelex/pull/71) (`release/v0.15.0`). One confirmed-but-narrow race is deferred here; the other report was a false positive whose underlying design observation is worth keeping.

## Invalid verdict can map pipe refs against the previous render's registry (save-path race)

**Where:** `editors/vscode/src/pipelex/graph/methodGraphPanel.ts:769` (`applyAnalysis` → `currentPipeRegistryRefs`), installed at `sendGraphspecToWebview` (`:970`); bare-code inference gate at `editors/vscode/src/pipelex/graph/validationStatus.ts:107-110`.

**Reported by:** Codex (chatgpt-codex-connector), P2. Verified as a real race.

**The issue:** on save, two fire-and-forget flows start from two separate `onDidSaveTextDocument` listeners — the panel's `renderStaticGraph` (which installs the freshly built graphspec into `this.currentGraphspec` only at the end, in `sendGraphspecToWebview`) and the validator's `applyAnalysis` (which, for an invalid verdict, qualifies bare `pipe_code` errors through `this.currentGraphspec`'s `pipe_registry`). If the verdict lands before the rebuild installs the new spec, the issues are qualified against the *previous* render's registry. The late `renderStaticGraph` deliberately leaves an `invalid` payload untouched, so the stale/missing `pipeRef`s persist against the new graph until the next verdict — it does not self-heal. The `renderSequence` guard doesn't cover this: `applyAnalysis` captures the sequence *after* the same save already bumped it. The `refresh()` path is immune because it awaits `renderStaticGraph` before `applyAnalysis`.

**Why deferred:** every precondition must line up — a registry-changing save, the CLI analyze (a subprocess, nearly always slower than the local static rebuild) finishing *before* the rebuild installs the spec, an error carrying a bare `pipe_code` with no `domain_code` (most errors carry `domain_code` and never touch the registry), and an old-vs-new registry delta that changes the inference. Low production hit-rate; the clean fix adds real machinery (rebuilding a registry from disk per invalid verdict). Not release-branch material — deliberate no-overengineering call: defer.

**Recommended fix:** make the inference pool independent of retained render state. `applyAnalysis`'s invalid branch already gathers the on-disk bundle files (`gatherBundleFiles`); derive the registry from those same files via `buildStaticGraphSpecFromToml` (already imported), primary-first to match `resolveGraphPrimaryBundle`, and pass those refs to `validationErrorsToIssues` instead of `this.currentPipeRegistryRefs()`. That guarantees the inference pool matches the post-save content the verdict was produced against, with no timing dependence. (The lighter alternative — installing `currentGraphspec` earlier — only narrows the window and risks retaining a never-sent graph.)

**Test approach:** `editors/vscode/src/pipelex/__tests__/methodGraphPanel.test.ts`, next to the existing race test ("static rebuild finishing after a fast invalid verdict", which uses an unchanged registry and so passes today). Seed a retained graphspec with an OLD registry, drive a save whose freshly built registry differs (a bare `pipe_code` ambiguous in the old registry but unique in the new), land the invalid verdict via `applyAnalysis` before the rebuild completes, and assert the resulting `issue.pipeRef` reflects the NEW registry. Fails pre-fix, passes post-fix.

**PR thread:** https://github.com/Pipelex/vscode-pipelex/pull/71#discussion (thread left open — Codex comment on `methodGraphPanel.ts:769`).

## Pipe-type enum collector is coupled to schema shape (latent, not a live bug)

**Where:** `crates/taplo-common/src/schema/mod.rs:148-165` (`mthds_known_pipe_types`).

**Reported by:** Greptile, P1 — as filed it was a **false positive**: the collector only matches `properties.type.enum`, which exists solely on the `Pipe*Blueprint` definitions in the bundled schema; the cited `text`/`preset`/`fixed` are definition-level enums with no `properties` key and are structurally unreachable, and a pipe with `type = "text"` still gets a discriminator error (thread replied and resolved). What remains is the *latent* observation underneath.

**The observation:** the collector scans **all** schema definitions rather than the actual pipe union. It is correct today only because the `Pipe*Blueprint` defs are the sole holders of `properties.type.enum`. If a future non-pipe definition ever gained a `properties.type.enum` whose value lacked a matching `{Value}Blueprint`, that value would pass the synthetic discriminator check and skip blueprint validation.

**If ever hardened:** anchor the collector to the genuine pipe union — resolve the `$ref`s in `/properties/pipe/anyOf[0]/additionalProperties/oneOf` and read `properties.type.enum` only from those branches. Behavior-identical today, so purely defensive; do it only if/when the schema shape actually moves that way.
