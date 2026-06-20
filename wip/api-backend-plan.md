# Plan: CLI-or-API backend for MTHDS validation & graph rendering

## Goal

Today the VS Code extension validates `.mthds` bundles and renders method graphs exclusively by spawning the `pipelex-agent` Python CLI. Add a second backend that calls the **Pipelex API** (`pipelex-api`) over HTTP via the **`mthds-js`** typed client, selectable through a setting. The CLI backend stays the default and is preserved unchanged.

This plan spans three repos plus the extension. The two upstream improvements — `pipelex` (expose structured validation errors over the API) and `mthds-js` (type and surface them) — are prerequisites for validation parity and are first-class phases here.

## Decisions locked

- **Expose structured validation errors over the API** — yes, make the `pipelex` runtime change. This is the gating prerequisite for validation parity.
- **One call returns both** — when the extension needs validation details *and* the graph for the same file state, it must get both from a single backend call; no separate validate + graph round-trips. The API's `/v1/validate` already returns both. The CLI's `validate bundle --view --format json` must be extended to return both in one combined envelope (today it throws on invalid bundles instead of returning errors alongside a null graph).
- **API target** — default local self-hosted `http://localhost:8081`, changeable in settings. Optional hosted `api.pipelex.com` via an API key. Key is picked up from the environment / VS Code SecretStorage — never stored as plaintext in settings.
- **Multi-file bundles** — send every `.mthds` file in the saved file's directory as `mthds_contents[]` (mirrors the CLI's `--library-dir <dir>`).
- **HTTP client** — use `mthds-js` (`MthdsApiClient`), not a hand-rolled fetch client.
- **Default backend** — `cli` (zero-config preserved); `api` is opt-in.
- **Per-pipe FAILURE as data** — it is acceptable for `/v1/validate` to report per-pipe dry-run FAILUREs as data on a 200 response (in `validated_pipes`) rather than always raising 422. The extension surfaces both the 422 `validation_errors` and any 200 `validated_pipes` FAILUREs as diagnostics.

## Repos, paths, and current versions

| Repo | Path | Version | Role in this plan |
| --- | --- | --- | --- |
| pipelex (worktree) | `../_calls` (branch `refactor/Function-calling-4`) | 0.33.0 | Expose `validation_errors` on the API error contract |
| pipelex-api | `../pipelex-api` | 0.3.0 | Re-pin pipelex, surface the field, bump `implementation_version` |
| mthds-js | `../mthds-js` | 0.10.0 | Type the validation report + structured errors; publish |
| vscode-pipelex | `.` (this repo) | — | Backend abstraction, settings, consume `mthds-js` |

> All `pipelex` edits land in the worktree `../_calls`, treated as repo root — not `../pipelex`.

## Architecture overview — the seam

The verified facts that shape the design:

- **GraphSpec is already identical** on both paths. The CLI `--view` output and the API `graph_spec` field are the same `GraphSpec` model (`../_calls/pipelex/graph/graphspec.py`), serialized `by_alias=True`, and the webview's `@pipelex/mthds-ui` renderer mirrors it exactly. The only difference is the envelope key (`graphspec` from the CLI vs `graph_spec` inside the API's validation report) and that direction/layout is already client-side (ELK in the webview). No GraphSpec body transformation is needed.
- **Validation errors regress today.** On an invalid bundle the API returns HTTP 422 RFC-7807 `problem+json` with a single `detail` string. The structured per-error list the extension maps to per-line diagnostics exists on the `ValidateBundleError` instance but is dropped at the exception→`ErrorReport` boundary. Phase 1 fixes this.
- **One call must serve both.** When validation and graph are both wanted for a file, a single backend call returns them together. The API already does this (`/v1/validate` → report + `graph_spec`). The CLI does not yet — Phase 1 also makes `validate bundle --view --format json` return a combined envelope (validation details + best-effort graph).

We introduce a single `ValidationBackend` abstraction in the extension with two implementations (CLI, API), selected by `pipelex.backend`. It exposes one `analyze(files, { withGraph })` method that returns both the validation outcome and (when requested) the graph, so the "no two calls" requirement is structural. Both backends produce the same normalized outcome types, keeping the diagnostics and graph webview code backend-agnostic.

