# Cross-file pipe-node navigation

Plan for making "click a pipe node in the method graph → reveal its code" work across `.mthds` files in the same bundle directory, not just the single file the panel was opened from. Scope (decided): **pipes only**, **strictly click-to-code** — concept navigation and `--pipe` graph-targeting are explicitly out of scope here and tracked as follow-ups (see "Deferred").

## Status: IMPLEMENTED (Phases 1–5 complete)

All five phases landed. Cross-file pipe navigation works end-to-end with source-first resolution and a scan fallback.

- **Upstream dependency confirmed.** The local editable `pipelex` (pinned by `../pipelex-demos`) emits `pipe_registry[ref].source` as **absolute paths**. Verified against `pipelex-demos/mthds-wip/recruitment_recursive`, a real signature/concrete split where `screen_candidates`'s `source` correctly points at the concrete `screen_candidates.mthds` (not the signature in `bundle.mthds`). Note: the global `pipelex-agent` on `PATH` is an older release that omits `source` — run via the demos venv (`pipelex-demos/.venv/bin/pipelex-agent`) to see it.
- **Phase 1–3 (the shippable unit).** New `validation/bundleResolution.ts` holds the single owner resolver (`resolveDeclaringFile`, `matchSourceFile`, `findDeclaringFileByScan`); `crossFileDiagnostics.resolveOwner` now delegates to its primitives so the error path and the navigation path can't drift. `methodGraphPanel` retains the GraphSpec (`currentGraphspec`, cleared on dispose), recovers a clicked node's `domain_code` + registry `source` (`lookupPipeNode`), and `navigateToPipe` resolves source-first → scan → primary fallback, sharing the open-and-reveal tail (`revealRangeBeside`) with `navigateToError`. Webview message contract unchanged (still posts bare `pipeCode`).
- **Phase 4 (tests).** `bundleResolution.test.ts` (unit: source variants, scan fallback, domain-disambiguated collision, not-found, path normalization) + new integration cases in `methodGraphPanel.test.ts` (source-first opens the concrete sibling; single-file regression; no-`source` scan fallback; synthesized-pipe silent log). Full extension suite green (`make test-ext`).
- **Phase 5 (docs).** New `docs/features/graph-pipe-navigation.md`; cross-linked from `docs/features/validation-backends.md`.
- **mthds-ui:** no update needed — everything consumed (`node.domain_code`, `pipe_registry[ref].source`) comes from the CLI GraphSpec; the bundled mthds-ui (v0.9.0) already fires `onNavigateToPipe`. The deferred bulletproof-identity upgrade (`onNodeSelect`) is also already available in v0.9.0, so it needs no bump either.
- **Deferred items remain deferred:** concept-to-code navigation and `--pipe` graph-targeting (see "Deferred").

## Problem

When a method is split across several bundles in one directory (e.g. pipe *signatures* in one `.mthds`, concrete *implementations* in another), clicking a pipe node whose code lives in a sibling file does nothing but log "Could not find [pipe.<code>]".

Root cause is a single hard-coded file. The click path is:

