# Deferred: graph/validation follow-ups from the PR #70 pre-landing review

Collected from the gstack `/review` pass (specialists + adversarial Claude/Codex) on the static-first branch. Each item was judged real but not a clear in-PR win — either cross-repo, a design decision, or refactor churn disproportionate to a closing PR. The confirmed bugs from the same review (skip-verdict clobber, stale-verdict race, builder-throw guard, `validation.enabled` gate, dead `detailHtml`) were fixed in-branch and are NOT listed here.

## mthds-ui: static builder crashes on hostile-but-valid TOML (library bug)

`buildStaticGraphSpecFromToml` (mthds-ui 0.14.0) throws `TypeError: Cannot use 'in' operator to search for 'greet' in undefined` when `domain` is named after an `Object.prototype` member — repro: `domain = "constructor"` (also `"__proto__"`, `"toString"`) with any pipe. Root cause is a plain-object domain map; fix is `Object.create(null)` or a `Map`. A ~1,000-deep sequence-pipe chain also overflows the stack (`RangeError`), suggesting a recursive walk that should be iterative. The extension now guards its call site (Graph Error view fallback), so this is robustness debt in the library, not a broken panel. Fix in mthds-ui, add hostile-input tests there, release a patch, bump the pin here.

## Same-primary sibling switch drops an in-flight verdict

`onDidChangeActiveTextEditor` adopts a sibling with the same graph primary by swapping `currentUri` without refreshing (deliberate — preserves the viewport). An in-flight verdict for the previous URI then fails the exact-URI staleness check and is dropped: widget stuck at `validating` until the next save. Repro: save `bundle.mthds` with the panel open, click a helper sibling before the CLI returns. Fix sketch: track the shown file's resolved primary on render and accept a verdict when its `analysisPrimaryUri` matches (owning-file labels need a decision: they're computed relative to the shown file, which changed mid-flight). Self-heals on the next save; decide when there's evidence users hit it.

## Verdict causality is per-render-sequence, not per-cause

`applyAnalysis` stamps `renderSequence` on entry, which closes the confirmed race (detached issue-resolution outliving a newer save). One theoretical gap remains: a debounced external-change refresh does not abort the *validator's* in-flight on-save analyze (only its own panel-owned runs), so that verdict can enter `applyAnalysis` after the refresh bumped the sequence — captured at entry, it passes and posts over the refresh's `validating`, until the refresh's own verdict corrects it. Transient and self-healing; a full fix is a per-save/per-cause token threaded through `GraphAnalysisSink`. Not worth the interface churn until observed.

## Save-time bundle I/O duplication

A save with the panel open reads the bundle directory 2–3×: the panel rebuild's `resolveGraphPrimaryBundle`, the validator's own gather, and `applyAnalysis`'s invalid-branch re-gather — even though both call sites already hold freshly gathered `BundleFile[]`. Negligible on local SSDs; user-felt on remote/SSH/WSL filesystems or large directories. Fix sketch: thread the files through `GraphAnalysisSink.applyAnalysis` and let the save handler's rebuild share the validator's gather.

## Skip identical setData re-sends (files.autoSave users)

Every save re-posts the full graphspec and re-runs the webview's elkjs layout + the 200 ms viewport save/restore even when the rebuilt spec is identical (comment-only edits; autoSave firing during typing pauses). Fix sketch: deep-compare (or hash) the freshly built spec against the last-sent one for the same URI and post only the validation update when unchanged. Needs care with `pendingData`, first render, and webview reload — a wrong skip is a stale graph, the exact bug class this branch fights, so do it with tests or not at all.

## Validator errors without `pipe_code` never decorate a node

`validationErrorsToIssues` targets nodes only from the structured `pipe_code`, so an error variant that names its pipe only in the message prose gets a row but no ring/badge. `findErrorLine` has a message-scraping fallback (`extractCodeFromMessage`) for *line placement*, where a wrong guess is harmless — reusing it for node targeting was considered and rejected: decoration is an authoritative visual claim, and an error *mentioning* a pipe (e.g. "pipe 'x' references unknown pipe 'y'") is not necessarily *about* that pipe, so prose inference can mark the wrong node. The right fix is upstream: broaden `pipe_code` attribution in the validator's error model (pipelex repo) so more variants carry their owning pipe structurally; the extension then targets them for free.

## API validation request is not genuinely cancellable

`runWithAbort` in `apiValidationBackend` races the client promise against the abort signal — cancelling stops *awaiting*, but the HTTP request (the bundle upload) runs to completion server-side. Harmless for correctness (the result is discarded; staleness checks drop late verdicts) but wasteful, and it means panel-close doesn't stop an upload already in flight. A real fix needs the `mthds` client to accept an `AbortSignal` and thread it into `fetch` — a cross-repo change (`mthds-js`). The changelog wording already states the limitation.

## Multi-domain bundles: same-code pipes are ambiguous targets — FIXED

**Shipped (2026-07-18):** targeting is domain-qualified end to end. mthds-ui 0.15.0 replaced `ValidationIssue.pipeCode` with `pipeRef` (`domain_code.pipe_code`), matches nodes on the qualified ref, stamps every static `Diagnostic` with its declaring bundle's `domain_code`, and exports the canonical `parsePipeRef`/`makePipeRef` helpers; the extension builds `pipeRef` from the wire's `domain_code` + `pipe_code` (registry-based exactly-one inference for bare codes), domain-constrains static-issue navigation and the declaration-scan fallback, and qualifies cross-domain chips. Implementation record, decisions, and remaining release steps: `wip/pipe-ref-targeting-brief.md` (checkpoints). Out of scope, still open: cross-package (`alias->…`) targeting stays panel-only; errors with no `pipe_code` at all (see "Validator errors without `pipe_code` never decorate a node" above).

## Notification machinery duplication (3 surfaces)

`methodGraphPanel.notifyBackendError` re-implements `pipelexValidator.notifyOnce` (toast-with-actions dispatch, one-shot not-found guard, dedupe-until-verdict), and per-kind guidance strings exist in three near-variants (backend `userMessage`, `describeBackendErrorIssue`, panel toast) whose remedy verbs already disagree ("save again" / bare / "reload"). Fix sketch: one shared notifier helper + one per-kind wording function that all three surfaces call. Behavior-preserving but touches tested strings on both surfaces — batch it with the next validation-UX change.

## Adapter message-reducer extraction

`graph/webview/adapter.ts` has no tests (never had); the validation wiring (`setValidationStatus` handling, `setData.validation` seeding, null → widget-hidden) is only covered up to the host's postMessage boundary. Fix sketch: extract the message → `{graphspec, config, validation}` state transition into a pure function and unit-test it. Also the natural place to add remaining `notifyBackendError` negative-path tests (dedupe reset on verdict, externalUrl toast action).
