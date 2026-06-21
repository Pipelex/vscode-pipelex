# TODO: add a real `tsc` typecheck gate to `editors/vscode`

Source brief: [`wip/add-tsc-typecheck-gate.md`](wip/add-tsc-typecheck-gate.md). This doc is the executable plan with verified specifics; the brief is the rationale.

**Branch:** `fix/Type-checking` (already off `main` — the intended home for this work; do **not** fold into a release branch).

## Goal

Add an additive, `editors/vscode`-scoped `tsc --noEmit` gate that actually type-checks the extension (the host↔webview protocol and the cross-repo GraphSpec contract have zero static checking today), fix the genuine latent bugs so it starts green, and wire it into `make check` + CI so it can't regress.

**Respect the fork rule:** do not touch the upstream/esbuild-oriented base `tsconfig.json` semantics for the build. The gate is a *separate* `tsconfig.typecheck.json` that extends the base and overrides only what standalone tsc needs.

## Why type errors get through today (one-paragraph recap)

The whole TS pipeline is esbuild-based (rollup + `rollup-plugin-esbuild` for node/browser, a direct `esbuild.buildSync` for the webview, vitest for tests) — esbuild **strips** types per-file and never type-checks. The only `tsc`-family tool that runs is `ts-node` for `build:syntax`, on a different config (`node.tsconfig.json`) and only the grammar generators. Worse: `make check` → `test` → `cd editors/vscode && yarn test` runs **vitest only** (no bundle), and CI's `test` job runs just `yarn install --immutable && yarn test`. So nothing asserts the project type-checks.

## Confirmed current errors (`yarn tsc --noEmit -p .` on this branch)

Three buckets. Verified against installed deps (`vscode-languageclient@9.0.1`, `mthds@0.12.0`, `@taplo/core`, `@pipelex/mthds-ui@0.9.0`).

**A. Config noise** — disappears once the gate uses the right `lib` + `moduleResolution` (no code change):
- `adapter.ts:4` — `Cannot find module '@pipelex/mthds-ui/graph/react'` under `moduleResolution: node`. Types exist at `node_modules/@pipelex/mthds-ui/dist/graph/react/index.d.ts`; `bundler` resolution follows the subpath `exports`.
- `adapter.ts:17,100,176,185,186` — `window` / `document` unknown (no `DOM` lib).
- `client.ts:71` — `Cannot find name 'Worker'` (no `DOM` lib).
- `server-worker.ts:8` — `Worker` / `self` unknown (no `DOM` lib). **Note:** DOM lib alone resolves all of these — `server-worker.ts` does `const worker: Worker = self as any` (the `as any` means we do **not** need the `WebWorker` lib, which would conflict with `DOM`).

**B. Real bug — `src/client.ts:41,62`** — `handleInitializeResult` does not exist on `LanguageClient`. Confirmed: in `vscode-languageclient@9.0.1`, `BaseLanguageClient` exposes a **read-only `get initializeResult()`** getter and a protected `fillInitializeParams()` hook, but **no `handleInitializeResult` override point** (`doInitialize` is private). The override in both `PipelexNodeLanguageClient` and `PipelexBrowserLanguageClient` is **dead code** — its `super.handleInitializeResult(...)` would throw if ever reached, and nothing calls it. tsc's "Did you mean `initializeResult`?" is **misleading** (that's a getter, not a hook). → **Fix = delete the override entirely from both classes.** UTF-16 negotiation is already handled by the `fillInitializeParams` override (`params.capabilities.general.positionEncodings = ["utf-16"]`), which is the actual, supported mechanism.

**C. Real bug — `src/server-worker.ts:18`** — the `Environment` object is missing the required `envVars` property. `@taplo/core`'s `Environment` interface requires `envVars: () => Array<[string, string]>`. → **Fix = add `envVars: () => [],`** to the env literal (a browser worker has no env vars; matches the existing `envVar: () => ""`).

**D. Real bug — `src/pipelex/__tests__/apiValidationBackend.test.ts:192,199,213,232,239,247`** — stale constructor arity. The test `vi.mock('mthds', …)` but **imports the real types** (`import { ApiResponseError, ApiUnreachableError } from 'mthds'`). tsc checks call sites against the **real** `mthds@0.12.0` `.d.ts`, which changed both classes to **message-first** signatures, while the in-test mock classes and every call site still use the old `status`-first order. Both the mock **and** the call sites must be re-aligned.

  Real signatures (`node_modules/mthds/dist/runners/api/exceptions.d.ts`):
  ```ts
  class ApiResponseError extends PipelineRequestError {
    constructor(
      message: string, apiUrl: string, status: number, statusText: string,
      responseBody: string, errorType: string | undefined,
      serverMessage: string | undefined,
      validationErrors: ValidationErrorItem[] | undefined,
      options?: { cause?: unknown },
    );
  }
  class ApiUnreachableError extends PipelineRequestError {
    constructor(message: string, apiUrl: string, code: string | undefined, options?: { cause?: unknown });
  }
  ```
  Backend reads only these props off the caught error (`src/pipelex/validation/apiValidationBackend.ts`): `ApiResponseError.status`, `.serverMessage`, `.statusText`; `ApiUnreachableError.code`. The mock must keep populating those (the real ctor assigns them as readonly public fields, so mirroring the real signature is sufficient). The error's `apiUrl` is **not** read by the backend (it uses its own `baseUrl`), but populate it anyway to mirror reality.