---

## Phase 1 — pipelex (`../_calls`): structured `validation_errors` over the API + a single combined validate+view envelope

This phase has two parts: (A) get structured errors onto the API wire, and (B) make the CLI return validation details and the graph from one call.

### Part A — expose structured `validation_errors` over the API

**Problem.** `ErrorReport` (`../_calls/pipelex/base_exceptions.py`, ~lines 233-266) is `frozen` / `extra="forbid"` and `PipelexError.to_error_report()` (~lines 482-508) copies only a fixed flat field set, so the three per-error lists on `ValidateBundleError` never reach the wire. The CLI dodges this by catching the exception itself and calling `extract_validation_errors(exc)` (`../_calls/pipelex/cli/agent_cli/commands/agent_output.py`, ~lines 409-473), which reads `pipelex_bundle_blueprint_validation_errors`, `pipe_factory_errors`, and `pipe_validation_errors`.

**Changes.**

1. **Promote a typed wire item.** Define a `ValidationErrorItem` Pydantic model carrying the union of fields the CLI already emits and the extension already consumes: `category`, `error_type`, `pipe_code`, `concept_code`, `domain_code`, `field_path`, `field_name`, `variable_names`, `message`. Place it next to the source error-data models (`../_calls/pipelex/core/exceptions.py`, `../_calls/pipelex/core/bundles/exceptions.py`).
2. **Extract a shared builder.** Move the `extract_validation_errors()` logic out of the CLI command module into a shared location (e.g. `../_calls/pipelex/pipeline/validation_errors.py`) and have it return `list[ValidationErrorItem]`. The CLI command and the new `to_error_report()` override both call it, so the CLI and API shapes can never drift.
3. **Add the field to `ErrorReport`.** Declare `validation_errors: list[ValidationErrorItem] | None = None` on `ErrorReport`. Because `to_problem_document()` (~lines 315-357) already projects non-omitted payload fields onto the envelope, the field appears on the 422 body automatically once populated.
4. **Override `ValidateBundleError.to_error_report()`** (`../_calls/pipelex/pipeline/exceptions.py`, ~lines 72-118) to call `super().to_error_report()` then attach `validation_errors` via the shared builder.
5. **STRICT disclosure.** Add `validation_errors` to `_STRICT_KEPT_FIELDS` (`../_calls/pipelex/base_exceptions.py` ~line 54) so the structured list survives STRICT error disclosure (production), matching how `ValidateBundleError` already keeps its `caller_facing_message`.
6. **(Optional, same boundary)** `PipelexInterpreterError.validation_errors` is lost the same way. Apply the same override if cheap; otherwise note as a follow-up.

### Part B — single combined validate+view envelope (CLI)

**Problem.** Today the extension makes two CLI invocations when the graph is open: `validate bundle ...` for diagnostics (errors arrive on the exit-1 error path) and `validate bundle ... --view --format json` for the graph (success on exit 0). To satisfy "one call returns both", `validate bundle --view --format json` must return a single machine-readable envelope that carries both validation details and the best-effort graph, without throwing on an invalid bundle.