- `webview/adapter.ts` `onNavigateToPipe(pipeCode)` → posts `{ type: 'navigateToPipe', pipeCode }` (only the bare code travels — no file, no domain).
- `methodGraphPanel.ts` `handleWebviewMessage` → `navigateToPipe(pipeCode)` opens **`this.currentUri`** (the panel's primary file) and regex-scans *only that file* for `[pipe.<code>]` via `findTableHeader`. A sibling-declared pipe yields `-1` and the silent log.

The cross-file capability already exists elsewhere in the extension — the **validation-error list is already cross-file**: `gatherBundleFiles()` reads every `.mthds` in the directory and `resolveOwner()` (`validation/crossFileDiagnostics.ts`) finds which file declares a `[pipe.<code>]` / `[concept.<code>]`, then `navigateToError()` opens that owning file beside the panel. Pipe-click navigation simply never got routed through the same machinery.

## Approach: source-first, scan-as-fallback

The pipelex worktree branch `feature/Graph-improve-2` (pending merge) adds a declaration **source path** to the graph registries: `pipe_registry[pipe_ref]["source"]` (and `concept_registry[concept_ref]["source"]`), populated from `LibraryCrate.source_map`, keyed by `pipe_ref` = `domain.code`, value = the declaring file's path. The field is **omitted when unknown** (never `null`), and the collision reconciler makes `source` follow the *winning* declaration — so for a signature/concrete pair it points at the concrete implementation. That is exactly the multi-bundle case this plan targets.

So resolution is two-tier, and **feature-detected** (no `MIN_AGENT_VERSION` bump required):

1. **Source (exact).** If the clicked pipe's registry entry carries `source`, resolve that path to an on-disk URI and open it. No heuristics; keys on `domain.code` so same-named pipes in different domains resolve correctly.
2. **Scan (fallback).** If `source` is absent (older CLI, or unknown source), gather the sibling `.mthds` files and find the one that declares `[pipe.<code>]` — the existing error-path scan, optionally domain-filtered. Behaves like today's single-file path when the pipe is in the primary file.

In both tiers the `source`/owning file is **file-level**; the exact *line* still comes from `findTableHeaderInLines` scanning the resolved file for the `[pipe.<code>]` header. pipelex deliberately does not own editor-range semantics — line-finding stays a presentation concern in the consumer.

## Implementation

### Phase 1 — Retain the graphspec + identify the clicked node

- **Store the graphspec on the panel.** `sendGraphspecToWebview()` currently forwards the graphspec to the webview and discards it. Add `private currentGraphspec: GraphSpec | undefined` (cleared in `onDidDispose`, reset on every send). Needed to map a clicked pipe back to its registry `source` + `domain_code`.
- **Resolve the clicked node's identity.** `onNavigateToPipe(pipeCode)` surfaces only `pipeCode`. The panel looks the node up in `currentGraphspec` by `pipe_code` to recover its `domain_code`, forms `pipe_ref = domain_code + "." + pipe_code`, and reads `pipe_registry[pipe_ref]?.source`.
  - Edge: if the same `pipe_code` appears under two domains as two nodes in one graph, a bare `pipeCode` can't say which node was clicked. Acceptable for v1 (rare; the scan fallback still finds *a* correct declaration). The bulletproof upgrade is to also wire mthds-ui's `onNodeSelect(nodeId, nodeData)` — `nodeId` is unique and `nodeData` carries `domain_code` — and post `{ type: 'navigateToNode', nodeId }` instead. Recorded as an upgrade, not done here, to keep the message contract and the webview surface unchanged.

### Phase 2 — Shared declaring-file resolver

- **Extract a single resolver** so the error path and the navigation path can't drift (the "single source of truth for owner" intent is already stated in `crossFileDiagnostics.ts`). New small module, e.g. `validation/bundleResolution.ts`:
  - `resolveDeclaringFile({ kind, code, domainCode?, source?, files }): vscode.Uri | undefined`
  - Priority: (1) `source` path match — reuse `resolveOwner`'s existing `error.source` matching (slash-normalized; exact / basename / path-segment-suffix), which already tolerates absolute vs relative and bare-name vs path-qualified; (2) header scan `[kind.code]` across `files`, preferring the file whose `domain = "<domainCode>"` when `domainCode` is known.
  - Refactor `crossFileDiagnostics.resolveOwner` to delegate to this resolver (errors keep their `error.source` → `pipe_code` → `concept_code` order; navigation passes `source` + `domainCode`).

### Phase 3 — Rewrite `navigateToPipe`

- New flow:
  1. Look up node + `domain_code` + registry `source` from `currentGraphspec` (Phase 1).
  2. `files = await gatherBundleFiles(this.currentUri)`.
  3. `target = resolveDeclaringFile({ kind: 'pipe', code: pipeCode, domainCode, source, files })`.
  4. If `target` is undefined → keep today's behavior (scan `this.currentUri`); if still nothing, the same silent log line.
  5. Open `target` beside the panel and reveal the header line.
- **Extract the open-and-reveal tail** shared with `navigateToError` (both compute `targetCol` from the panel column, `showTextDocument`, set selection, `revealRange(... InCenter)`). One helper, e.g. `revealLineBeside(uri, line)`.
- **`graphspec-json` source kind stays disabled** for navigation (already guarded) — a run-graph JSON has no editable bundle in the workspace.

### Phase 4 — Tests (unit + integration; keep single-file green)

- **Unit — `resolveDeclaringFile`:** source-hit (absolute path, basename-only, relative-with-subdir), header-scan fallback, domain-disambiguated collision (two files, same `[pipe.process]`, different `domain`), not-found. Mirror the handler-test style in `crates/.../handlers/tests` / the extension's vitest layout.
- **Integration — multi-bundle fixture:** a directory with a signature bundle and a concrete bundle; a graphspec whose `pipe_registry[ref].source` points at the concrete file; assert `navigateToPipe` opens the concrete file and lands on the `[pipe.<code>]` line. Add the fixture under `test-data/mthds/<feature>/`.
- **Regression:** a pipe declared in the primary file still resolves to `currentUri` (no behavior change for the common single-file case).
- **Fallback path:** a graphspec with **no** `source` in the registry must still resolve via the scan (proves feature-detection degrades cleanly on an older CLI).

### Phase 5 — Docs

- Update the extension docs describing the graph panel to cover cross-file pipe navigation, the source-first/scan-fallback resolution, and the feature-detection behavior across CLI versions. Note the unsaved-sibling caveat (the scan reads disk, matching the error path).

## CHECKPOINT after Phase 3

Phases 1–3 are a coherent, shippable unit: cross-file pipe navigation working end-to-end with the scan fallback, before tests/docs harden it. Natural handoff point — re-confirm the `source` field is present in a real CLI build (or still on the worktree) before relying on tier 1, and decide whether to also pursue the `onNodeSelect` upgrade. Tests (Phase 4) and docs (Phase 5) follow.

## Decisions / edge cases recorded

- **No `MIN_AGENT_VERSION` bump.** `source` is additive and feature-detected; the scan fallback covers older CLIs. (Revisit only if we decide to *guarantee* exact resolution.)
- **Source path portability.** The resolver must tolerate absolute *and* relative `source` values (siblings load from a `.resolve()`-d parent dir → absolute; the primary's source is whatever path was passed). Reusing `resolveOwner`'s matching handles both. See the upstream feedback below — if pipelex normalizes `source`, this stays simple.
- **Unsaved sibling buffers.** The scan reads from disk (consistent with the error path's documented v1 behavior); the opened document still shows the live buffer. Reading unsaved buffers for resolution is a deferred refinement.

## Deferred (explicitly out of scope for this change)

- **Concept-to-code navigation.** `concept_registry[ref].source` makes the *data* side symmetric, and `resolveDeclaringFile` already takes `kind: 'concept'`. The remaining work is the **UI affordance**: concept/stuff nodes currently open the data inspector on click (`onStuffNodeClick`), so deciding where "go to concept definition" lives (e.g. the detail panel's `onConceptClick(conceptRef)`, stripping any `domain.` prefix / `[]` multiplicity per the concept-reference rule) is a separate design. Tight follow-up — reuses everything here.
- **`--pipe` graph-targeting.** Lets the panel graph a partial / no-`main_pipe` bundle by targeting a chosen pipe. Separable from click-to-code; folds the "graph a signature-only bundle" story together. See upstream feedback on the flag's shape before consuming it.

## Upstream dependency — pipelex `feature/Graph-improve-2` (consumer feedback)

This plan consumes the new registry `source` field. Feedback raised on that branch's shape (full notes in the review thread):

- **Normalize `source` path format.** Today it is inconsistent: siblings are absolute (resolved parent dir), the primary is whatever path the caller passed. A consumer can't assume a shared base. Prefer one convention (relative to the bundle/library root, consumer resolves) and document it. Keep it consistent with `error.source` so both can be matched by the same logic.
- **Absolute host paths in a wire artifact.** Fine for the local-CLI consumer (this extension), but if `GraphSpec` is ever returned by the API/hosted surface, leaking the server's absolute filesystem paths is wrong. Decide whether `source` is a local-only convenience or part of the contract; if the latter, make it root-relative.
- **CLI `--pipe` conflates two concerns.** On the CLI, `--pipe X` narrows *both* validation (to the pipe slice via `validate_pipe_in_bundle_core`) *and* the graph target. The protocol's `extra={"graph_pipe_code": X}` only retargets the *graph* and keeps whole-bundle validation. A CLI consumer that wants whole-bundle (cross-file) diagnostics **and** a graph of a chosen pipe has no flag for that. Consider a graph-only target on the CLI (distinct from `--pipe`), or document the validation-narrowing clearly.
- **`extra` bag vs typed param.** `graph_pipe_code` rides in an untyped `extra: dict[str, Any]` on the protocol's `validate`. For a spec'd MTHDS-protocol surface a typed field is more discoverable and validatable; if this is documented in `docs/specs/`, keep spec + conformance in sync.
- **Test the multi-file round-trip.** Coverage was added for passthrough/precedence; add a test asserting `pipe_registry[ref].source` (and the concept one) point at the correct *sibling* file for a genuine multi-bundle directory — that is the property this extension feature relies on.
