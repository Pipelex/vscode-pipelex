# Branch guide: `feature/Static-graph` — static-first method graph, validation widget, node decorations

**Status: implementation complete — this document describes the branch for reviewers (human or agent).** It explains what changed, why, and where the load-bearing decisions live, so a review can focus on the right things.

## What this branch does

The Method Graph panel used to be blocking and brittle: opening it ran `pipelex-agent validate --view`, and an invalid bundle (or a missing CLI) replaced the graph with an error page. This branch inverts the flow — **the graph renders instantly and validation becomes an asynchronous verdict layered on top**:

1. **Static-first graph.** The extension host builds the GraphSpec itself from the bundle's raw `.mthds` TOML via `@pipelex/mthds-ui`'s static-graph module (`buildStaticGraphSpecFromToml`, primary file first). No pipelex round-trip, works when the method is invalid or pipelex isn't installed. `pipelex-agent validate` still runs, but in the background and **only for the verdict** (never `--view`).
2. **Toolbar validation widget.** The verdict drives a widget in the graph toolbar (states: `validating` / `valid` / `invalid` / `error`) with a dropdown listing the issues — message, `pipe.…`/`concept.…` locator chip, owning file, suggested fix — and index-based click-to-navigate. Full-page message views remain only for pre-graph failures (unreadable files, missing webview assets, invalid graphspec JSON).
3. **Node decorations** (the top layer, added last): issues that target a pipe decorate the graph nodes themselves — severity ring + count badge, tooltip with messages and `Fix:` lines, fold roll-up, badge-click opens the dropdown, row-click pans/flashes the node. The rendering lives in `@pipelex/mthds-ui` **0.14.0**; the extension only fills each issue's target (`pipeCode` from the validator error's `pipe_code`; static diagnostics carry targets auto-filled by the mthds-ui mapper).

## Where the code is

Extension host (all under `editors/vscode/src/pipelex/`):

- `graph/methodGraphPanel.ts` — the panel. Static build + send (`renderStaticGraph`), verdict lifecycle (`applyAnalysis` / `applyBackendError` / `applySkipped`), the per-state issue-list policy, index-based navigation (`navigateToError`, sparse `errorTargets`), and the `setData` / `setValidationStatus` protocol.
- `graph/validationStatus.ts` — the pure, unit-testable half: `GraphValidationIssue` (local mirror of mthds-ui's `ValidationIssue`, structurally assignable), `validationErrorsToIssues` (fills `pipeCode`), `errorContext`, `parseStaticIssueContext`, `describeBackendErrorIssue`.
- `graph/webview/adapter.ts` — webview entry; mounts mthds-ui's `GraphViewer` and forwards `validationState`/`validationIssues` props; handles the lightweight `setValidationStatus` message (no re-layout, no viewport reset).
- `validation/backend.ts`, `validation/pipelexValidator.ts`, `validation/types.ts` — `analyze(…, { withGraph: false })` option so the verdict call skips `--view`; the on-save validator hands its single analyze result to the panel (`setGraphSink`).

Renderer (sibling repo `mthds-ui`, released as `@pipelex/mthds-ui` 0.14.0, consumed via the npm pin in `editors/vscode/package.json`):

- `ValidationIssue` targeting fields (`pipeCode` / `nodeId`), `staticDiagnosticsToValidationIssues` auto-fill, `graphValidation.ts` (decoration map builder, fold-aware, pure + tested), ring/badge rendering in `PipeCardBase` / `ControllerGroupNode`, panel↔node navigation in `GraphViewer`. See mthds-ui's `docs/validation-widget.md` and its `CHANGELOG.md`.

## Review pointers (what to scrutinize)

- **Staleness discipline.** Every async boundary in `methodGraphPanel.ts` re-checks `this.panel` and `this.currentUri` after awaits (file reads, gathers, config resolution). A missed re-check shows up as a verdict or graph applied to the wrong file. Same-URI ordering is guarded separately by a monotonic `renderSequence` (an older save's slower rebuild must not post over a newer one), which verdicts also join: `applyAnalysis` stamps the sequence on entry and re-checks it after its issue-resolution reads, so a superseded verdict is dropped instead of posting over a newer save's `validating`. A rebuild finishing *after* the verdict re-composes the static portion of the widget state (fresh warnings under `valid`, fresh static tail under `error`) rather than keeping the previous render's issues. Two more ordering/lifecycle rules to scrutinize: the validator's synchronous skip verdict is **microtask-deferred** past the save dispatch (its listener runs before the panel's — a sync `applySkipped` would be clobbered by the panel's `validating` flip, spinning forever), and `pipelex.validation.enabled: false` gates the panel's analyze entirely (static-only render, widget hidden, no backend run). The static build itself is wrapped — a builder throw (e.g. `domain = "constructor"`, an mthds-ui 0.14.0 bug) falls back to a Graph Error view instead of an unhandled rejection.
- **Helper vs primary anchoring.** `applyAnalysis(uri, analysis, analysisPrimaryUri)` carries both the shown file (staleness checks, owning-file labels) and the bundle the analysis anchored on (fallback owner for unattributed errors, matching the Problems panel). Passing the shown helper as the anchor is the bug shape to watch for.
- **Issue-list ↔ target alignment.** `errorTargets` is positional and sparse; every `postValidationStatus` call must pass targets index-aligned with its issues (note the `[undefined, ...staticTargets]` pattern when a lead issue is prepended).
- **Race: fast verdict vs static rebuild.** On save, the panel flips to `validating` *synchronously* before its async static rebuild so a fast validator verdict can't be overwritten (`renderStaticGraph` only claims the widget when the state is still `validating`).
- **Security posture unchanged.** The webview navigates by index only (never a path); `setHtml` nonce/CSP handling is untouched apart from flowing through.
- **Docs are part of the change**: `docs/features/method-graph.md` (flow + per-state issue policy + decorations), `CLAUDE.md` Graph Rendering section, root `CHANGELOG.md` (`editors/vscode/CHANGELOG.md` is generated — edit the root one and run `./scripts/compose-docs.sh`).

## Testing

- `editors/vscode`: `yarn typecheck && yarn test` (vitest) — panel behavior (`methodGraphPanel.test.ts`, `pipelexValidator.test.ts`) and the pure helpers (`validationStatus.test.ts`). `make check` runs the full repo gate.
- Renderer-side logic (decoration mapping, fold roll-up, interactions) is tested in mthds-ui: unit tests + headless-Chromium Storybook play tests.
- Manual/e2e asset: `../pipelex-demos/mthds-wip/bad_static/` — a deliberately broken bundle whose README maps every planted mistake to the static diagnostic it triggers. The full data path (bundle → static spec + diagnostics → auto-targeted issues → decoration map → per-issue navigation targets, plus the folded roll-up) was exercised end-to-end against this bundle with the released `@pipelex/mthds-ui` 0.14.0: targeted issues decorate rendered nodes, skipped-node diagnostics stay panel-only, and the webview bundle built by `make ext` carries the decoration code and styles.

## Out of scope / deferred (v2 candidates)

- Concept-targeted issues decorating IO pills.
- Ancestor-fallback targeting for diagnostics about nodes the static walk skipped (they stay panel-only today, by design).
