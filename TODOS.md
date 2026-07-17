# Plan: display validation errors & suggested fixes on the graph

**Status: not started** — update this line at every checkpoint.

## Context (read this on cold start)

The static-first method graph flow is done and committed: the VS Code extension builds the graph statically via `@pipelex/mthds-ui`'s `buildStaticGraphSpecFromToml`, runs `pipelex-agent validate` in the background, and shows the verdict in a toolbar **validation widget** (states validating/valid/invalid/error) with a dropdown listing `ValidationIssue`s (message, `pipe.x`/`concept.y` context chip, suggested fix, owning file). See `docs/features/method-graph.md` and mthds-ui's `docs/validation-widget.md`.

**This plan adds the next layer: decorating the graph nodes themselves with those issues** — severity ring + count badge on the affected pipe cards, tooltip with messages and suggested fixes, panel↔node navigation. All visual/design work happens in **mthds-ui**; the extension only enriches the issues it already sends.

- Repos/branches: `../mthds-ui` on `feature/Validation` (base for diffs: commit `88de074`), `vscode-pipelex` on `feature/Static-graph` (base: `e418d95`).
- The extension consumes local mthds-ui via `portal:../../../mthds-ui` (uncommitted `editors/vscode/package.json`/`yarn.lock` changes — **keep them uncommitted**; the pre-commit hook forbids committing the portal spec, so extension commits are path-scoped with `--no-verify`, always excluding `package.json`/`yarn.lock`).
- Dev loop: after any mthds-ui edit → `npm run build` in `../mthds-ui`, then `make ext` here. mthds-ui gate: `npm run check`. Extension gate: `cd editors/vscode && yarn typecheck && yarn test` (`make check` fails by design while the portal spec is present — use `make test`).
- Manual test asset: `../pipelex-demos/mthds-wip/bad_static/` — a deliberately broken bundle whose README maps each planted mistake to the static diagnostic it triggers, plus a node snippet to run the static builder outside the extension.

### Design decisions (locked with Louis)

- **Targeting model**: extend `ValidationIssue` with optional `pipeCode?: string` (decorates every node invoking that pipe) and `nodeId?: string` (one precise invocation). Issues without a resolvable target (bundle-level `toml-parse-error`, skipped pipes that never became nodes) stay panel-only — no failure mode.
- **Single source of truth**: decorations derive from the same `validationIssues` prop that feeds the widget dropdown. No new host↔webview protocol; enriched issues ride the existing `setValidationStatus`/`setData.validation`.
- **Visuals**: severity ring (error red / warning amber via `--color-error`/`--color-warning` palette tokens, worst severity wins per node) + corner count badge; warnings get a subtler ring than errors. Layout-neutral (outline/box-shadow + absolutely positioned badge — node size must not change, so no re-layout / viewport reset on verdict flip).
- **Do not reuse the run-status dot** — validation (authoring-time) and status (execution-time) stay separate visual channels.
- **Folding**: a folded controller rolls up its descendants' issues into its own badge, so folding never hides an error.
- **Interactions**: panel row click = host source-jump **and** graph pan/flash to the target node (both-on-click); node badge click opens the validation panel.
- **Deferred (v2, not in this plan)**: concept-targeted issues decorating IO pills; ancestor-fallback targeting for skipped-node diagnostics.

---

## Phase 1 — mthds-ui: targeting model + static-mapper auto-fill

- [ ] Extend `ValidationIssue` in `src/graph/types.ts` with optional `pipeCode` and `nodeId` (React-free, documented).
- [ ] Auto-fill targets in `staticDiagnosticsToValidationIssues` (`src/static-graph/validationIssues.ts`): a `path` starting with `pipe.<code>` → `pipeCode`; a walk-phase path containing `/` (a node id, e.g. `domain.pipe/step_2`) → `nodeId`; concept paths and pathless diagnostics → no target.
- [ ] Unit tests: each mapping rule, including the no-target cases (`toml-parse-error`, `concept.*`, entry-pipe diagnostics without a path).

## Phase 2 — mthds-ui: node decorations (ring + badge + tooltip)

