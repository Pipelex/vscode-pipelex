# TODO: ratchet the `editors/vscode` typecheck gate to fully `strict`

Follow-up to the now-landed typecheck gate (commit `9ec9df5`, "feat(typecheck): add tsc type-check gate for the VS Code extension"). That work added an additive, `editors/vscode`-scoped `tsc --noEmit` gate running with `strict: false`. This plan turns `strict` **fully on**, one flag (or one zero-cost batch) at a time, fixing the code as we go — so coverage deepens without a single giant red step.

**Branch:** `fix/Type-checking-2` (already off `main`). Keep the work here; do not fold into a release branch.

---

## Cold-start orientation (read this first)

### What the gate is, and where it lives
- **`editors/vscode/tsconfig.typecheck.json`** — the gate. Extends the base build `tsconfig.json` and overrides only what standalone `tsc --noEmit` needs (`lib: ["ES2020","DOM","DOM.Iterable"]`, `moduleResolution: "bundler"`, `noEmit`). It currently inherits `strict: false` from the base.
- **`editors/vscode/tsconfig.json`** — the base build config, **`strict: false`**. **Do not change its strict semantics.** Per the fork rule (root `CLAUDE.md` → "Preserve Upstream Taplo Behavior") and because the esbuild/rollup build strips types per-file and never type-checks, strictness belongs **only** in the gate config. We ratchet `tsconfig.typecheck.json`, never the base.
- Script: `editors/vscode/package.json` → `"typecheck": "tsc -p tsconfig.typecheck.json"`.

### How it is enforced (already wired — no new wiring needed)
Both gates already invoke `yarn typecheck`, so **every flag we flip is enforced the moment it lands** — there is nothing extra to hook up at the end:
- **`make check`** → `test` target → `Makefile:112`: `cd $(EXT_DIR) && { yarn typecheck; tc=$$?; yarn test; vt=$$?; [ $$tc -eq 0 ] && [ $$vt -eq 0 ]; }`
- **CI** → `.github/workflows/ci.yaml:102-103`: a dedicated "Typecheck VS Code extension" step `cd editors/vscode && yarn typecheck` (CI does not go through `make`, so it has its own step — already present).

