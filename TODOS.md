# Display validation errors in the method graph view

**Branch:** `feature/Display-validation-errors`
**Goal:** When a `.mthds` bundle fails validation and therefore produces *no* method graph, the graph panel must show the actual validation errors — clearly, with cross-file context, and clickable so the user can jump straight to the offending line. This replaces the current flat, dead-text list.

---

## TL;DR of the work

A minimal version already ships (commit `7c34561` "Show actual validation errors in graph pane instead of hardcoded messages"). It renders `error.message` + an optional `pipe.X` / `concept.Y` label as a static `<ul>`. This task upgrades it to a *proper* error view:

> **STATUS: DONE.** All phases implemented; full test/build gate green (Rust fmt/clippy/tests, vitest 178 passing, CLI + WASM cargo check). Manual Extension-Host verification (recipe at the bottom) is the only remaining hands-on step.

- [x] Header with an error count + guidance ("Fix and save to regenerate the graph").
- [x] Per-error **owning file** shown (basename) when the error lives in a sibling.
- [x] Each error row is **clickable** → opens the owning file at the error's line in the editor column beside the panel.
- [x] A **Retry** button, matching every other error view in this panel.
- [x] Tests + docs + changelog.

If you only read one thing: the display already works for both backends; we're making it navigable and informative, not building it from zero.

---

## Background — how the current flow works (cold-start context)

### The display path
`editors/vscode/src/pipelex/graph/methodGraphPanel.ts`:

- `applyAnalysis(uri, analysis)` (≈ L314–334) is the single decision point:
  1. `analysis.graph` truthy → render the rich ReactFlow webview.
  2. `!validation.ok && validation.errors.length > 0` → `setHtml(errorListHtml('Validation Errors', validation.errors.map(toErrorListEntry)))`.
  3. else → `messageHtml('No Graph Available', …)` (valid bundle, but no `main_pipe` → no graph).
- `toErrorListEntry(error)` (≈ L773–780) shapes a `ValidationErrorItem` into `{ message, context }` where `context` is `pipe.<code>` / `concept.<code>` / undefined.
- `errorListHtml(title, entries)` (≈ L782–806) renders a static `<ul>` — **no script, no navigation, no file info, no count, no Retry.**

### Who calls `applyAnalysis` (two entry points)
1. **On save, panel open** — `PipelexValidator.onSave` (`validation/pipelexValidator.ts` ≈ L117–119) runs ONE `analyze({ withGraph })` and calls `graphSink.applyAnalysis(uri, analysis)`. `withGraph` is true only when `graphSink.isShowingMthds(uri)`. The validator has **already gathered the bundle files** (`gatherBundleFiles`, L106) and **already computed per-file diagnostics** (`buildBundleDiagnostics`, `applyValidation` L134–153).
2. **Panel self-refresh** — `MethodGraphPanel.refresh` (≈ L254–300) calls `applyAnalysis(uri, analysis)` directly. This path only runs the on-save self-refresh when validation is *disabled* (see the `onDidSaveTextDocument` handler L54–71). On the CLI backend it does **not** gather files (`files = []`, L278); on the API backend it does.

### Both backends already produce the errors-without-graph shape
- CLI: `cliValidationBackend.ts` `handleSpawnError` → exit 1 + parseable JSON → `{ validation: { ok:false, errors }, graph: null }` (≈ L105).
- API: `apiValidationBackend.ts` → `is_valid:false` 200 body → `{ validation: { ok:false, errors }, graph: null }` (≈ L119–123).

So **both backends already reach branch (2)** of `applyAnalysis`. No backend changes are needed.

### Error → source location resolution already exists (reuse it!)
`validation/crossFileDiagnostics.ts`:
- `buildBundleDiagnostics({ errors, files, primaryUri, diagnosticSource, primaryDocument })` maps each error onto its owning file + range.
- `resolveOwner(error, files, getLines)` (L82–122) picks the owning file in priority order: `error.source` match → declaration scan for `[pipe.<code>]` / `[concept.<code>]` → undefined (caller falls back to primary).
- Ranges come from `validation/sourceLocator.ts`: `locateError(error, document)` (open doc, exact), `locateErrorInLines(error, lines)` (sibling on-disk text), `findTableHeaderInLines(lines, kind, code)`.