- [ ] Derive a per-node decoration map in `GraphViewer.tsx` from `validationIssues`: `nodeId` matches exactly; `pipeCode` matches every node with that `pipe_code`; aggregate per node (worst severity, count, messages + suggested fixes for the tooltip). Pure helper + unit tests.
- [ ] Thread the decoration into node data (`pipeCardTypes.ts` / where `PipeCardData` is assembled in `GraphViewer.tsx`) for both `PipeCardNode` and `ControllerGroupNode`.
- [ ] Render in `PipeCardBase.tsx` + `ControllerGroupNode.tsx`: severity ring class + corner count badge, `title` tooltip listing messages and `Fix: …` lines. Styles in `graph-core.css` **only** (the extension's `scripts/build.mjs` copies a fixed CSS list — no new CSS file), palette-token colors for light/dark.
- [ ] Fold roll-up: when a controller is folded, its badge aggregates descendant issues (reuse the fold logic's descendant knowledge in `GraphViewer.tsx`).
- [ ] Component tests (vitest) + a Storybook story rendering the decorated static graph from the existing broken-bundle fixture.

### ⛔ CHECKPOINT 1 — decorations land

1. **Verify**: mthds-ui `npm run check` green; Storybook story visually correct in both themes (ring/badge on the right nodes, no layout shift, fold roll-up works).
2. **Commit** the mthds-ui work on `feature/Validation` (normal commit; record the SHA here).
3. **Update this file**: tick boxes, update the Status line, note decisions taken / surprises / anything a cold-started session needs.
4. **Fan out review**: spawn a **Sonnet-5 sub-agent with no inherited context** (fresh agent, not a fork) to run the `/code-review` skill. Hand it **only** a pointer to the changes — `cd /Users/lchoquel/repos/Pipelex/mthds-ui && git diff 88de074..HEAD` (or the phase commit SHA) — never this plan, the rationale, or my conclusions. We want clean solid software, not over-engineering. Triage its findings, fix what's real, re-run the gate, commit fixes.

## Phase 3 — mthds-ui: interactions + polish

- [ ] Panel→graph: on a row click with a target, pan/flash the node (ReactFlow `setCenter` + a temporary highlight class) **in addition to** invoking `onValidationIssueClick` (host source-jump unchanged).
- [ ] Graph→panel: node badge click opens the validation panel (scrolled/filtered to that node's issues if cheap; plain open is acceptable).
- [ ] Tests for both directions (helper-level, same style as the existing widget tests).
- [ ] Update `docs/validation-widget.md`, the ValidationWidget story, and `CHANGELOG.md` `[Unreleased]`.

### ⛔ CHECKPOINT 2 — mthds-ui side complete

1. **Verify**: `npm run check` + `npm run build` green; manual Storybook pass of the full loop (badge → panel → row click → node flash).
2. **Commit** on `feature/Validation`; record the SHA here.
3. **Update this file** for cold start (status, SHAs, anything learned).
4. **Fan out review**: same convention as Checkpoint 1 — fresh no-context **Sonnet-5** sub-agent running `/code-review` on `git diff <checkpoint-1 SHA>..HEAD` in `../mthds-ui`, pointer only. Triage, fix, re-gate, commit.

## Phase 4 — extension: validator-issue targets + end-to-end verification

- [ ] Rebuild mthds-ui (`npm run build`) so the portal exposes the new types; `make ext`.
- [ ] Fill `pipeCode` in `validationErrorsToIssues` (`editors/vscode/src/pipelex/graph/validationStatus.ts`) from the already-parsed `errorContext` (`pipe.<code>` → code). Static issues get targets for free via the mthds-ui mapper.
- [ ] Extend the mapper unit tests (`validationStatus.test.ts`) and any `methodGraphPanel.test.ts` payload assertions the new field touches.
- [ ] Update `docs/features/method-graph.md` (decorations paragraph), root `CHANGELOG.md` `[Unreleased]`, regenerate `editors/vscode/CHANGELOG.md` via `./scripts/compose-docs.sh`, and the CLAUDE.md Graph Rendering section if the flow description changed.
- [ ] End-to-end against `../pipelex-demos/mthds-wip/bad_static/`: open `bundle.mthds` → decorated static graph immediately; verdict flips widget to invalid → validator-targeted decorations; bogus `pipelex.validation.agentCliPath` → error state keeps static-issue decorations; graphspec-json view → no widget, no decorations.

### ⛔ CHECKPOINT 3 — done

1. **Verify**: extension `yarn typecheck` + `yarn test` + `make test` green; mthds-ui `npm run check` still green; the end-to-end pass above done in the Extension Host (`make ext-install`).
2. **Commit** the extension work on `feature/Static-graph` (path-scoped, `--no-verify`, excluding `editors/vscode/package.json`/`yarn.lock`); record the SHA here.
3. **Update this file**: final status, both repos' SHAs, and the release reminder below.
4. **Fan out review**: fresh no-context **Sonnet-5** sub-agent running `/code-review` on the extension diff (`git diff e418d95..HEAD` or the phase SHA), pointer only. Triage, fix, re-gate, commit.

## Not in this plan (standing reminders)

- Release mthds-ui (0.13.0), then `make use-npm` here before any merge — CI `make check` and the pre-commit hook require the npm spec.
- v2 candidates: concept-targeted IO-pill decoration; ancestor-fallback targeting for diagnostics about skipped nodes.
