# Code review — cross-file pipe-node graph navigation

Workflow-backed review (xhigh effort) of the staged changes. 10 finder angles, every candidate independently verified: 38 candidates → 25 kept, 13 refuted, 15 reported.

**Scope of the change:** adds cross-file pipe-node graph navigation (click a pipe node in the graph panel → jump to its declaration in a sibling `.mthds`). The correctness issues cluster around node-identity recovery and a disk-resolution / line-find seam.

## Root-cause clusters

The 15 findings collapse into a handful of root causes. Fix the cluster, not the individual lines.

| Cluster | Findings | Root cause | One-shot fix |
| --- | --- | --- | --- |
| **A — Node-identity / source-tier-vs-scan-fallback seam** | #1, #2, #3, #4 | `lookupPipeNode` recovers node identity by bare `pipe_code` and only consults the registry under `domain.code`; the source tier returns a file by path without verifying the header, so a stale/missing `source` defeats the scan fallback instead of falling through to it. | Make `lookupPipeNode` consult the registry under both `domain.code` and `.code` keys, and treat a registry `source` as a *hint* that still falls through to the header scan when the header isn't found in the resolved file. Knocks out #1, #3, #4 together; #2 needs domain-aware node matching. |
| **B — Staleness across async / panel switches** | #5, #6 | Panel state (`currentGraphspec`, captured `primaryUri`) can outlive the graph it described — never reset on transition, never re-validated after awaits. | Reset `currentGraphspec` on every primary-file / error-view transition, and add the post-await staleness re-check that `renderValidationErrors` already has. |
| **C — Resolution heuristics over-match** | #7, #8 | First-match + loose regex in `bundleResolution.ts` route to the wrong sibling on basename collisions / malformed lines. | Disambiguate bare-basename matches (path-aware), tighten the domain regex (balanced quotes). |
| **D — Testing & docs gaps** | #9, #10 | New domain-disambiguation behavior is untested at the diagnostics-integration level; user-visible feature ships without a CHANGELOG entry. | Add a `crossFileDiagnostics.test.ts` case for the domain-collision branch; add the `[Unreleased]` CHANGELOG note. |
| **E — Cleanup / efficiency** | #11, #12, #13, #14, #15 | Redundant per-click I/O, non-memoized line-splitting, duplicated `escapeRegex`, full-scan-per-error, and a non-generalized lookup helper. | Mechanical cleanups; see each finding. |

---

## 🔴 Cluster A — Correctness: node-identity / source-tier seam (confirmed)

### 1. Domain-less nodes skip the registry `source` tier — `methodGraphPanel.ts:813`
`lookupPipeNode` only reads `pipe_registry[\`${domainCode}.${pipeCode}\`].source` when the node carries a `domain_code`. But the runtime keys domain-less pipes under `.code` (empty domain prefix). So for a node with no/empty `domain_code`, the exact `source` is never used — a signature/concrete split falls back to the header scan and the click lands on the **signature in the primary file** instead of the concrete impl in the sibling.

### 2. Bare `pipe_code` match picks the wrong domain on collision — `methodGraphPanel.ts:811`
`lookupPipeNode` matches the clicked node by bare `pipe_code` only. When two nodes share a `pipe_code` across domains, the *first* node match supplies the `domain_code`, which can select the wrong registry `source` → clicking the second-domain node opens the first domain's declaration. (Documented as a known v1 edge, but still a user-visible misroute.)

### 3. Source-first tier never verifies the header exists → silent click failure — `methodGraphPanel.ts:846`
`navigateToPipe` resolves the owner file via `resolveDeclaringFile` (disk content), then re-finds the line through a separate `openTextDocument` + `findTableHeader`. The source tier returns a file *by path* without checking the `[pipe.<code>]` header is actually there. If the registry `source` is stale (pipe moved after graph generation, or a basename collision), `findTableHeader` returns -1 and the click dies logging "Could not find [pipe.<code>]" — **even though a plain header scan across the other gathered siblings would have found it.**

### 4. Disk-resolution vs live-buffer seam on unsaved edits — `methodGraphPanel.ts:845`
`resolveDeclaringFile` scans gathered **on-disk** content, but the line is located by scanning the **live buffer** of the opened doc. If a sibling is open with unsaved edits that deleted/moved its `[pipe.code]` header, disk still says "this file declares it," the buffer scan finds nothing, and the click is a silent no-op on a clearly-present node.

---

## 🟠 Cluster B — Correctness: staleness across async / panel switches (confirmed)

### 5. Stale `currentGraphspec` outlives its graph across panel switches — `methodGraphPanel.ts:76` / `:603`
`currentGraphspec` is set only on send and cleared only on dispose — never reset when the panel switches to a new primary file or to the error view. Open graph for file A, switch to file B which fails validation (error view, no graph sent): `currentGraphspec` still holds A's spec. A late-delivered `navigateToPipe` click in that window resolves against A's registry and can jump the user into A's sibling for a pipe belonging to B's failed bundle.

