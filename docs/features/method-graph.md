# Method graph: static-first rendering + validation widget

The Method Graph panel (`Pipelex: Show Method Graph` on any `.mthds` editor) renders in two decoupled stages: the **graph appears instantly**, and the **validation verdict arrives asynchronously** in a toolbar widget.

## Static-first rendering

The graph is built **statically inside the extension host** by `@pipelex/mthds-ui`'s static-graph module (`buildStaticGraphSpecFromToml`): the panel gathers the bundle's `.mthds` files (primary first, via `resolveGraphPrimaryBundle`), feeds their raw TOML text to the builder, and sends the resulting GraphSpec (`meta.mode: "static"`) to the same `GraphViewer` webview as before. Consequences:

- **No pipelex round-trip for the graph.** Opening the panel no longer blocks on `pipelex-agent validate --view`; the analyze call still runs, but only for the verdict (`--view` is never passed anymore).
- **Invalid methods still render.** The static builder is lenient by design — half-written bundles, unresolved refs, and cycles all produce a best-effort graph plus diagnostics, never an error page.
- **Works without pipelex.** If `pipelex-agent` isn't installed, the graph still renders; only the validation verdict is unavailable (widget `error` state + a one-time install hint).
- **Saves are instant.** On save the panel rebuilds the static graph immediately (same-file refresh preserves the viewport) and flips the widget to `validating`; the on-save validator's single analyze call then delivers the verdict.
- **`pipelex.validation.enabled: false` turns the verdict off entirely.** Since the graph no longer needs the backend, disabling validation means the panel runs no analyze at all — no CLI subprocess, no API upload, no failure toasts on a pipelex-less machine — and renders static-only with the widget hidden.

The only cases that still replace the graph with a message view are pre-graph failures: unreadable bundle files, missing webview assets, an invalid graphspec JSON in the Run Graph path, or a static-builder throw (the builder is documented never-throwing, but a builder bug on hostile input is caught and shown as a Graph Error view with Retry rather than leaving the panel stuck).

## The validation widget

The graph toolbar's first section is a validation status widget (rendered by `GraphViewer` when the host passes a `validationState` — the Run Graph / graphspec-json view passes none, so it shows no widget):

| State | Meaning |
| --- | --- |
| spinner | Verdict pending (`validating`) |
| green check | The configured validation backend (CLI or API) accepted the bundle (`valid`) |
| red cross + count badge | The bundle is invalid; the badge counts the issues |
| warning triangle | No verdict could be produced (`error`): CLI not found or too old, timeout, API auth failure, or the save was skipped because another tool reported errors |

Clicking the widget opens a dropdown listing the issues: severity accent, `pipe.…`/`concept.…` locator chip, message, the runtime's **suggested fix** (`validation_errors[].suggested_fix.description`, when the fix planner derived one), and the owning-file basename when the issue lives in a sibling file. Clicking a row jumps to the issue's source location — the same index-based `navigateToError` mechanism as before, resolved through `resolveErrorLocations` so the widget and the Problems panel always agree.

### Which issues are listed per state

The issue list is composed host-side (`methodGraphPanel` + the pure helpers in `graph/validationStatus.ts`):

- `validating` → the static analyzer's diagnostics (best-effort navigation via the declaration's table header).
- `invalid` → the validator's errors only (the static analyzer would double-report the same problems).
- `valid` → static warnings only; a static *error* contradicted by the authoritative verdict is dropped.
- `error` → the failure description first, then the static diagnostics.

Four ordering rules keep this composition honest under races. Each static rebuild claims a monotonic render sequence and re-checks it after every await, so an older save's slower file reads can never post their graph or issue state over a newer one. Verdicts participate in the same sequence: `applyAnalysis` stamps the current sequence on entry and re-checks it after its own async issue-resolution reads, so a superseded verdict (a newer save landed while it was resolving owners) is dropped instead of posting stale issues over the newer save's `validating`. Verdicts are also ordered by cancellation: the on-save validator aborts its previous in-flight run for the same file, and the save handler aborts any analyze the panel itself still has in flight (open-time or external-change), so a pre-save verdict can never land after — and overwrite — the save's. And when the verdict lands *before* the save-triggered rebuild finishes (a fast validator, or an immediate skip), the rebuild re-composes the static portion of the current state — fresh warnings under `valid`, a fresh static tail behind the retained lead issue under `error` — instead of letting the widget keep the previous render's issues and targets.

