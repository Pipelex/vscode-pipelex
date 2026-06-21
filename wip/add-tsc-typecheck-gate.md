# Follow-up: add a real `tsc` typecheck gate to `editors/vscode`

## Context / problem

Bare `tsc --noEmit -p .` fails on `main` in `editors/vscode`, yet neither `make check` nor CI catches it. This doc captures why, and the plan to close the gap.

## Why type errors get through today

**Nothing in any gate runs `tsc`.** The whole TS pipeline for `editors/vscode` is esbuild-based, and esbuild *strips* types per-file — it never type-checks:

- `build:node` / `build:browser-*` → rollup with `rollup-plugin-esbuild`
- the webview → a direct `esbuild.buildSync` in `scripts/build.mjs`
- `yarn test` → vitest (also esbuild-powered transform)

The only `tsc`-family tool that runs is `ts-node` for `build:syntax`, and that uses a *different* config (`node.tsconfig.json`), only transpiles the grammar-generator entrypoints under `src/syntax/`, and doesn't whole-program type-check.

It's worse than "tsc isn't run": **`make check` and CI's extension job don't even build the bundle.** `make check` → `test` → `cd editors/vscode && yarn test` (vitest only); CI's `test` job runs just `yarn install --immutable && yarn test`. The real esbuild bundle only runs at `make ext`/`vsix`/release time, and even that catches only syntax/resolution breaks, never type errors.

So the "real gates" (vitest + the eventual esbuild build) verify the code *transpiles and tests pass* — they never assert the project *type-checks*.

## Why bare `tsc --noEmit -p .` fails

Running it surfaces errors in two buckets.

**Config noise** — the current `tsconfig.json` is authored for esbuild's transpile-only model, not standalone tsc:

- `"lib": ["ES2019"]` with no `DOM`/`WebWorker` → `window`, `document`, `Worker`, `self` are unknown in the webview adapter and `server-worker.ts`.
- `"moduleResolution": "node"` can't follow `@pipelex/mthds-ui`'s subpath `exports` (`.../graph/react`) — tsc itself suggests switching to `bundler`. esbuild does bundler-style resolution natively.

**Real signal hiding underneath** — genuine latent bugs nothing currently catches:

- `src/client.ts` — calls `handleInitializeResult`, which no longer exists on `LanguageClient` (upstream `vscode-languageclient` API drift; tsc suggests `initializeResult`).
- `src/server-worker.ts` — builds an `Environment` object **missing the required `envVars`** property.
- `src/pipelex/__tests__/apiValidationBackend.test.ts` — calls functions with the wrong arity (too few args). Passes at runtime only because JS doesn't enforce arity (missing args = `undefined`) — exactly what a type-check would catch.

## Proposed fix

Add a *real* typecheck gate — do **not** try to make the current esbuild-oriented `tsconfig.json` pass tsc. Keep it additive and scoped to `editors/vscode` (respects the fork rule — don't disturb the upstream/esbuild base config). The extension's host↔webview message protocol and the cross-repo GraphSpec contract are exactly the surface that benefits from static checking, and today they have none.

1. Add `editors/vscode/tsconfig.typecheck.json` (extends the base) with:
   - `"noEmit": true`
   - `"lib": ["ES2020", "DOM", "WebWorker"]`
   - `"moduleResolution": "bundler"`
   - `"include": ["src"]`
   - i.e. model the actual runtime envs (extension host = node, webview = DOM, server-worker = WebWorker). If the mixed lib set causes conflicts, split into per-area configs via project references.
2. Add a `"typecheck": "tsc -p tsconfig.typecheck.json"` script to `package.json`.
3. Fix the real errors first so the gate starts green:
   - `client.ts` `handleInitializeResult` → `initializeResult` (verify against the installed `vscode-languageclient` API).
   - `server-worker.ts` `Environment` missing `envVars`.
   - `apiValidationBackend.test.ts` stale call arity.
4. Wire `yarn typecheck` into the `test`/`check` Make target and the CI `test` job (`.github/workflows/ci.yaml`).

## Caveats

- Small project, not a one-liner — get it green before gating.
- `strict` is currently `false`, so even after this the coverage is shallow. Ratcheting `strict` on is a worthwhile separate follow-up.
- Branch note: `release/v0.10.0` is mid-release; do this on a fresh branch off `main` unless we decide to fold it into the release.