### 6. Missing post-await staleness guard in `navigateToPipe` — `methodGraphPanel.ts:829`
`navigateToPipe` captures `primaryUri` at entry, then awaits `gatherBundleFiles` + `openTextDocument`, but never re-validates that the panel/file is still current after the awaits — unlike `renderValidationErrors`, which re-checks `this.currentUri?.toString() !== uri.toString()` and `this.panel` after its async gather. Click a node, then immediately switch files/close the panel mid-await → navigation completes against the stale URI and steals focus to the previous graph's file.

---

## 🟡 Cluster C — Correctness: resolution heuristics over-match (plausible)

### 7. `matchSourceFile` first-match on bare-basename collision — `bundleResolution.ts:59`
`files.find(...)` returns the first match; a bare-basename `source` matches every sibling sharing that basename (`foo/a.mthds` vs `bar/a.mthds`). Navigation/diagnostics land on whichever appears first in gather order. (The test at :138 asserts this first-match behavior as intended — but it's a real misroute for ambiguous basenames.)

### 8. `fileDeclaresDomain` regex over-matches — `bundleResolution.ts:96`
`^\s*domain\s*=\s*["']<code>["']` allows mismatched quotes (`domain = "rec'`) and can match a `domain =` line that's actually an inline-structure value starting the line. Low likelihood in valid TOML; over-matching only.

---

## 🟡 Cluster D — Testing & docs gaps (confirmed)

### 9. New domain-disambiguation diagnostics behavior is untested at the integration level — `crossFileDiagnostics.ts:135`
`resolveOwner` now domain-prefers via `findDeclaringFileByScan(error.domain_code)`, but `crossFileDiagnostics.test.ts` was **not** updated. The only coverage is `bundleResolution.test.ts` calling `findDeclaringFileByScan` directly — nothing asserts that, for a code declared in two sibling files under different domains, the error now lands on the domain-matching file through `resolveOwner → resolveErrorLocations → buildBundleDiagnostics`. A future regression would keep the suite green.

### 10. No CHANGELOG `[Unreleased]` entry — user-visible feature
There's a feature doc but no CHANGELOG note, despite an active `[Unreleased]` section and direct precedent (0.10.0's "Interactive error view in graph panel" — the sibling feature this builds on). Both the workspace and repo CLAUDE.md require changelog/doc updates in the same change.

---

## 🟢 Cluster E — Cleanup / efficiency

### 11. Redundant full-content gather on every click (confirmed) — `methodGraphPanel.ts:841`
`navigateToPipe` reads the full content of every sibling `.mthds` on each click, even when the source tier resolves by path alone (`matchSourceFile` only touches uri/name). In the common modern-CLI case where `source` is present, all that file-content I/O is thrown away. Cheaper: a uri-only gather for the source tier; only read contents when falling through to the scan tier.

### 12. `getLines` closure re-splits content, not memoized (confirmed) — `methodGraphPanel.ts:852`
The `getLines` passed to `resolveDeclaringFile` re-splits each file on every call (twice per file on the domain-collision path), unlike `resolveErrorLocations` which memoizes splits in a per-uri `Map`. Reuse the same `linesCache` pattern.

### 13. Duplicated `escapeRegex` (confirmed) — `bundleResolution.ts:109`
Byte-identical copy of the private `escapeRegex` in `sourceLocator.ts:124` (same regex), and `bundleResolution.ts` already imports from `sourceLocator.ts`. Export the existing one and import it, so a future regex-escaping fix isn't needed in two places.

### 14. Full-scan-per-error vs prior first-match (plausible) — `bundleResolution.ts:86`
`findDeclaringFileByScan` uses `files.filter(...)` (scans every file) where the old `resolveOwner` used `find(...)` and short-circuited. Per error, for both pipe and concept scans → up to N regex-walks per error instead of stopping at the first match. The `matches.length <= 1` early-out only helps *after* the full filter runs. Noticeable on save-time validation of large bundles.

### 15. `lookupPipeNode` not generalized for concepts (plausible) — `methodGraphPanel.ts:809`
The node-identity recovery is hard-coded to pipes (bare `pipe_code` match), even though `resolveDeclaringFile` and the registry data are kind-symmetric. When concept-to-code navigation lands (named as a tight follow-up), a parallel `lookupConceptNode` will duplicate this logic — the very pipe/concept duplication `bundleResolution.ts` was extracted to eliminate.

---

## Suggested fix order

1. **Cluster A** (#1, #3, #4 in one `lookupPipeNode` rework; #2 with domain-aware node matching) — highest user-visible impact.
2. **Cluster B** (#5, #6) — the staleness pair.
3. **Cluster D** (#10 CHANGELOG, #9 test) and **#13** escapeRegex — cheap, required by CLAUDE.md.
4. **Cluster C** (#7, #8) and remaining **Cluster E** (#11, #12, #14, #15) — decide case by case.
