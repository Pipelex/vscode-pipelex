---
name: bump-sdk
description: >
  Move the VS Code extension onto a newer published `@pipelex/sdk` (the hosted-API client, from the
  sibling `pipelex-sdk-js` repo) — read the SDK changelog for every version crossed, check each
  change against the two files that consume it (`validation/apiValidationBackend.ts` and
  `validation/apiCapabilityGate.ts`), re-align the hand-written SDK mock and its compile-time
  conformance bindings, update the lockfile and the docs, and verify against a live API. Use
  whenever the user says "bump the SDK", "bump `@pipelex/sdk`", "update the pipelex sdk", "upgrade
  pipelex-sdk-js", "we just released SDK X.Y.Z, pull it into the extension", "get the extension onto
  the latest SDK", "we're on an old SDK", or names an API capability the extension cannot reach yet.
  Also use when the `api` validation backend fails at runtime against a real server while
  `make check` passes — that pattern usually means the pinned SDK is behind the API — when the
  capability gate warns about a server that is plainly current, and when someone asks what would
  break if the extension moved to a given SDK version.
---

# Bump `@pipelex/sdk`

`@pipelex/sdk` is our own package, published from the sibling `pipelex-sdk-js` repo, and it is pre-1.0 — **minors carry breaking changes**. The extension uses it for exactly one thing: the `api` validation backend, the alternative to shelling out to `pipelex-agent` when `pipelex.backend` is set to `api`.

What makes this bump different from `/bump-mthds-ui` in this repo, and what every step below is shaped by:

- **The consumed surface is tiny and the blast radius is not.** Two files import it. But they are the entire remote validation path, and a break there means a user's saves stop producing diagnostics against a hosted or self-hosted server, while the `cli` backend keeps working — so it is easy to ship and not notice.
- **`yarn test` proves nothing about this bump.** `apiValidationBackend.test.ts` replaces the whole SDK with a hand-written `vi.mock`. The suite stays green against a mock of an SDK that no longer exists. **`yarn typecheck` is the gate**, through a block of `import type` conformance bindings written for exactly this reason — and there is one hole in it that Step 3 names.
- **There is no `make` target and no guard.** Unlike mthds-ui, the spec is edited by hand, nothing refuses a bad one, and the pin is exact rather than a range.
- **The verification is a live API call.** No suite here reaches a server, and no test asserts the SDK's runtime behaviour. Step 6 is not optional.

## Step 1 — Establish the three versions

```bash
grep -n '"@pipelex/sdk"' editors/vscode/package.json                                # the declared PIN
node -p "require('./editors/vscode/node_modules/@pipelex/sdk/package.json').version"  # INSTALLED
npm view @pipelex/sdk version                                                        # latest PUBLISHED
npm view @pipelex/sdk versions                                                       # everything in between
```

**The spec is an exact pin — no caret, no `npm:` prefix** (`"@pipelex/sdk": "0.1.5"`), unlike every other dependency in this manifest. Keep it that way. A caret on a `0.x` package resolves patches only anyway, so the caret would buy nothing while making the manifest stop stating which version the extension was actually written against.

Report all three numbers, and say plainly how far behind the pin is. This extension has sat many minors behind at times, and a large gap changes the shape of the work: Step 2 becomes the bulk of it, and the honest answer may be to move in two or three steps rather than one, verifying against a live API at each stop.

If the user named a target, confirm it exists: `npm view @pipelex/sdk@X.Y.Z version`. **This skill only moves to published versions** — if the fix they want is unreleased, the fix is to cut the release in `../pipelex-sdk-js` first.

Note a dirty tree without treating it as a blocker; the commit at the end stages named files only.

## Step 2 — Read the changelog for every version crossed

The published tarball ships `dist/` only, so read the changelog from the sibling checkout, from `origin` rather than a local branch that may be stale:

```bash
git -C ../pipelex-sdk-js fetch origin --quiet
git -C ../pipelex-sdk-js show origin/main:CHANGELOG.md | sed -n '/## \[vTARGET\]/,/## \[vCURRENT\]/p'
```

Substitute the real numbers — the file is newest-first, so the target heading comes before the current one. If the sibling is not checked out: `gh api repos/Pipelex/pipelex-sdk-js/contents/CHANGELOG.md --jq '.content' | base64 -d`.

Read every entry, not the newest — an intermediate minor's rename is still your rename. Then read the target's own type declarations, because the changelog is a summary and the `.d.ts` is the contract:

```bash
ls editors/vscode/node_modules/@pipelex/sdk/dist/
grep -rn "class ApiResponseError\|class ApiUnreachableError\|class PipelineRequestError\|class PipelexApiClient" editors/vscode/node_modules/@pipelex/sdk/dist/*.d.ts
```

Sort what you read into three buckets:

- **Named exports and their types** — a renamed class, a moved type, a changed method signature. `yarn typecheck` catches these, both at the call sites and through the conformance bindings.
- **Constructor shapes and runtime field names** — what an error object actually carries, in what argument order. **Typecheck does not fully catch this** (Step 3), and the mock will happily keep lying.
- **Wire behaviour at an unchanged type** — what the client sends, what it does with a non-2xx, which error class a timeout becomes, whether a verdict body is reshaped before it is returned. Invisible to everything here. Every item in this bucket is a line on the Step 6 checklist.

### The seams, and what an SDK change does to each

| Seam | Where it lives | What to check |
| --- | --- | --- |
| **The client** | `src/pipelex/validation/apiValidationBackend.ts` — `new PipelexApiClient({ baseUrl, apiToken })`, then `client.validate(contents, allowSignatures, names)` | The constructor is expected to **throw `PipelineRequestError` on a non-host-only base URL** (the common trigger is a pasted `/v1` path), and the backend leans on that: it builds the client inside a `try` so a misconfiguration becomes an actionable `BackendError` instead of an escaping throw, and it does so *before* the privacy modal. If a release relaxes that validation, or moves it, the bad-URL path silently stops being caught here. `validate`'s positional argument order is load-bearing and unenforced by name. |
| **The version handshake** | `src/pipelex/validation/apiCapabilityGate.ts` — `client.version()`, narrowed by `readHandshake` | `readHandshake` reads `implementation`, `implementation_version` and `extensions` off an `unknown`, checking each at runtime, because the SDK types only `protocol_version` / `runner_version` / `implementation_version` and the rest arrive through an index signature. That means a **renamed wire field fails silently**: every field drops, the handshake comes back empty, and `assessCapability` passes with reason `no-implementation-reported`. Nothing goes red. If the SDK starts typing these fields properly, that is an opportunity to delete the narrowing — take it, and say so. |
| **The error classes** | `apiValidationBackend.ts` reads `.status`, `.statusText`, `.serverMessage`, `.code` off `ApiResponseError` and `.code` off `ApiUnreachableError` | These fields are what turn a transport failure into a `BackendError` with a usable remedy. A renamed field is caught by the conformance bindings; a **reordered constructor** is not. Read the real class declarations rather than trusting the mock. |
| **The verdict types** | `PipelexValidationResult` / `PipelexValidationReport` / `PipelexInvalidReport`, imported as types | `/validate` is 200-diagnostic: the verdict rides the body, discriminated on `is_valid`, and `is_valid: true` / `is_runnable: false` is a runnability fact rather than an error. The backend also **rejects an `is_valid: false` body carrying no `validation_errors[]`** — that rejection is the real safety net behind the lenient capability gate, so a release that reshapes the invalid report is a change to the guarantee, not to a type. |
| **The capability floors** | `STRUCTURED_VALIDATION_DIAGNOSTICS` in `apiCapabilityGate.ts` — `pipelex-api` ≥ 0.4.0, with `pipelex-hosted` and `pipelex` deliberately absent | Floors are keyed on `(implementation, version)` and **anything unrecognised passes**, on purpose: a false alarm on a healthy server is worse than a missed warning. Per the MTHDS Protocol spec the right mechanism is the `extensions` token, and each floor is deletable the day its capability gets one. So an SDK release that surfaces new `extensions` tokens is a chance to replace a floor with positive proof — the `extension` field on `CapabilityRequirement` is where that lands. Never add a floor for `pipelex-hosted`; the comment explains why its version number belongs to the wrong service. |
| **The public binding surface** | `docs/dev/mthds-engine-bindings.md` — the diagnostic shape marked `⚠️ PUBLIC BINDING SURFACE` | The lint/format diagnostic shape is mirrored across the Rust structs here, the Python `.pyi` stub, `js/tools-wasm/src/index.ts`, **and `@pipelex/sdk`'s `models.ts`**. If the SDK release changed that shape, this is not a version bump — it is a cross-repo sync, all mirrors in one change, and it should be flagged to the user before you start editing. |
| **The transitive `mthds` package** | `@pipelex/sdk` depends on `mthds` (the protocol types); this extension deliberately declares **no** direct dependency on it | Dropping the direct `mthds` dep was a deliberate move when the extension adopted `PipelexApiClient`. Do not re-add it to reach a type — reach it through `@pipelex/sdk`'s own re-exports, or ask for one. |
| **Both bundles carry it** | `rollup.config.mjs` (node, `preferBuiltins`) and `rollup.config.browser-extension.mjs` (`browser: true`), both entered from `src/extension.ts` | The SDK is bundled into `dist/extension.js` **and** `dist/browser-extension.js`. A release that reaches for a Node builtin, or drops its `browser` export condition, breaks the web build only — and `make ext` is what surfaces it, not `yarn typecheck`. |

