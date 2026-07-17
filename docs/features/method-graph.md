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

Issues that target a pipe also decorate the graph nodes themselves (rendered by `@pipelex/mthds-ui` from the same issue list — see its `docs/validation-widget.md`): a severity ring plus a corner count badge on every invocation of the affected pipe, with the messages and `Fix:` lines as the badge tooltip. The extension's only contribution is filling the targets: `validationErrorsToIssues` copies the validator error's `pipe_code` onto the issue's `pipeCode`, and static diagnostics get `pipeCode`/`nodeId` auto-filled by the mthds-ui mapper. Issues without a resolvable target (bundle-level parse errors, concept-only errors, diagnostics about pipes the static walk skipped) simply stay panel-only. Folding rolls decorations up — a folded controller's badge aggregates its hidden descendants' issues. Clicking a badge opens the widget dropdown; clicking a dropdown row does the usual source jump *and* pans/flashes the target node in the graph.

## Message protocol

Two additions to the host ↔ webview protocol:

- `setData` carries an optional `validation: { state, issues }` payload so a fresh webview paints the widget without a follow-up message (absent for graphspec-json views).
- `setValidationStatus { state, issues }` is a lightweight live update in the `setSystemTheme`/`setToolbarPosition` family: the adapter updates only the widget props and re-renders — no re-layout, no viewport reset.

## Backends

Both validation backends (`cli` / `api`, see `validation-backends.md`) feed the widget identically: a produced verdict maps to `valid`/`invalid`, a `BackendError` to the `error` state (with its per-kind wording as the lead issue). Toast notifications stay rate-limited: the panel toasts only for its own open-time analyze failures (one-time CLI-install hint; actionable API auth errors with the Set API Key button), while on-save failures keep being notified by the validator.
