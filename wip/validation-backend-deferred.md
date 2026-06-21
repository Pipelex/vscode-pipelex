# Validation backend — deferred backlog

Still-open, consciously-deferred items from the CLI/API validation-backend work shipped in extension v0.10.0. Each was reviewed and judged not to block the release. The historical planning docs and the round-by-round "fixed in this pass" logs have been removed; this file is the live backlog. Pick from it when next touching the backend seam.

> Resolved during the v0.10.0 pre-landing review and dropped from this list: the per-directory diagnostics clobber (a sibling save no longer overwrites a newer save's set — `PipelexValidator` now gates each directory write on a per-directory generation), plus the validator-never-starts, error-view-can-reject, source-path-misroute, `/version`-hang, and `.plx`-in-consent items fixed during the bot-review rounds.

## Correctness (real, lower-severity / narrow trigger)

- **Loopback detection misses `[::1]`, treats `0.0.0.0` as local.** `apiValidationBackend.ts` `isLocalhost`. `new URL('http://[::1]:8081').hostname` keeps the brackets (`[::1]`), so the `'::1'` comparison fails and an IPv6 loopback over-prompts the privacy modal; `0.0.0.0` is allowlisted as local so a pasted bind address skips the modal. Fix: strip surrounding brackets before comparing and decide whether `0.0.0.0` should count as loopback. Bundle with the host-helper dedup below — same root.
- **A slow-but-healthy API server (> timeout) is reported as "unreachable".** `apiValidationBackend.ts` `runWithAbort` reuses the unreachable message on timeout, and the underlying fetch keeps running (`client.validate()` takes no `AbortSignal`). Fix: distinct "timed out after Nms" message; ideally forward cancellation into the client (needs a small `mthds-js` change to accept a signal on `validate()`).
- **`confirmRemote` TOCTOU → stacked consent modals on first concurrent use.** `backendFactory.ts` reads the per-host `globalState` consent key, then `await`s the modal before writing it, so two near-simultaneous first-time analyses against the same host each pop their own prompt. One-shot, first-use-only, and accepting any one modal sets the flag for the rest of the session. Fix: dedupe in-flight consent per host with a shared pending `Promise<boolean>`.

## Silent-failure / robustness

- **Two divergent `BackendError`→UX paths; CLI infra errors are silent in the validator.** `methodGraphPanel.renderBackendError` vs `pipelexValidator.handleBackendError`. For `kind:'infra'` the panel renders the message but the validator only notifies `if (err.userMessage)` — and CLI infra/interpreter errors carry none, so the validator clears diagnostics and stays silent. Fix: centralize the kind→message/severity mapping on/near `BackendError` so both consumers render consistently, and give `infra` a default user-facing message.
- **`extractJson` only strips `WARNING:` lines.** `cliOutput.ts` — `indexOf('{') … lastIndexOf('}')` spans the whole output; other stdout/stderr noise containing braces corrupts the slice (graph silently dropped, or a real failure misreported as infra). Now load-bearing for both channels. Fix: scan for a balanced object from the first `{`, or have the CLI guarantee JSON-only on the relevant stream.
- **`notifyOnce` dedup swallows the auth remedy toast after the first dismissal.** `pipelexValidator.notifyOnce` dedupes on exact message text and only resets on a *successful* validation. For a standing 401/403 (api backend, no key), the "Set API Key" toast appears once; if dismissed without acting, later saves return early with no remedy and no success can reset the dedup. The remedy stays reachable via the panel buttons and the command. Fix: don't suppress action-bearing notifications, or reset the dedup once an actionable remedy is surfaced-but-not-taken.
- **CLI `--view` stdout can exceed the spawn `maxBuffer` (1 MB).** `processUtils.spawnCli` caps stdout at `1024 * 1024`. A large method graph's `--view` JSON can overflow → `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, surfaced as a generic `infra` "Validation Failed". Pre-existing, now more reachable via the graph path. Fix: raise `maxBuffer` for the graph path, or detect the maxBuffer error code and show a clearer message.

## Judgment calls (need a decision, not a quick patch)

- **Unparsed CLI version bypasses the floor.** `cliValidationBackend.ts` `throwIfTooOld` only blocks when `getAgentCliVersion()` returns a parsed version; a dev/localized/unparseable `--version` returns `null` and runs anyway, silently degrading source attribution. Fail-open vs fail-closed on version detection — fail-closed would break legitimate dev CLIs whose version string is non-standard but new enough.
- **Broken graph output is hidden.** `cliValidationBackend.ts` — when `--view` succeeds but stdout has no parseable graph JSON, `parseGraphspec()` returns `null` and the caller still reports `ok:true` ("No Graph Available"). Turning missing graph output into an infra error is a separate UX decision.

## Cleanup / efficiency (no behavior bug)

- **`gatherBundleFiles` runs on every save, including the valid path.** `pipelexValidator.onSave`. The contents are only consumed by `buildBundleDiagnostics` on failure; the default CLI backend then re-reads siblings via `--library-dir`. Fix: defer the gather into the failure branch, or gate on backend kind as the graph panel already does.
- **Dead method `BackendFactory.backendKind()`** — public, never called, duplicates `getBackend`'s decision. Fix: remove it, or wire the intended "messaging" caller.
- **Three duplicated URL-host helpers.** `isLocalhost` (`apiValidationBackend.ts`), `isHostedPipelexApi` (`apiVersionGate.ts`), and `hostOf` (`backendFactory.ts`) each re-implement parse-URL-and-extract-host with their own try/catch and host rules — and that duplication is why the loopback bugs live in only one of them. Fix: extract one shared host util (parse + bracket-strip + classify loopback/hosted) and route all three through it; closes the loopback item above at the root.

## Won't-fix (recorded so they aren't re-litigated)

- **Guarding impossible API verdicts.** `apiValidationBackend.ts` casts the success arm when `is_valid !== false` and forwards the invalid arm's `validation_errors` without a non-empty check. Our reference server (`pipelex-api`) emits `is_valid` as a Pydantic `Literal`, and the structured-info-invariant gate guarantees every invalid verdict carries a non-empty `validation_errors[]`. Both guards would add dead branches for responses a conformant server cannot produce. Reconsider only if a non-Pipelex runtime is targeted.