**Changes** (in `../_calls`, around the agent-CLI `validate bundle` command and `pipelex/graph/graph_rendering.py`'s `generate_view_for_bundle`):

7. In `--view --format json` mode, **do not raise on validation failure** — catch `ValidateBundleError` and emit a combined envelope on exit 0:
   - valid bundle → `{ "success": true, "validated_pipes": [...], "pending_signatures": [...], "is_runnable": true, "graphspec": {...}, "pipe_code": "...", "direction": "..." }`
   - invalid bundle → `{ "success": false, "validation_errors": [...], "graphspec": null }` (reusing the same shared `extract_validation_errors()` builder from Part A so the CLI's combined output and the API 422 stay identical).
   This mirrors the API: errors and graph never coexist (an invalid bundle has no graph), but a single call always returns whichever applies.
8. Leave the plain `validate bundle` path (no `--view`) untouched for the diagnostics-only / cheaper case — graph dry-run cost is only paid when `--view` is requested.

**Tests** (`../_calls/tests/...`):
- Part A: an invalid bundle's `ErrorReport` / problem document contains `validation_errors[]` with all fields populated; STRICT mode retains them; a parity test asserting the API-bound shape equals the CLI's `extract_validation_errors()` output.
- Part B: `validate bundle --view --format json` on a valid bundle returns `graphspec` + `validated_pipes` with exit 0; on an invalid bundle returns `success:false` + `validation_errors` + `graphspec:null` with exit 0 (no throw).

**Versioning & docs.** Bump pipelex 0.33.0 → 0.34.0 (new error-contract field + new combined `--view` output). Update CHANGELOG and the relevant `../_calls/docs/` pages (validate error envelope + the `--view --format json` output contract).

> **CHECKPOINT 1.** The pipelex runtime serializes structured `validation_errors` on `ValidateBundleError` problem documents, and `validate bundle --view --format json` returns a combined validation+graph envelope. Both gated behind a released version. Everything downstream depends on this. Record the released version here before moving on.

---

## Phase 2 — pipelex-api (`../pipelex-api`): surface the field, version, docs

The route `validate_mthds` (`api/routes/pipelex/validate.py`) lets `ValidateBundleError` propagate to the global handler, so once Phase 1 ships the field flows onto the 422 with no route change.

**Changes.**

1. **Re-pin pipelex** to the Phase 1 version in `pyproject.toml`.
2. **Contract docs.** Update `docs/openapi/pipelex-api.openapi.yaml` (error response schema gains `validation_errors`), `docs/error-responses.md`, and `docs/pipe-validate.md` with the structured-error shape and an example 422.
3. **Version surface.** Bump pipelex-api 0.3.0 → 0.4.0 so `GET /v1/version` reports an `implementation_version` the extension can gate on.
4. **Confirm 200-vs-422 boundary.** Verify whether any per-pipe validation FAILURE can surface on a **200** response (as data in `validated_pipes`) rather than always raising → 422. Document the actual contract so the extension handles both.

**Tests** (`../pipelex-api/tests/...`): `POST /v1/validate` with an invalid bundle returns 422 whose body contains `validation_errors[]`; `allow_signatures=true` still tolerates signature stubs.

**Conformance.** Check whether the `/v1/validate` error envelope is covered by the workspace `docs/specs/` ↔ `conformance/` pair. If so, update both sides and run `make check-spec-links` in `conformance/`.

> **CHECKPOINT 2.** The Pipelex API emits structured validation errors on 422 and advertises a gating version. Record the released image tag / version.

---

## Phase 3 — mthds-js (`../mthds-js`): type the report and surface structured errors

`MthdsApiClient.validate()` currently returns an opaque `ValidationReport` and throws `ApiResponseError` on 422 with the body as raw text (`src/runners/api/client.ts`, ~lines 425-442; `src/runners/api/exceptions.ts`).

**Changes.**

1. **Typed report.** Add a `PipelexValidationReport` interface (Pipelex-API extension over the protocol's extension-open `ValidationReport`) with the fields the runner returns: `bundle_blueprint`, `pipe_io_contracts`, `graph_spec`, `validated_pipes`, `pending_signatures`, `is_runnable`, `success`, `message`. Keep neutral, standard-aligned field names (no `pipelex_` prefix on bundle/graph artifacts). Have `validate()` return this type.
2. **Typed error item.** Add a `ValidationErrorItem` type mirroring the Phase 1 wire shape and export it.
3. **Surface structured errors on 422.** In the error-construction path, when the problem+json body carries `validation_errors`, parse it into a typed `validationErrors?: ValidationErrorItem[]` property on `ApiResponseError`. Keep throw-on-422 semantics (an invalid bundle is still an `ApiResponseError`); the consumer catches and reads the typed field. Export the augmented error type.
4. **graph_spec typing.** Keep `graph_spec` as opaque transport (`unknown`) in mthds-js to avoid duplicating the canonical GraphSpec schema that `@pipelex/mthds-ui` already owns; the extension casts it to the renderer's type. (Note the choice; revisit only if a shared graph type is wanted.)

**Tests** (`../mthds-js/...`): `validate()` returns the typed report on success; on 422 it throws `ApiResponseError` with a populated typed `validationErrors`; round-trips the Phase 2 example bodies.

**Versioning, docs, publish.** Bump 0.10.0 → 0.11.0; update `README.md` / `CLI.md` / `docs/architecture.md`; publish to npm so the extension can pin it.

> **CHECKPOINT 3.** `mthds-js` exposes a typed validation report and typed structured errors, published to npm. The extension can now consume the API path with full diagnostics parity. Record the published version.

---

## Phase 4 — vscode-pipelex: backend abstraction, settings, mthds-js integration

**Dependency.** Add `mthds` (pinned to the Phase 3 version) to `editors/vscode/package.json`. Verify it bundles cleanly under the extension's esbuild build (Node target, ESM/CJS interop, `fetch` available on the VS Code Node runtime).

**Backend abstraction** (new module under `editors/vscode/src/pipelex/validation/`):

- Define a single-call `ValidationBackend` interface:
  - `analyze(files, { withGraph }): Promise<BundleAnalysis>` where `BundleAnalysis = { validation: { ok: true; report } | { ok: false; errors: ValidationErrorItem[] }; graph?: GraphSpec | null }`. `graph` is populated only when `withGraph` is true. This single method makes "no two calls" structural.
  - `getBackendVersion(): Promise<...>` for gating/warnings.
- `CliValidationBackend` — refactor the existing logic (`cliResolver.ts`, `processUtils.ts`, `extractJson`) behind this interface. `withGraph:false` → `validate bundle ... --allow-signatures` (diagnostics only, no graph cost). `withGraph:true` → the Phase 1 combined `validate bundle ... --allow-signatures --view --format json` (one invocation yields both). Parse the combined envelope (`validation_errors` / `validated_pipes` / `graphspec`). Existing CLI behavior for the diagnostics-only path stays identical.
- `ApiValidationBackend` — wraps `MthdsApiClient`. One `client.validate(contents, /* allowSignatures */ true)` call always returns both; map the typed report / caught `ApiResponseError.validationErrors` into `validation`, and read `graph_spec` into `graph` when requested. Client constructed with `baseUrl` from settings and `apiToken` from SecretStorage→env.

**Dual-channel diagnostics.** The `{ ok:false; errors }` branch is fed by **two** sources that both map to diagnostics: the 422 `validation_errors` (hard failures) and any 200 `validated_pipes` entries with FAILURE status (per-pipe dry-run failures returned as data). The CLI combined envelope exposes the same two channels (`validation_errors` and `validated_pipes`). Normalize both into the `ValidationErrorItem[]` the diagnostics path already consumes.

**One-call orchestration.** The on-save handler is the single orchestration point: it sets `withGraph = (graph panel is open for this doc)`, makes one `analyze` call, routes the validation outcome to the Problems panel via the existing `toDiagnostic()` / `locateError()` path, and — when `withGraph` — hands the returned graph to the panel instead of letting the panel make its own call. A fresh panel open (or the manual graph command) makes its own `analyze(withGraph:true)` call. Net effect: save-with-panel-open is one call serving both.

**Wire the consumers** to go through the selected backend:

- `pipelexValidator.ts` (`onSave`) — replace the direct `spawnCli(...)` validate call with the `analyze(...)` orchestration above.
- `graph/methodGraphPanel.ts` — replace the `validate bundle --view` spawn with `backend.analyze(..., { withGraph:true })` and read `analysis.graph`. The canonical GraphSpec reaches the webview unchanged regardless of backend; direction stays a client-side `pipelex.graph.direction` concern.

**Settings** (`contributes.configuration` in `editors/vscode/package.json`):

- `pipelex.backend`: enum `["cli", "api"]`, default `"cli"` (preserve current zero-config behavior; `api` is opt-in).
- `pipelex.api.baseUrl`: string, default `"http://localhost:8081"`.
- **API key handling (best practice):** no plaintext key setting. The `ApiValidationBackend` resolves the token as SecretStorage → `MTHDS_API_KEY` env (which `mthds-js` reads natively). Add a command `Pipelex: Set Hosted API Key` that writes to `vscode.ExtensionContext.secrets`, and `Pipelex: Clear Hosted API Key`.

**Multi-file gathering.** For a saved `.mthds` file, read every `*.mthds` in `path.dirname(file)` and build `mthds_contents[]`, mirroring `--library-dir <dir>`. Keep a content-index → file-URI map for diagnostic placement.

**Cross-file diagnostics.** Validation errors may reference pipes/concepts declared in sibling files. Map each `ValidationErrorItem` to the owning file (via `domain_code` / `pipe_code` → declaring file) and set diagnostics on that file's URI using `sourceLocator.locateError()` against its text; errors that don't resolve fall back to the saved file or the output channel. This is the subtlest part of the API path — design it explicitly and cover it with tests.

**Version gating (both backends).**
- CLI: raise `MIN_AGENT_VERSION` (currently 0.31.0) to the Phase 1 version (0.34.0) that delivers the combined `--view` envelope, using the repo's `bump-pipelex-version` skill so all version-floor references stay in sync.
- API: add a `MIN_API_IMPLEMENTATION_VERSION` constant (the Phase 2 version). On first API use, call `client.version()` (confirm it exposes `implementation_version`), cache it, and if too old show an upgrade message (run a newer `pipelex-api` / Docker image) — analogous to `agentCliVersion.ts`.

**Privacy.** The API backend sends file contents to `baseUrl` on every save. The localhost default keeps this local; show a one-time confirmation when the `api` backend is enabled against a non-localhost host.

> **CHECKPOINT 4.** The extension validates and renders graphs through either backend, selected by `pipelex.backend`, with full diagnostics parity on the API path. CLI remains the default and unchanged.

---

## Phase 5 — vscode-pipelex: tests, docs, QA, release

- **Tests (vitest):** `ApiValidationBackend` against a mocked `MthdsApiClient` (success report, 422 with `validationErrors`, transport error); multi-file gathering; cross-file diagnostic mapping; version gating; settings/secret resolution. Preserve all existing CLI-path tests.
- **Docs:** add a backend page under `editors/vscode` docs (or this repo's `docs/`) covering CLI vs API, settings, key handling, and self-hosting `pipelex-api`; update CHANGELOG and README. Update `CLAUDE.md` if the backend seam introduces a new concept worth recording.
- **Quality gate:** `make check` (fmt, plxt fmt, clippy `-D warnings`, crate tests, vitest, WASM check).
- **Manual QA:** both backends against valid/invalid bundles, multi-file directories, graph rendering, and a hosted endpoint with a key in SecretStorage.

---

## Cross-repo release ordering

The API validation path only reaches parity once 1→3 are released, so ship in dependency order:

1. **pipelex (`../_calls`)** — release the `validation_errors` field (Checkpoint 1).
2. **pipelex-api** — re-pin pipelex, release image + bumped `implementation_version` (Checkpoint 2).
3. **mthds-js** — typed report + errors, publish to npm (Checkpoint 3).
4. **vscode-pipelex** — pin the published `mthds`, gate the API backend on the min pipelex-api version, release the extension (Checkpoints 4–5).

The graph-only API path could technically ship before 1–3 (GraphSpec already matches), but validation diagnostics would regress, so prefer shipping the whole feature together.

## Risks & open questions

Decided (no longer open): default backend = `cli`; per-pipe FAILURE may be returned as data on a 200 and the extension surfaces it; cross-file error→file mapping is the accepted main complexity of the directory-wide approach.

Remaining to verify during implementation:

- **Cross-file diagnostics** — the error→file mapping (error references a pipe/concept declared in a sibling file) is the trickiest piece; needs explicit design and tests in Phase 4.
- **`client.version()` shape** — confirm `mthds-js` exposes the `implementation_version` needed for gating.
- **esbuild bundling** of `mthds` into the extension — verify early in Phase 4.
- **Conformance coverage** of the validate error envelope — sync `docs/specs/` ↔ `conformance/` if covered.
- **Secret UX** — final shape of the SecretStorage commands and env fallback.

## Out of scope (possible follow-ups)

- Pipeline **execution** via the API (`/v1/execute`, `/v1/start`, durable run lifecycle).
- The build endpoints (`/v1/build/inputs|output|runner`, concept/pipe-spec) — separate features the extension doesn't use today.
- Surfacing the richer report fields the API returns but the CLI on-save path ignores (`pipe_io_contracts`, `bundle_blueprint`, `pending_signatures`, `is_runnable`).
