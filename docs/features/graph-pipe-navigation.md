# Cross-file pipe-node navigation in the method graph

Clicking a pipe node in the method graph panel opens that pipe's `[pipe.<code>]` declaration in the editor — **across every `.mthds` file in the bundle directory**, not just the file the panel was opened from. When a method is split across several files (e.g. a signature in one file, the concrete implementation in a sibling), clicking the node lands on the file that actually declares it.

## Scope

- **Pipes only, strictly click-to-code.** Concept-to-code navigation and `--pipe` graph-targeting are tracked as follow-ups, not implemented here.
- **`.mthds` sources only.** A run-graph GraphSpec JSON (`graphspec-json` source kind) has no editable bundle in the workspace, so node navigation is disabled for it.

## How resolution works — source-first, scan-as-fallback

When the webview reports a clicked pipe node, the panel resolves the declaring file in two feature-detected tiers, then finds the exact line:

1. **Source (exact).** The retained GraphSpec's `pipe_registry[<domain>.<code>].source` names the declaring file. The collision reconciler in the runtime makes `source` follow the **winning** declaration, so for a signature/concrete pair it points at the concrete implementation — the file you actually want. Keyed on `domain.code`, so same-named pipes in different domains resolve correctly.
2. **Scan (fallback).** When `source` is absent — an older CLI that doesn't emit it, or a synthesized pipe with no declaring file — the extension gathers the sibling `.mthds` files and finds the one declaring `[pipe.<code>]`. On a header collision it prefers the file whose top-level `domain = "<domainCode>"` matches the clicked node.
3. **Primary fallback.** If neither tier resolves a sibling, it opens the panel's own file (today's single-file behavior). If even that file doesn't declare the header, the attempt is a silent no-op logged to the Pipelex output channel — exactly as before.

In every tier the declaring **file** is resolved first; the exact **line** then comes from scanning that file's opened document for the `[pipe.<code>]` header. The runtime deliberately does not own editor-range semantics — line-finding stays a presentation concern in the extension.

## Feature detection across CLI versions

The `source` field is **additive** and feature-detected — there is **no minimum CLI version bump** for this feature. A CLI new enough to emit `source` gets exact tier-1 resolution; an older CLI that omits it degrades cleanly to the tier-2 scan, which behaves like the original single-file navigation when the pipe lives in the panel's own file. Nothing breaks on either side of the version line.

## Single owner resolver — shared with cross-file diagnostics

The matching logic lives in one module, `editors/vscode/src/pipelex/validation/bundleResolution.ts`, and is shared by **both** the pipe-node navigation path and the validation-error placement path (`crossFileDiagnostics.ts`). They can never drift on how a `source` path is matched or how a declaration header is located. The two paths differ only in composition order: an error may carry both a `pipe_code` and a `concept_code` (resolved `source` → pipe → concept), while navigation resolves a single kind. Source-path matching tolerates absolute and relative values alike and normalizes separators, so it works whether the CLI emits absolute host paths or the API emits per-content names.

## Unsaved-sibling caveat

Resolution reads sibling files **from disk** (the same flat directory gather the cross-file diagnostics use — a non-recursive `*.mthds` glob, matching the CLI's `--library-dir`). The file that is finally opened still shows its live editor buffer, so the primary file's unsaved edits are honored when finding the line; an unsaved **sibling** is matched against its on-disk text. Reading unsaved sibling buffers for resolution is a deferred refinement.

## Node identity (and a known v1 edge)

The webview message carries only the bare `pipeCode`. The panel recovers the clicked node's `domain_code` by looking it up in the retained GraphSpec (stored whenever the graph is sent to the webview, cleared on dispose), then forms the `domain.code` registry key. If the same `pipe_code` appears under two domains as two nodes in one graph, the first node match wins — acceptable for v1, because the scan fallback still finds a correct declaration. The bulletproof upgrade is to wire mthds-ui's `onNodeSelect(nodeId, nodeData)` (already available; `nodeData` carries the full node, including `domain_code`) and post a unique `nodeId` instead — recorded as a future improvement so the webview message contract stays unchanged here.

## Files

| File | Role |
|------|------|
| `editors/vscode/src/pipelex/validation/bundleResolution.ts` | Shared declaring-file resolver (`resolveDeclaringFile`, `matchSourceFile`, `findDeclaringFileByScan`) |
| `editors/vscode/src/pipelex/validation/crossFileDiagnostics.ts` | Validation-error owner resolution, delegating to the shared primitives |
| `editors/vscode/src/pipelex/graph/methodGraphPanel.ts` | Retains the GraphSpec, resolves a clicked node to its declaring file, opens-and-reveals beside the panel (`navigateToPipe`, `lookupPipeNode`, `revealRangeBeside`) |
| `editors/vscode/src/pipelex/graph/webview/adapter.ts` | Webview entry; posts `{ type: 'navigateToPipe', pipeCode }` on a node click |

## Cross-repo dependency

The `source` enrichment is produced by the runtime in `../pipelex` — `GraphSpec.pipe_registry[ref].source` (and the symmetric `concept_registry[ref].source`), powered by `LibraryCrate.source_map`. See `../pipelex/pipelex/graph/graphspec.py` for the data model the extension consumes.

## Verification

```bash
cd editors/vscode && yarn vitest run src/pipelex/__tests__/bundleResolution.test.ts   # resolver unit tests
cd editors/vscode && yarn vitest run src/pipelex/__tests__/methodGraphPanel.test.ts   # navigation integration tests
make test-ext                                                                          # extension tsc + vitest
```