> After applying B/C/D and the new config, **re-run and fix any residual errors** the new `lib`/resolution surfaces (e.g. now-resolved `@pipelex/mthds-ui` types could flag a `GraphViewer` prop mismatch in `adapter.ts`). The three buckets are the known baseline, not a guarantee of completeness — iterate to green.

## The gate config (decided)

`editors/vscode/tsconfig.typecheck.json`:
```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler"
    // base already sets module: ESNext (required by bundler resolution) and strict: false
  },
  "include": ["src"],
  "exclude": ["node_modules", "vitest.config.mts"]
}
```
Decisions / rationale:
- **`DOM` + `DOM.Iterable`, no `WebWorker`** — DOM covers `window`/`document`/`Worker`/`MessageEvent` and the `self as any` cast in `server-worker.ts`. Adding `WebWorker` alongside `DOM` causes duplicate-identifier conflicts; we don't need it. (Supersedes the brief's `["ES2020","DOM","WebWorker"]` suggestion and removes the need for project references.)
- **`moduleResolution: bundler`** — matches what esbuild does natively; required to follow `@pipelex/mthds-ui`'s subpath `exports`. Needs `module: esnext`+ (base ✓) and TypeScript ≥5 (installed `^5.3.3` ✓).
- **`strict` stays `false`** (inherited). Consequence: missing `@types/react`/`@types/react-dom` is a silent `any` import (not an error) because `noImplicitAny` is off — so React types are **not** a blocker for v1. Coverage is therefore shallow; ratcheting `strict` on is a separate follow-up (below).
- **Tests are included** (`src/**/__tests__/*.test.ts`) on purpose — the arity bug (bucket D) lives in a test. Tests use explicit `vitest` imports (no globals config needed).

## Plan / checklist

### Phase 1 — fix the real bugs (get to green)
- [ ] `src/client.ts` — delete the `handleInitializeResult` override from **both** `PipelexNodeLanguageClient` and `PipelexBrowserLanguageClient` (keep the `fillInitializeParams` overrides). Confirm no other call site references it.
- [ ] `src/server-worker.ts` — add `envVars: () => [],` to the `Environment` literal passed to `PipelexLsp.initialize`.
- [ ] `src/pipelex/__tests__/apiValidationBackend.test.ts` — rewrite the in-mock `ApiResponseError` / `ApiUnreachableError` classes to the **message-first** real signatures, and update all `new ApiResponseError(...)` / `new ApiUnreachableError(...)` call sites (lines ~192/199/213/232/239/247) to the new argument order. Keep `.status`/`.serverMessage`/`.statusText`/`.code` populated so the backend-derived assertions (`err.kind`, `err.userMessage`, `err.detailHtml`) still hold.

### Phase 2 — add the gate
- [ ] Add `editors/vscode/tsconfig.typecheck.json` (config above).
- [ ] Add script to `editors/vscode/package.json`: `"typecheck": "tsc -p tsconfig.typecheck.json"`.
- [ ] Run `cd editors/vscode && yarn typecheck`; fix any **residual** errors beyond the three buckets until exit 0.

### Phase 3 — wire into gates
- [ ] `Makefile` `test` target — add `cd $(EXT_DIR) && yarn typecheck` (alongside the existing `yarn test`) so `make check` covers it. (`check: check-no-local-deps fmt-check lint test`.)
- [ ] `.github/workflows/ci.yaml` `test` job — add a `yarn typecheck` step in `editors/vscode` (CI runs `yarn install --immutable && yarn test` directly; it does **not** go through make, so it needs its own step).

### Phase 4 — verify & document
- [ ] `cd editors/vscode && yarn typecheck` → exit 0.
- [ ] `cd editors/vscode && yarn test` → still green (confirms the test rewrite didn't change behavior).
- [ ] `make check` → green end-to-end (fmt, plxt fmt, clippy, crate tests, vitest, typecheck, wasm).
- [ ] `make ext` → extension still builds (the gate is additive; bundle unaffected).
- [ ] Update `editors/vscode` docs (`docs/`) and the root `CHANGELOG.md` (`## [Unreleased]`) noting the new typecheck gate. Per repo convention, no hardcoded counts.
- [ ] Delete `wip/add-tsc-typecheck-gate.md` once landed (its content is captured here + in the changelog).

## Risks / watch-items
- New `lib`/resolution may surface errors not in the three known buckets (most likely a `GraphViewer` prop-type mismatch in `adapter.ts` now that mthds-ui types resolve). Treat "get `yarn typecheck` to exit 0" as the real acceptance bar, not "fixed the three buckets."
- Keep changes scoped to `editors/vscode` — do not edit the base `tsconfig.json` build semantics or any upstream/taplo crate.

## Out of scope (separate follow-ups)
- Ratcheting `strict: true` (and adding `@types/react`/`@types/react-dom`) for deeper coverage — meaningfully larger, do after this lands green.
- Type-checking `vitest.config.mts` / `*.mjs` build scripts (excluded here).