One verdict is special-ordered: the validator's **skip** verdict (the save was skipped because another tool reported errors) is decided synchronously in the save dispatch, and the validator's save listener runs before the panel's — so the validator defers `applySkipped` by a microtask. The skip `error` state therefore lands after the panel's own `validating` flip regardless of listener registration order, instead of being clobbered by it and leaving the widget spinning for a verdict that will never come.

When the shown file is a helper (no top-level `main_pipe`), both the graph and the verdict anchor on the directory's graph primary (`resolveGraphPrimaryBundle`, e.g. a sibling `bundle.mthds`). `applyAnalysis` receives that anchor alongside the shown file: errors that resolve to no owning file fall back to the *primary* — matching where the Problems panel places them — while owning-file labels stay relative to the shown file.

### Node decorations

Issues that target a pipe also decorate the graph nodes themselves (rendered by `@pipelex/mthds-ui` from the same issue list — see its `docs/validation-widget.md`): a severity ring plus a corner count badge on every invocation of the affected pipe, with the messages and `Fix:` lines as the badge tooltip. Targeting is **domain-qualified**: the identity is the full pipe ref (`domain_code.pipe_code`, mirroring the pipelex runtime's `QualifiedRef`), never the bare code — in a bundle where two domains declare the same pipe code, only the right domain's nodes decorate. The extension's contribution is filling the targets: `validationErrorsToIssues` builds the issue's `pipeRef` from the validator error's `domain_code` + `pipe_code`; when only a bare `pipe_code` arrives, it is qualified through the static graphspec's `pipe_registry` keys **only when exactly one domain declares that code** (zero or several → the issue stays untargeted — never guess). Static diagnostics get `pipeRef`/`nodeId` auto-filled by the mthds-ui mapper from their stamped `domain_code`. Issues without a resolvable target (bundle-level parse errors, concept-only errors, diagnostics about pipes the static walk skipped) simply stay panel-only. Folding rolls decorations up — a folded controller's badge aggregates its hidden descendants' issues. Clicking a badge opens the widget dropdown; clicking a dropdown row does the usual source jump *and* pans/flashes the target node in the graph.

The same domain rigor applies to **navigation and chips**. Static-issue rows resolve their jump target domain-first: the row's `pipeRef` domain constrains the declaring-file scan (`resolveDeclaringFile`), so a colliding `[pipe.<code>]` header in another domain's file is never opened; the same constraint applies in `crossFileDiagnostics`' declaration-scan fallback when a validator error carries `domain_code` (no domain match on a collision → the error falls back to the primary file rather than a guessed sibling). The issue chip mirrors the owning-file-label policy: `pipe.<code>` when the error lives in the shown file's domain (or when either domain is unknown), `pipe.<domain>.<code>` when it lives in another domain.

## Data nodes and the detail panel

Clicking a data node opens `GraphViewer`'s detail panel. Whether it shows the node's **value** or only the concept's structure table depends on one thing: whether the host holds the two `/validate` artifacts the renderer needs, and hands them over.

Since `@pipelex/mthds-ui` v0.20.0 the panel renders a payload only when it receives both `contracts` (the `pipe_io_contracts` view) and `outputForm` (the `output_form` view), keyed by pipe ref. The pairing is the point: `output_form` gives a pipe's result one descriptor node — kind, concept identity, refinement chain, nested fields in authored order — and the output half of `pipe_io_contracts` gives the payload's JSON Schema beside it, naming the property the concept's content model wraps the value under. A descriptor without its schema, or a schema without its descriptor, would leave the panel guessing what the value *is*, which is the guessing the deleted `StuffViewer` did with its three tabs and which `output_form` exists to end.

With neither artifact the panel falls to the renderer's documented floor — structure table, no data tab. That is a deliberate floor rather than a degraded mode: a tab opening onto an empty pane reads as data that failed to load.

### Where the artifacts come from, and which view gets them

**`Pipelex: Show GraphSpec JSON` reads them off the disk, beside the graphspec.** `runArtifacts.ts` looks for `pipe_io_contracts.json` and `output_form.json` as siblings of the file being viewed, plus an optional `input_form.json`, and the panel forwards whatever it finds on the `setData` `artifacts` payload; `adapter.ts` spreads them onto `GraphViewer`'s `contracts` / `outputForm` / `inputForm` props.

Reading them is the only option available. A run's `graphspec.json` carries neither artifact and carries no path back to the bundle it came from, so nothing downstream can regenerate them — the local CLI cannot emit them at all, and the API needs a bundle to validate that a bare run file does not name. The runtime is the only place holding the loaded library at the moment it writes the graphspec, so it writes all three side by side — since `pipelex` v0.57.0, gated by the same flag as `graphspec.json` itself, and keyed by namespaced pipe ref like the validate report. A graphspec whose directory has no artifacts simply takes the floor, which is what every graphspec written by an earlier runtime does. One producer the artifacts never describe is the runtime's synthetic batch wrapper (`<domain>.<pipe>_batch`): a stuff whose first producer in node order is such a wrapper falls to the renderer's labelled "undescribed value" JSON view rather than a laid-out one.

**Both required files or neither.** `contracts` and `outputForm` gate each other in the renderer, so half a pair is indistinguishable at the panel from none — except that it would hide a half-written results directory. The reader therefore refuses a lone one and says so in the output channel. `input_form.json` is genuinely optional and never gates the pair: it is what lets a method's own *inputs* show a value, since no pipe produced them and the consuming pipe's descriptor for their slot is what names them instead.

A missing pair is silent, because it is the ordinary case. Anything else — unreadable, not JSON, or JSON that is not the pipe-ref-keyed object the viewer joins against — is logged, because it means a file is there and is not what it claims to be.

**One node kind keeps the floor even with artifacts present.** The artifacts are keyed by the pipe refs the *method* declares, while a run's graphspec also contains the pipes the runtime synthesises — a batch wrapper such as `cv_batch_screening.process_cv_batch`. Nothing authored describes those, so no contract exists to join against and their data nodes show the structure table. That is correct, not a gap to close here.

**The `.mthds` editor path is unchanged, and correctly so.** Its graph is built statically from bundle text, so there is no run data to show and the structure table is the right rendering. The reader is never consulted for one.

### Styling the panel: the form kernel's token map

The panel's controls come from `@pipelex/mthds-form`, and they are Tailwind classes over shadcn semantic tokens (`--background`, `--foreground`, `--border`, …). mthds-ui bundles the kernel's stylesheet — wrapped in `@layer mthds-form`, so it can never outrank a host's own rules — but deliberately **not** the kernel's `theme.css`, because that file defines the very tokens a host already owns and importing it would let the kernel repaint the host's palette. Supplying them is the host's lane, and `shell.css` is where this host does it.

That is not cosmetic. Since kernel 0.8.0 the sheet is a Tailwind 4 build holding whole colours, so it emits `background-color: var(--primary)` with **no fallback**: an undefined token does not degrade, it makes the declaration invalid and the browser discards it. The build stays green, the token is inspectable, and the control silently paints transparent — the quietest failure CSS has.

The map is declared **on `.react-flow-container`, in terms of the graph's own palette variables**, and both halves of that matter. `GraphViewer` applies its resolved light/dark palette as inline styles on that exact element and the detail panel is a child of it, so every `var(--surface-panel)` below re-resolves the instant the in-graph theme toggle flips. Mapping from VS Code's `--vscode-*` colours instead would pin the panel to the *editor's* theme, which cannot see that toggle, and hoisting the tokens to `:root` or `body` would put them where `graph-core.css` shadows them anyway.

`formKernelTokens.test.ts` derives the requirement from the kernel's shipped stylesheet rather than from a remembered list: it reads every token the sheet uses without a fallback, subtracts what the bundle already defines for itself and the `--radix-*` ones Radix sets at runtime, and holds `shell.css` to the remainder. A kernel upgrade that reaches for a new token fails there, naming it, instead of quietly dropping a rule in the panel.

## Webview assets

The panel serves four files out of `dist/pipelex/graph/webview/`, and only two of them are copied:

| File | Where it comes from |
|---|---|
| `graph.js` | esbuild bundles `webview/adapter.ts` — React, `@xyflow/react`, elkjs and `@pipelex/mthds-ui` included — as one minified IIFE |
| `graph.css` | esbuild emits it beside `graph.js` from the **same import graph**: `@pipelex/mthds-ui/graph/react` imports its own sheets, so whatever it ships arrives here with every `@import` resolved |
| `shell.css` | the webview's own sheet — the page around the graph (`body`, `#app-container`, `#root`, and the three theme tokens those rules read) plus the form kernel's token map. Copied, and linked *after* `graph.css` so it wins any tie |
| `graph.html` | copied, with three `{{…}}` placeholders the panel substitutes with `asWebviewUri` values |

Two details are load-bearing. **The extension's own sheet is called `shell.css`, not `graph.css`**, because esbuild names the emitted stylesheet after the JS bundle: while the two shared a basename the build worked around the collision by switching CSS bundling off (`loader: { ".css": "empty" }`) and hand-copying each of mthds-ui's sheets instead — an arrangement in which a sheet added upstream went silently missing and a sheet deleted upstream broke the build outright, which is exactly what the removal of `StuffViewer.css` did. And **the bundle is minified**, because elkjs ships pre-minified GWT output that esbuild otherwise re-prints at more than twice its size; `minify: true` takes the webview bundle from 5353 KB to 2190 KB.

Beyond the form kernel's token map (above), `shell.css` defines **only** the tokens its own rules read (`--color-bg`, `--color-text`, `--font-sans`, per VS Code theme class). It is not the graph's palette and cannot be: `GraphViewer` applies the full light/dark token set as inline styles on its own `.react-flow-container`, and mthds-ui's `graph-core.css` defines the same custom-property names on that container as well. The container is an ancestor of every node, edge and panel, so a definition made on `:root` or `body` out here is shadowed for everything inside it. A host-side palette therefore does nothing — which is the same reason the host must never send `config.paletteColors` — and the ~40-token map this file used to carry was inert in every one of its four theme blocks. The kernel's token map is not a counter-example: it is declared *on* `.react-flow-container` rather than out here, which is exactly why it resolves.

The pre-graph message views (loading, Graph Error) do not use this sheet at all: each is a standalone HTML document with its own inline `<style>` reading `--vscode-*` variables directly.

The remaining silent failure — esbuild emitting no stylesheet at all, leaving the webview unstyled with nothing thrown — is asserted against at the end of `scripts/build.mjs`, and the substitution of every `graph.html` placeholder is asserted in `methodGraphPanel.test.ts`.

## Message protocol

Two additions to the host ↔ webview protocol:

- `setData` carries an optional `validation: { state, issues }` payload so a fresh webview paints the widget without a follow-up message (absent for graphspec-json views).
- `setData` also carries an optional `artifacts: { contracts, outputForm, inputForm? }` payload — the `/validate` artifacts read from beside a run's graphspec. It sits at the top level rather than inside `config`, because `config` is forwarded wholesale as GraphViewer's `config` prop while these are three separate props of their own. Absent whenever the required pair is not on disk.
- `setValidationStatus { state, issues }` is a lightweight live update in the `setSystemTheme`/`setToolbarPosition` family: the adapter updates only the widget props and re-renders — no re-layout, no viewport reset.

## Backends

Both validation backends (`cli` / `api`, see `validation-backends.md`) feed the widget identically: a produced verdict maps to `valid`/`invalid`, a `BackendError` to the `error` state (with its per-kind wording as the lead issue). Toast notifications stay rate-limited: the panel toasts only for its own analyze failures — the open-time run and the debounced external-change refreshes (one-time CLI-install hint; actionable API auth errors with the Set API Key button) — while on-save failures keep being notified by the validator.