This is exactly the (uri, range) resolution the clickable list needs. **Extract it once and share** — don't reimplement.

### Webview plumbing (cold-start context)
- `handleWebviewMessage` (≈ L565–598) handles `webviewReady`, `retry`, `runCommand` (whitelisted), `navigateToPipe`, `openExternally`. We add `navigateToError`.
- `navigateToPipe(pipeCode)` (≈ L620–645) is the model for editor navigation: it finds the `[pipe.<code>]` header, opens the doc in `targetCol` (the column beside the panel), sets the selection, and reveals the range. Reuse its column logic.
- `setHtml` "simple HTML" branch (≈ L661–675) nonces `<style>` tags and — only when the HTML contains `RETRY_NONCE_SENTINEL` — swaps that token for the real nonce and adds `script-src 'nonce-…'`. So **any script we add to `errorListHtml` must carry `RETRY_NONCE_SENTINEL` as its nonce placeholder**, exactly like `messageHtml`'s actions script (≈ L723–749).
- `escapeHtml` is imported from `../htmlEscape`. All interpolated error text MUST stay escaped (there's an existing security test asserting attacker-influenced text never gets a nonce — keep it green).

---

## Design decisions (locked)

1. **Navigate by index, never by path.** The webview posts `{ type: 'navigateToError', index }`; the extension keeps the resolved `{ uri, range }[]` in a private field (`errorTargets`) and looks up by index. The webview can never request an arbitrary file path — mirrors `toPanelAction`'s "messages built from our own constants" posture and the `WEBVIEW_ALLOWED_COMMANDS` allowlist.
2. **One shared resolver.** Extract `resolveErrorLocations(errors, files, primaryUri, primaryDocument?) → { error, uri, range }[]` (order-preserving) from `crossFileDiagnostics.ts`, and make `buildBundleDiagnostics` build its per-file grouping on top of it. Single source of truth for owner+range — diagnostics and the panel list can never drift.
3. **`applyAnalysis` gathers lazily, only on the error branch.** Make `applyAnalysis` async; in branch (2) call `gatherBundleFiles(uri)` + read the open primary document, run `resolveErrorLocations`, store `errorTargets`, render. Cost is a few sibling-file reads on the (rare) error path. The validator already gathered files, but threading them through `GraphAnalysisSink.applyAnalysis` would change the interface for both callers — gathering locally keeps the change contained. (Alternative if perf ever matters: widen the sink signature to pass `files`; noted, not chosen.)
4. **Owning-file label is conditional.** Show the basename only when the owner differs from the primary file (or the bundle has > 1 file). Single-file bundles stay clean.
5. **Scope: `.mthds` only.** Graphspec-JSON source never yields validation errors; `navigateToError` early-returns when `sourceKind === 'graphspec-json'`, like `navigateToPipe` does.

---

## Implementation phases

### Phase 0 — Reproduce current behavior (baseline)
- [ ] Open a `.mthds` bundle with a deliberate validation error (e.g. a pipe referencing a missing concept) with the graph panel open; save.
- [ ] Confirm the panel currently shows the static error list (no count, no file, not clickable, no Retry). Screenshot/note for the before/after.
- [ ] Confirm a multi-file bundle where the error lives in a *sibling* file still shows the error (it does — `resolveOwner` handles it for diagnostics) and note that the current list gives no hint which file it's in.

**Checkpoint 0:** baseline captured; the gap is concretely understood for both single- and multi-file bundles.

### Phase 1 — Extract the shared error-location resolver
- [ ] In `crossFileDiagnostics.ts`, add `export function resolveErrorLocations(args): { error: ValidationErrorItem; uri: vscode.Uri; range: vscode.Range }[]` that preserves input order. Move the owner-resolution + range logic from `buildBundleDiagnostics`'s loop into it.
- [ ] Rewrite `buildBundleDiagnostics` to call `resolveErrorLocations` and then group by uri + `makeDiagnostic`. Behavior must be byte-for-byte identical (the existing `crossFileDiagnostics.test.ts` must pass unchanged).
- [ ] Run `cd editors/vscode && yarn test` — `crossFileDiagnostics.test.ts` green.

**Checkpoint 1:** resolver extracted, diagnostics unchanged, all existing tests green. Safe handoff point.

### Phase 2 — Enrich the error-list view (no navigation yet)
- [ ] Change `applyAnalysis` to `async`. Update its two call sites: `refresh()` (`await`) and `PipelexValidator.onSave` (already fire-and-forget `void`; leave as is or `void`-annotate). `GraphAnalysisSink.applyAnalysis` return type in `backend.ts` → `void | Promise<void>` (keep callers tolerant).
- [ ] In the error branch: `const files = await gatherBundleFiles(uri)`; find the open primary `TextDocument` (via `vscode.workspace.textDocuments`); call `resolveErrorLocations`. Stash results in a new `private errorTargets: { uri: vscode.Uri; range: vscode.Range }[]`.
- [ ] Extend `toErrorListEntry` / the entry shape to also carry the owning-file basename (when ≠ primary) and the original index.
- [ ] Rewrite `errorListHtml` to render: a header (`N validation errors — fix and save to regenerate the graph`), per-row context chip (`pipe.X` / `concept.Y`) + optional file chip, the escaped message, and a Retry button. Keep the existing CSS vars / styling idiom. Do **not** add the click script yet — land the visual upgrade first.
- [ ] Add Retry: reuse the `messageHtml` script pattern (button id `pipelex-retry`, posts `{ type: 'retry' }`, script nonce placeholder = `RETRY_NONCE_SENTINEL`).
- [ ] Manually verify single-file and multi-file bundles render the count, message, and (multi-file) the correct basename; Retry re-runs.

**Checkpoint 2:** the view is informative (count + file context) and consistent (Retry), even before clicks work. Good place to pause if context is tight.

### Phase 3 — Clickable navigation
- [ ] Render each error row with `data-error-index="<i>"` and `role="button"` / cursor styling so it reads as clickable.
- [ ] In the error-list inline script (the one already carrying `RETRY_NONCE_SENTINEL` from Phase 2), wire a click listener on each row that posts `{ type: 'navigateToError', index: i }`.
- [ ] In `handleWebviewMessage`, add a `navigateToError` case: ignore when `sourceKind === 'graphspec-json'`; bounds-check `index` against `errorTargets`; call a new `navigateToError(target)`.
- [ ] Implement `private async navigateToError(target)`: open `target.uri` (which may be a sibling file) in `targetCol` (reuse the column math from `navigateToPipe`), set selection + `revealRange(InCenter)` to `target.range`. Log + no-op on failure (match `navigateToPipe`'s error handling).
- [ ] Manually verify: clicking an error in a single-file bundle jumps to the line; clicking a sibling-owned error opens the sibling file at the right line; an error with no locator info opens the owning file at its top (range 0,0) without throwing.

**Checkpoint 3:** feature-complete behavior. Remaining work is tests + docs.

### Phase 4 — Tests
- [ ] `crossFileDiagnostics.test.ts` (or a new sibling): unit-test `resolveErrorLocations` — order preserved; `source`-owned, pipe-code-owned, concept-code-owned, and fallback-to-primary cases; range comes from the open document vs on-disk lines.
- [ ] `methodGraphPanel.test.ts` (extend; follow existing patterns at L390+ for Retry and L236+ for `navigateToPipe`):
  - [ ] Invalid analysis → `setHtml` output contains each escaped message, the count header, and a Retry button.
  - [ ] Multi-file bundle → output contains the sibling basename for the sibling-owned error.
  - [ ] Clicking a row posts `navigateToError` with the right index; the handler opens the expected document at the expected line/column.
  - [ ] `navigateToError` with an out-of-range index is a safe no-op.
  - [ ] `navigateToError` is ignored for `graphspec-json` source.
  - [ ] Security: extend the existing "never blesses attacker-influenced error text with a nonce" test (L488) to cover the new error-list script — only the trusted script token gets the nonce; a `</script>`/`<img onerror>` in `error.message` stays inert and escaped.
- [ ] `cd editors/vscode && yarn test` green.

**Checkpoint 4:** behavior locked by tests.

### Phase 5 — Docs, changelog, quality gate
- [ ] Update `docs/features/validation-backends.md` (the doc that already describes "validates on save and renders method graphs") with a short subsection: when a bundle is invalid the graph panel shows the validation errors, each clickable to its source. Add it where the graph/diagnostics behavior is described.
- [ ] Add a CHANGELOG entry under `editors/vscode/CHANGELOG.md` (and root `CHANGELOG.md` if that's the release convention — check what the last release touched). Describe it as a user-facing improvement to the method graph panel. No version bump here unless cutting a release (use `/release` for that).
- [ ] Run the full gate: `make check` (fmt, plxt fmt, clippy `-D warnings`, crate tests, vitest, WASM check). For a TS-only change `yarn test` is the relevant slice, but `make check` is the merge gate.
- [ ] Self-review the diff; consider `/review`.

**Checkpoint 5:** done — tests, docs, changelog, and gate all green; ready for PR to `dev`/`main`.

---

## Key files (quick reference)

| File | Why it matters |
| --- | --- |
| `editors/vscode/src/pipelex/graph/methodGraphPanel.ts` | The panel. `applyAnalysis` (L314), `errorListHtml` (L782), `toErrorListEntry` (L773), `handleWebviewMessage` (L565), `navigateToPipe` (L620), `setHtml` simple-HTML branch (L661), `RETRY_NONCE_SENTINEL` (L24), `messageHtml` actions-script pattern (L710). |
| `editors/vscode/src/pipelex/validation/crossFileDiagnostics.ts` | `resolveOwner` + `buildBundleDiagnostics` — extract `resolveErrorLocations` here. |
| `editors/vscode/src/pipelex/validation/sourceLocator.ts` | `locateError`, `locateErrorInLines`, `findTableHeaderInLines` — error → range. |
| `editors/vscode/src/pipelex/validation/backend.ts` | `GraphAnalysisSink.applyAnalysis` signature (→ allow `Promise<void>`), `ValidationOutcome`, `BundleAnalysis`. |
| `editors/vscode/src/pipelex/validation/pipelexValidator.ts` | On-save caller of `applyAnalysis` (L118); already gathers files + builds diagnostics. |
| `editors/vscode/src/pipelex/validation/bundleGather.ts` | `gatherBundleFiles(uri)` → `BundleFile[]`. |
| `editors/vscode/src/pipelex/validation/types.ts` | `ValidationErrorItem` shape (fields available for context). |
| `editors/vscode/src/pipelex/htmlEscape.ts` | `escapeHtml` — use for all interpolated error text. |
| `editors/vscode/src/pipelex/__tests__/methodGraphPanel.test.ts` | Extend; mirrors existing setHtml/message-handler/Retry/security tests. |
| `editors/vscode/src/pipelex/__tests__/crossFileDiagnostics.test.ts` | Must stay green after the extract; add `resolveErrorLocations` cases. |

---

## Out of scope / non-goals
- No backend changes — both CLI and API already return `{ ok:false, errors, graph:null }`.
- Not touching the valid-but-no-graph case ("No Graph Available", e.g. missing `main_pipe`).
- Not touching the `applySkipped` path (another extension reported errors → "Graph Unavailable").
- No new severity model — every `ValidationErrorItem` is rendered as an error (matches the diagnostics, which are all `Error` severity in `makeDiagnostic`).

## Open questions (resolve while implementing, none blocking)
- Should the header pluralize / cap a very long list (e.g. collapse after N)? Default: show all; the validator already returns the full structured list.
- Do we want the error rows to also surface `category` / `error_type` as a subtle tag? Nice-to-have; only if it doesn't clutter. Decide in Phase 2 against a real bundle.

## Verification recipe (manual)
1. `make ext` (Rust → WASM → JS → extension), launch the Extension Host.
2. Open a `.mthds` bundle, open the Method Graph panel (it shows the graph).
3. Introduce a validation error (reference a missing concept), save.
4. Panel shows the error list with count + Retry; multi-file errors show the sibling basename.
5. Click an error → editor jumps to the owning file at the line. Fix + save → graph returns.