### The full `strict` family (TypeScript 5.9)
`strict: true` is exactly these eight flags. Enabling all eight individually == `strict: true` (verified — both produce the identical error set). It does **not** include `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, etc. — those are out of scope here.

| Flag | Cost in our code |
| --- | --- |
| `strictFunctionTypes` | clean |
| `strictBindCallApply` | clean |
| `noImplicitThis` | clean |
| `useUnknownInCatchVariables` | clean |
| `alwaysStrict` | clean |
| `strictNullChecks` | needs fixes (Phase 2) |
| `strictPropertyInitialization` | clean today, but **requires `strictNullChecks`** to enable |
| `noImplicitAny` | needs fixes (Phase 4) |

### The one sequencing insight that matters
**Do `strictNullChecks` *before* `noImplicitAny`.** Measured in isolation `noImplicitAny` surfaces a pile of implicit-`any` errors in the test files (empty `[]` literals, un-annotated returns). But once `strictNullChecks` is on, those same expressions infer concrete types, and the `noImplicitAny` surface collapses to just the two missing-React-types imports in `adapter.ts`. Ordering SNC first turns Phase 4 from "annotate a dozen test helpers" into "install `@types/react`". The phases below are in the cheap order.

### How to (re)measure on a cold start
Line numbers and the per-phase error lists below are a **snapshot taken 2026-06-21** — re-run to refresh; the file:line list is the spec, the prose is not. To see the full target set at once:
```bash
cd editors/vscode
cat > ./_tc_strict.tmp.json <<'EOF'
{ "extends": "./tsconfig.typecheck.json", "compilerOptions": { "strict": true } }
EOF
npx tsc -p ./_tc_strict.tmp.json 2>&1 | grep 'error TS'; rm -f ./_tc_strict.tmp.json
```
To measure a single intermediate step, put the flags you're testing in that temp config's `compilerOptions` instead of `"strict": true`.

### The complete target error set (full `strict`, verified 2026-06-21)
Everything below must be green by the end. Three of these are fixed in Phase 2, two in Phase 4.
- `src/server.ts:21` — TS2322: `Object.entries(process.env)` is `[string, string|undefined][]`, not the `[string, string][]` the LSP `Environment` wants. *(Phase 2 — real)*
- `src/server.ts:81` — TS2722: `process.send(message)` — `process.send` is `… | undefined`. *(Phase 2 — real)*
- `src/pipelex/__tests__/validation.test.ts:239` — TS2345: `which.sync` mock returns `null` where the chosen overload types `string`. *(Phase 2 — test-only)*
- `src/pipelex/graph/webview/adapter.ts:1` — TS7016: no declaration file for `react`. *(Phase 4 — deps)*
- `src/pipelex/graph/webview/adapter.ts:2` — TS7016: no declaration file for `react-dom/client`. *(Phase 4 — deps)*

---

## Phase 1 — enable the zero-cost batch (no code changes)

These five flags surface **no** errors in our code. Land them together.

- [x] In `tsconfig.typecheck.json` `compilerOptions`, add:
  ```jsonc
  "strictFunctionTypes": true,
  "strictBindCallApply": true,
  "noImplicitThis": true,
  "useUnknownInCatchVariables": true,
  "alwaysStrict": true,
  ```
- [x] `cd editors/vscode && yarn typecheck` → exit 0.
- [x] Commit: `feat(typecheck): enable zero-cost strict flags for editors/vscode`. *(landed: `1dd37d7`)*

---

## Phase 2 — `strictNullChecks` (the substantive one)

This flag finds the two genuine latent null-safety bugs in production code (`server.ts`) plus one test-only mock typing. Fix all three, then enable.

- [x] **`src/server.ts:21`** — filter out undefined env values so the entries match `[string, string][]`:
  ```ts
  envVars: () =>
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ```
  *(Why real: `process.env` is `Record<string, string | undefined>`; an unset var would otherwise flow through as `undefined`.)*
- [x] **`src/server.ts:81`** — `process.send` only exists when the process was forked with an IPC channel, so it is typed `| undefined`. Use an optional call (behavior-preserving — this worker is always forked with IPC, so it never actually no-ops):
  ```ts
  onMessage(message) {
    process.send?.(message);
  },
  ```
- [x] **`src/pipelex/__tests__/validation.test.ts:239`** — the `which.sync` overload TS resolves here returns `string`; the mock returns `null` to simulate "not found". Cast in the test (mirrors the real `{ nothrow: true }` runtime which can return `null`):
  ```ts
  vi.mocked(which.sync).mockReturnValue(null as unknown as string);
  ```
- [x] Add `"strictNullChecks": true,` to `tsconfig.typecheck.json` `compilerOptions`.
- [x] `cd editors/vscode && yarn typecheck` → exit 0. Re-run and fix any **residual** SNC errors not in the list above (treat exit 0 as the bar, not "fixed the three"). *(measured: exactly the three documented errors, no residuals)*
- [x] `cd editors/vscode && yarn test` → still green (confirms the `server.ts` and test edits didn't change behavior). *(all tests pass)*
- [x] Commit: `fix(typecheck): satisfy strictNullChecks (guard env entries + process.send)`.

---

## Phase 3 — `strictPropertyInitialization`

Depends on `strictNullChecks` (TS refuses it otherwise — that's why it follows Phase 2). It surfaces **no** errors in our code today, so this is effectively free — but it must be **re-measured after Phase 2 lands**, because class-field inference can shift.

- [x] Add `"strictPropertyInitialization": true,` to `tsconfig.typecheck.json` `compilerOptions`.
- [x] `cd editors/vscode && yarn typecheck` → exit 0. If any uninitialized class-property errors appear (none expected as of 2026-06-21), fix by either a definite-assignment annotation (`field!: T`) or a constructor/initializer — prefer a real initializer over `!` where the value is genuinely always set. *(clean — no errors after Phase 2)*
- [x] Commit: `feat(typecheck): enable strictPropertyInitialization`. *(landed as its own commit — Phase 2 was already committed.)*

---

## Phase 4 — `noImplicitAny`

After Phase 2, the only remaining implicit-`any` errors are the two missing React type packages used by the webview adapter (`adapter.ts` uses `React.createElement`, **not** JSX, so **no `jsx` tsconfig option is needed**).

- [x] Install the React types matching the installed runtime (react / react-dom are `19.2.4`):
  ```bash
  cd editors/vscode && yarn add -D @types/react@^19 @types/react-dom@^19
  ```
  *(installed: `@types/react@19.2.17`, `@types/react-dom@19.2.3`)*
- [x] Add `"noImplicitAny": true,` to `tsconfig.typecheck.json` `compilerOptions`.
- [x] `cd editors/vscode && yarn typecheck` → exit 0. **Watch-item:** once `@types/react` resolves, `React.createElement(GraphViewer, {…})` in `adapter.ts:157` becomes type-checked against `GraphViewer`'s real props (`@pipelex/mthds-ui`); a prop mismatch could newly surface. If so, fix the prop shape at the call site — do not loosen with `any`. Re-run until exit 0. *(no prop mismatch surfaced; exit 0)*
- [x] `cd editors/vscode && yarn test` → still green. *(all tests pass)*
- [x] Commit: `feat(typecheck): enable noImplicitAny (+ @types/react, @types/react-dom)`.

---

## Phase 5 — collapse to `strict: true` and verify enforcement end-to-end

All eight flags are now on. Replace them with the single canonical switch so the config reads its intent, then prove the whole gate chain is green.

- [ ] In `tsconfig.typecheck.json` `compilerOptions`, remove the eight individual flags added across Phases 1–4 and replace with a single `"strict": true,`. (Leave the base `tsconfig.json` at `strict: false` — fork rule.)
- [ ] `cd editors/vscode && yarn typecheck` → exit 0 (must be identical to the per-flag end state — verified equivalent on 2026-06-21).
- [ ] `make check` → green end-to-end (fmt, plxt fmt, clippy, crate tests, **typecheck**, vitest, wasm).
- [ ] `make ext` → extension still builds (the gate is additive; the esbuild bundle is unaffected by `tsc` strictness).
- [ ] Update `editors/vscode/docs/` (note the gate is now fully strict) and the root `CHANGELOG.md` `## [Unreleased]` (no hardcoded counts per repo convention).
- [ ] Delete this `TODOS.md` once landed (its content is captured in the commits + changelog).
- [ ] Commit: `feat(typecheck): enforce full strict mode for editors/vscode`.

---

## Risks / watch-items
- **Re-measure, don't trust the snapshot.** Line numbers and per-phase error sets are from 2026-06-21. A rebased branch or a bumped `@pipelex/mthds-ui` / `mthds` / `vscode-languageclient` can shift them. Re-run `yarn typecheck` at the start of each phase.
- **`acquireVsCodeApi()`** in `adapter.ts` is an injected webview global; it did **not** error under full strict (it's declared/ambient), so no shim is needed — but flag it if Phase 4 surprises you.
- **Scope discipline.** Keep every change inside `editors/vscode`. Do not edit the base `tsconfig.json` build semantics, the rollup/esbuild configs, or any upstream/taplo Rust crate.
- **Acceptance is `yarn typecheck` exit 0**, not "fixed the listed errors" — a newly enabled flag can surface something not in the snapshot. Iterate to green each phase.

## Out of scope
- Stricter-than-`strict` flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`) — separate follow-up once full `strict` lands.
- Type-checking `vitest.config.mts` / `*.mjs` build scripts (excluded from the gate).
- Moving strictness into the base build `tsconfig.json` — intentionally never; the build is esbuild, strictness lives only in the gate.