## Step 3 — Re-align the mock, and understand what the conformance block does not cover

`src/pipelex/__tests__/apiValidationBackend.test.ts` replaces the SDK entirely with a `vi.mock` factory that hand-defines `PipelexApiClient`, `ApiResponseError`, `ApiUnreachableError` and `PipelineRequestError`. Below the mock sits a block of `import type` bindings against the **real** package:

```ts
type _ClientSurface = Pick<RealPipelexApiClient, 'validate' | 'version'>;
type _ClientOptions = Required<Pick<PipelexApiClientOptions, 'baseUrl' | 'apiToken'>>;
type _ResponseErrorFields = Pick<RealApiResponseError, 'status' | 'statusText' | 'serverMessage' | 'code'>;
type _UnreachableErrorFields = Pick<RealApiUnreachableError, 'code'>;
```

`vi.mock` swaps the runtime; TypeScript still resolves those `import type`s to the published `.d.ts`. So a removed method, a removed option key or a removed error field fails `yarn typecheck` and cannot merge — that is the guard, and it works.

**What it does not cover, and must be checked by hand:**

- **Constructor arity and argument order.** The mock's classes declare their own message-first positional constructors. Nothing binds them to the real ones, so a reordered or lengthened SDK constructor leaves the mock green and lying. Read the real declarations and mirror them.
- **The client's runtime behaviour.** The mock's `PipelexApiClient` re-implements the base-URL rejection by hand. If the SDK changes when or whether it throws, the mock keeps the old behaviour and the test keeps asserting it.
- **Anything the extension reads off a value rather than a type** — the shape of a verdict body, what a timeout becomes, what `version()` actually returns.

So the routine, whenever the changelog touches any of this: update the mock to mirror the real thing, extend the conformance bindings to cover whatever new field the backend starts reading, and say in your summary which of the three uncovered categories you verified by hand and how.

```bash
grep -rn "@pipelex/sdk" editors/vscode/src
grep -rn "<the changed symbol>" editors/vscode/src docs/
```

Then present the plan — target version, the seams each bullet lands on, which checks you expect to go red, and every wire-behaviour item you cannot prove is safe. Those become the Step 6 checklist.

## Step 4 — Bump and install

Edit the `@pipelex/sdk` line in `editors/vscode/package.json` to the exact target version, then:

```bash
cd editors/vscode && yarn install
node -p "require('./node_modules/@pipelex/sdk/package.json').version"                    # confirm it landed
node -p "JSON.stringify(require('./node_modules/@pipelex/sdk/package.json').dependencies)"  # what came along
cd ../.. && git status --short                                                            # expect package.json + yarn.lock
```

Read the install output rather than scrolling past it — an unmet peer warning is a finding, not noise. Commit `editors/vscode/yarn.lock` with the manifest: both required PR gates run `cd editors/vscode && yarn install --immutable`, which fails on any lockfile the manifest does not already agree with.

## Step 5 — Build and run the checks

```bash
make ext                                   # rollup node + browser bundles, and the webview bundle
make check                                 # fmt, clippy, every suite incl. yarn typecheck, WASM compile
```

`make check` is the CI gate, so green here is green there. `make test-ext` (`yarn typecheck` + vitest) is the fast loop while fixing a type error.

What each part proves for **this** bump:

- **`yarn typecheck`** — the two call sites still compile, and the conformance bindings still resolve against the real `.d.ts`. This is the gate.
- **`make ext`** — the SDK still bundles for **both** the node and the browser targets. A Node-builtin reach shows up only here.
- **`yarn test`** — the backend's own logic against a mock. **It says nothing about the SDK.** Do not report it as evidence the bump works.

Per the workspace principle, a pre-existing bug this bump reveals gets fixed, and the changelog says the bump revealed it rather than caused it.

## Step 6 — Validate against a live API. This is the verification

```bash
make ext-install
```

Then **reload the window** — a running Extension Host keeps the code it loaded at activation.

Point the extension at a real server and exercise the paths the SDK owns. In settings: set `pipelex.backend` to `api`, set `pipelex.api.baseUrl`, and run **`Pipelex: Set Hosted API Key`** if the server needs one. A local `pipelex-api` is the cheapest target and the one whose version you control; say which environment you used, because the answer differs between a bare `pipelex-api`, the hosted plane and a local runtime.

Save a `.mthds` file and check:

- **A valid bundle** produces no diagnostics and a `valid` verdict in the graph's validation widget.
- **An invalid bundle** produces diagnostics with messages, locations and owning files — this is the structured `validation_errors[]` path, and the one most likely to move.
- **A bundle with pending signatures** comes back valid-but-not-runnable rather than as an error.
- **A wrong base URL** (a host that does not answer, and separately a URL carrying a `/v1` path) surfaces an actionable notification and **clears stale diagnostics** rather than silently falling back to the CLI.
- **The capability warning** fires only when it should. Check the `Pipelex` output channel for the `[capability]` line: it names the verdict and the reason for every probe, so it tells you whether a server passed for the right reason.
- **The remote-send confirmation** still appears once for a non-localhost host, before the first request.

If the changelog touched only an SDK surface this extension does not consume — the run lifecycle, storage, methods, orgs, billing — say so and skip what genuinely does not apply, but name what you skipped and why.

## Step 7 — Docs

```bash
grep -rln "@pipelex/sdk\|pipelex-sdk" docs/ CLAUDE.md
```

`docs/dev/mthds-engine-bindings.md` names `@pipelex/sdk`'s `models.ts` as one of the mirrors of the public binding surface — if the SDK moved that shape, this doc and every other mirror move in the same change. `docs/dev/release-publishing.md` mentions the SDK repo only as a peer that uses the same OIDC publish model; leave it unless that actually changed. If the bump changed how the `api` backend behaves for a user, the feature docs that describe validation say so too.

## Step 8 — Changelog and commit

Add the entry to the **root `CHANGELOG.md`** under `## [Unreleased]`. `editors/vscode/CHANGELOG.md` is generated from it — never edit that file; run `./scripts/compose-docs.sh` if it needs regenerating.

Say what the SDK changed **and what it meant here**: which call site moved, what a user of the `api` backend would see differently, and — if a capability floor was deleted in favour of an `extensions` token — that the gate got more honest. Per the workspace rule, write "breaking", never "pre-1.0 breaking", and never hardcode counts.

Whether the extension's own version needs bumping is the `/release` skill's call, not this one.

Then summarize for the user: the version move, every file touched, **which of the three mock-uncovered categories you verified by hand**, which server you validated against and what you saw, and any unresolved item. On confirmation, stage only the files this bump touched — never `git add .` — and commit. Offer pushing and opening a PR against `dev`, and wait for explicit approval.

## Rules

- Keep the pin exact — no caret, no `npm:` prefix, no range.
- Never point the pin at an unpublished version; cut the release in `../pipelex-sdk-js` first.
- Commit `editors/vscode/yarn.lock` with `package.json` — both PR gates install with `--immutable`.
- Never report a green `yarn test` as evidence about the SDK: the suite runs against a hand-written mock.
- Mirror the real constructors in that mock, and extend the conformance bindings whenever the backend starts reading a new field. Never delete a binding to go green.
- Never add a version floor for `pipelex-hosted`; prefer an `extensions` token over any new floor.
- A change to the `⚠️ PUBLIC BINDING SURFACE` diagnostic shape is a cross-repo sync — flag it before editing, and move every mirror in one change.
- Do not re-add a direct `mthds` dependency to reach a type.
- Run `make ext`, not just `yarn typecheck`: the browser bundle is the half a Node-only SDK breaks.
- Reload the Extension Host window before believing anything you see in it.
- Edit the root `CHANGELOG.md`, never the generated `editors/vscode/CHANGELOG.md`.
- Never use `git add .` or `git add -A`; never push or open a PR without explicit approval.
- If a step fails or the user wants to abort, stop immediately rather than continuing the workflow.
