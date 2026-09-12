---
name: bump-mthds-ui
description: >
  Move the VS Code extension onto a newer published `@pipelex/mthds-ui` (the graph rendering
  library, from the sibling `mthds-ui` repo) — read the library changelog for every version
  crossed, check each change against the seams this extension consumes (the `static-graph` builder
  the host calls, the `GraphViewer` props the webview mounts, the `dist/` stylesheets the esbuild
  CSS bundle and `formKernelTokens.test.ts` reach by literal path, the form kernel that arrives
  transitively, the subpath `exports` map the typecheck gate follows), pin the version through
  `make use-npm`, and land it green. Use whenever the user says "bump mthds-ui", "update
  `@pipelex/mthds-ui`", "bump the graph lib", "upgrade the graph renderer", "we just released
  mthds-ui X.Y.Z, pull it into the extension", "get the extension onto the latest mthds-ui", or
  names a graph, detail-panel, data-viewer or validation-widget fix the extension cannot reach yet.
  Also use when someone has been developing against a portal-linked `../mthds-ui` (`make use-local`
  / `make ul`) and needs to pin the released version before merging, when `make check` fails on
  `check-no-local-deps`, when `make ext` fails with an `ENOENT` on a path under
  `node_modules/@pipelex/mthds-ui/dist/`, when the graph webview renders unstyled or the detail
  panel's controls paint transparent, and when someone asks what would break if the extension moved
  to a given mthds-ui version.
---

# Bump `@pipelex/mthds-ui`

`@pipelex/mthds-ui` is our own package, published from the sibling `mthds-ui` repo, and it is pre-1.0 — **minors carry breaking changes routinely**, and this consumer has already been broken by several: `StuffViewer` and its stylesheet were deleted in `0.20.0` and the build died on a `cpSync` of a path that no longer existed; the same release moved the data viewer behind two `/validate` artifacts the extension was not passing, so every data node silently fell to the renderer's floor; `0.14.0` shipped a builder that threw on `domain = "constructor"` and a later release fixed it, turning a test that had pinned itself to that bug red on the good news. So this is never a one-line edit: the changelog is the input and the migration is the work.

What makes this bump different from `/bump-sdk` in this repo, and what every step below is shaped by:

- **The version is set through `make use-npm`, not by editing `package.json`.** Three separate guards refuse a local link, because this repo supports developing against a portal-linked sibling checkout, and two of them admit nothing but `npm:` or a sprint pin at a full commit SHA. Step 1.
- **The library is consumed from both sides of the extension.** The **host** (Node) calls the static-graph builder; the **webview** (browser, esbuild IIFE) mounts `GraphViewer`. A release can break one and not the other, and they fail in completely different ways — a host break is a stack trace in the Output channel, a webview break is a blank or unstyled panel with nothing thrown.
- **Two suites reach into `node_modules/@pipelex/mthds-ui/dist/` by literal path.** `formKernelTokens.test.ts` reads three stylesheets and the form kernel's own. A sheet renamed or deleted upstream fails there with an `ENOENT` naming the path — which is the good case, and deliberately so.
- **Nothing in this repo renders a `GraphViewer`.** `make check` proves the extension still compiles and that the token map still covers the kernel. It cannot prove the graph draws. The verification for this bump is a human looking at a real graph in an Extension Host — Step 6 is not optional here.

## Step 1 — Establish the three versions, and which side of the local switch you are on

```bash
grep -n '"@pipelex/mthds-ui"' editors/vscode/package.json                      # the declared SPEC
grep -A2 '"@pipelex/mthds-ui@' editors/vscode/yarn.lock | head                 # what is LOCKED
node -p "require('./editors/vscode/node_modules/@pipelex/mthds-ui/package.json').version"  # INSTALLED
npm view @pipelex/mthds-ui version                                             # latest PUBLISHED
```

**Read the lockfile, not just `package.json`.** The declared spec here is a `npm:` *range*, and it has at times been `npm:latest` — which records no intent at all. When the spec is `latest`, `package.json` tells you nothing and `yarn.lock` is the only statement of which version this repo is actually on. Report all four numbers.

**If the spec is `portal:` or `file:`, someone is mid-`make use-local`.** That is a supported workflow — `make use-local` (`make ul`) portal-links `../mthds-ui` so renderer changes can be tried here before they are released — but it must never merge, and three guards say so:

- `make check-no-local-deps`, a prerequisite of `make check`, runs `scripts/check-mthds-ui-spec.sh`, which admits a spec starting with `npm:` or a `github:<owner>/<repo>#<40-hex sha>` sprint pin and refuses everything else.
- `.githooks/pre-commit` runs the same script and refuses the commit (active once `make setup-hooks` has run, which `use-local` does for you).
- `check.yml` greps `package.json` for `"file:` before it installs — a wider net for any local dep, though it is `check-no-local-deps` inside `make check` that actually catches a `portal:` mthds-ui.

So when you arrive on a portal link, the job is exactly this skill: the released version exists now, and the pin has to be set. Do not hand-edit the spec back — `make use-npm VERSION=…` in Step 4 is what writes both `package.json` and the lockfile consistently.

**If the spec is `github:Pipelex/mthds-ui#<sha>`, the branch is on a sprint pin**, written by the workspace's `wt pin` so this repo can build against an unreleased `mthds-ui` commit. It is not this skill's to undo: the workspace's `wt unpin <worktree> mthds-ui --to X.Y.Z` collapses it onto the release, putting back the `npm:` spelling and regenerating `yarn.lock` in one commit, and it has to happen before that branch merges. A `github:` source naming a branch, a tag or an abbreviated SHA is refused by both guards, because it moves under the lockfile.

If the user named a target, confirm it exists: `npm view @pipelex/mthds-ui@X.Y.Z version`. **This skill only moves to published versions.** If the renderer fix they want is not released, say so and stop — the fix is to cut the release in `../mthds-ui` first, and `make use-local` is the bridge until then, not a thing to commit.

Confirm the target when there is a real choice — several versions available, or a jump of more than one minor. Multi-minor jumps happen here (`0.17.0` → `0.23.0` in one commit), which is exactly why Step 2 reads every entry rather than the newest.

Note a dirty tree without treating it as a blocker; the commit at the end stages named files only.

## Step 2 — Read the changelog for every version crossed

Not just the newest entry: an intermediate minor's break is still your break, and this library's history proves it — the `StuffViewer` deletion that broke the build sat two minors below the version being adopted. The published tarball ships `dist/` only, so the changelog is not in `node_modules`. Read it from the sibling checkout, from `origin` rather than a local branch that may be stale:

```bash
git -C ../mthds-ui fetch origin --quiet
git -C ../mthds-ui show origin/main:CHANGELOG.md | sed -n '/## \[vTARGET\]/,/## \[vCURRENT\]/p'
```

Substitute the real numbers — the file is newest-first, so the target heading comes before the current one. If the sibling is not checked out, fall back to GitHub: `gh api repos/Pipelex/mthds-ui/contents/CHANGELOG.md --jq '.content' | base64 -d`.

**Do not grep for `**BREAKING:**` and stop.** This changelog marks some breaks that way and buries others in prose inside `### Changed`, and the ones that hurt this consumer most were never marked at all: a deleted component takes its stylesheet with it, and a panel that starts requiring two new props degrades in silence rather than failing.

Sort what you read into four buckets, because they take different work and fail in different places:

- **Host-side API** — anything exported from `./static-graph`. `yarn typecheck` finds these, and they are the friendly bucket.
- **Webview API** — `GraphViewer` props and the types at the package root. Also caught by typecheck, *if* the extension names the type. A prop whose **default** moved is not caught by anything.
- **Shipped file layout** — a stylesheet renamed, added or deleted under `dist/`, or a reshaped `exports` map. Fails loudly in `formKernelTokens.test.ts` or the typecheck gate; see the table.
- **Rendering or requirement changes at an unchanged type** — a panel that now needs a prop it used to infer, a card that folds by default, a number formatted differently. **Invisible to every check in this repo.** The `0.20.0` data-viewer change is the archetype: correct types, green build, and every data node quietly showing a structure table instead of a value. Every item in this bucket becomes a line on the Step 6 checklist.

### The seams, and what a library change does to each

| Seam | Where it lives | What to check |
| --- | --- | --- |
| **The static-graph builder** | `src/pipelex/graph/methodGraphPanel.ts` imports `buildStaticGraphSpecFromToml`, `parsePipeRef`, `staticDiagnosticsToValidationIssues` from `@pipelex/mthds-ui/static-graph`; `src/pipelex/graph/validationStatus.ts` imports `makePipeRef` / `parsePipeRef` | This is the only mthds-ui code that runs in the **extension host**, and it is what produces the graph at all. A signature change fails typecheck. A change to what the builder *accepts* does not: a language form the builder cannot parse makes pipes and their edges vanish from the graph with no error — that is what the expanded input-slot form did before mthds-ui #79. The builder is documented never-throwing on content; the panel wraps it anyway and `methodGraphPanel.test.ts` injects a throw through a pass-through `vi.mock` to prove the catch. **Never re-pin that test to a real upstream bug** — it was written that way once and went red when mthds-ui fixed the bug. |
| **The `GraphViewer` props** | `src/pipelex/graph/webview/adapter.ts`, mounting `GraphViewer` from `@pipelex/mthds-ui/graph/react` | Renames break the build loudly, which is the good case. Two silent shapes to hunt for instead: a prop whose **default** moved (the adapter passes `theme`, `systemTheme`, `validationState`, `validationIssues`, `contracts`, `outputForm`, `inputForm` explicitly — anything it leaves unset inherits whatever the release decided), and a panel that starts **requiring** a prop the host does not pass, which degrades to a floor rather than failing. |
| **The data viewer's artifacts** | `contracts` / `outputForm` / `inputForm` on `setData`, read by the panel from beside a run's `graphspec.json` (`pipe_io_contracts.json`, `output_form.json`, `input_form.json`) | Since `0.20.0` the panel renders a value only when it receives **both** `contracts` and `outputForm`; half a pair is indistinguishable from none. If a release moves that contract again — a third view, a re-keying, a rename — the symptom is a data tab that stops appearing, with everything green. `docs/features/method-graph.md` records the current shape; check `Pipelex: Show Run Graph` in Step 6 whenever this seam moves. |
| **The validation widget** | `ValidationState` / `ValidationIssue` at the package root; `validationStatus.ts` keeps a local mirror (`GraphValidationIssue`) that must stay structurally assignable | The extension fills each issue's target and mthds-ui renders the ring, badge and roll-up. Targeting is **domain-qualified** (`domain_code.pipe_code`) through `makePipeRef` / `parsePipeRef`. A change to the ref grammar or the issue shape lands here first; a change to *how* a target is rendered lands only in Step 6. |
| **The shipped stylesheets** | `src/pipelex/__tests__/formKernelTokens.test.ts` reads `dist/graph/react/graph-core.css`, `dist/graph/react/detail/DetailPanel.css`, `dist/graph/react/viewer/GraphToolbar.css` by literal path | A sheet renamed or deleted upstream fails this test with an `ENOENT` naming the file — loud, and that is the design. Fix the path; do not delete the entry to go green, because the list is what tells the token check which tokens the bundle already supplies. A sheet **added** upstream is silent here: it arrives in the bundle through the import graph automatically, which is the whole point of the esbuild arrangement, but its tokens are not accounted for until someone adds it to the list. |
| **The form kernel, arriving transitively** | `@pipelex/mthds-form` is a real dependency of mthds-ui and is **not** declared in this repo; its `dist/styles.css` is read by the same test, and `src/pipelex/graph/webview/shell.css` supplies the tokens it reads | A kernel bump rides in on every mthds-ui bump. The test derives the requirement from the kernel's shipped bytes — every `var(--x)` used with no fallback, minus what the bundle already defines — so a kernel that reaches for a new token fails here and names it. **That failure is the feature.** The fix is to add the token to `shell.css`'s `.react-flow-container` block, mapped from the graph palette (never from a `--vscode-*` colour, never on `:root`), which the test's other two cases enforce. Weakening any of the three is how the detail panel ends up painting transparent in production with a green build. |
| **The subpath `exports` map** | `editors/vscode/tsconfig.typecheck.json` sets `moduleResolution: bundler` specifically to follow it; esbuild follows it natively | The extension consumes four entry points — `.` (types), `./static-graph` (host), `./graph/react` (webview), `./form` (type-only). A reshaped `exports` map or `dist/` layout surfaces as a resolution error in `yarn typecheck` and in the esbuild webview build. Do not "fix" it by deep-importing a `dist/` path in source; that is what the test file does under protest, and only because a test can. |
| **The webview CSS bundle** | `editors/vscode/scripts/build.mjs` — esbuild emits `graph.css` beside `graph.js` from the same import graph, with every `@import` resolved | Nothing is hand-copied any more, so a sheet added upstream arrives for free. The one silent failure left — esbuild emitting no stylesheet at all — is asserted: the build throws if `graph.css` is absent. If that throw fires after a bump, mthds-ui has stopped importing its own sheets from `graph/react` and this is a question for the sibling repo, not a thing to work around here. |
| **The library's own dependencies** | `@xyflow/react`, `elkjs`, `smol-toml` — real deps, all bundled into the webview IIFE | They arrive with the bump and this repo declares none of them. The consequence here is **bundle size**, which is why `build.mjs` minifies: elkjs ships pre-minified GWT output that esbuild otherwise re-prints at more than twice the size. A major move in one of these is worth measuring the emitted `graph.js` before and after. |
| **The peer dependencies** | `react`, `react-dom` (`^19`), declared by this extension and aliased in `build.mjs` to a single resolved copy | The alias exists so a portal-linked sibling cannot drag in its own `node_modules/react` and produce the dual-React hooks crash. If a release moves the peer range, read the `yarn install` output rather than scrolling past it, and never silence an unmet-peer warning without saying why it stands. |
| **The palette rule** | `CLAUDE.md`, "Theming (light/dark)" | `GraphViewer` owns the palette and applies it inline on `.react-flow-container`. **The host must never send `config.paletteColors`** — it merges over the theme palette and silently kills the light/dark toggle. If a release adds a tempting new colour knob, this rule still holds. |

## Step 3 — Map it onto real call sites before editing

```bash
grep -rn "@pipelex/mthds-ui" editors/vscode/src editors/vscode/scripts editors/vscode/tsconfig.typecheck.json
grep -rn "<the changed symbol>" editors/vscode/src docs/ CLAUDE.md
```

Two places to leave alone when a rename sweeps the repo: **`CHANGELOG.md`'s released entries**, which are a historical record, and **`TODOS.md`**, a branch note describing what was true when it was written. A sentence like "the rendering lives in `@pipelex/mthds-ui` 0.14.0" is a fact about the past and stays true.

Then present the plan — target version, the seams each changelog bullet lands on, which checks you expect to go red, and every item in the rendering bucket you cannot prove is safe. Those become the Step 6 checklist, not a guess. If the migration looks large or ambiguous, agree scope now rather than after half the call sites have moved.

## Step 4 — Pin the version

```bash
make use-npm VERSION=X.Y.Z
```

**Always name `VERSION`.** Bare `make use-npm` installs `latest` and writes the literal spec `npm:latest`, which passes every guard and records nothing: six months later the only statement of which version this repo builds against is a line in `yarn.lock`, and a fresh resolution can move it without a diff anyone reads. Every deliberate bump in this repo's history named its version, and the changelog entries are written as though it did.

The target runs `yarn add` inside `editors/vscode`, so it writes `package.json` and `editors/vscode/yarn.lock` together. Then confirm what actually landed:

```bash
grep -n '"@pipelex/mthds-ui"' editors/vscode/package.json                                   # expect "npm:X.Y.Z"
node -p "require('./editors/vscode/node_modules/@pipelex/mthds-ui/package.json').version"
node -p "JSON.stringify(require('./editors/vscode/node_modules/@pipelex/mthds-ui/package.json').peerDependencies)"
node -p "require('./editors/vscode/node_modules/@pipelex/mthds-form/package.json').version"  # the kernel that rode along
ls editors/vscode/node_modules/@pipelex/mthds-ui/dist/graph/react/                           # the layout the test's paths assume
git status --short                                                                            # expect package.json + yarn.lock
```

The lockfile is not optional: both required PR gates run `cd editors/vscode && yarn install --immutable`, which fails on any lockfile the manifest does not already agree with.

## Step 5 — Build and run the checks, knowing what they can and cannot prove

```bash
make ext                                   # WASM bundle + rollup + the esbuild webview bundle
make check                                 # check-no-local-deps, fmt, clippy, every suite, WASM compile
```

`make check` is the CI gate, so a green run here means a green run there. Reach for `make test-ext` (`yarn typecheck` + vitest) when iterating on a type error and you do not want to wait for the Rust half.

What each part actually proves for this bump:

- **`yarn typecheck`** — the extension still compiles against the library's `.d.ts`, and the four subpath entry points still resolve. This is the real gate for a rename.
- **`formKernelTokens.test.ts`** — the `dist/` stylesheets still exist at the paths the test names, and `shell.css` still defines every token the form kernel reads without a fallback. This is the real gate for a kernel bump riding along.
- **`make ext`'s CSS assertion** — mthds-ui still imports its own stylesheets, so the webview will be styled.
- **`methodGraphPanel.test.ts`** — the panel's own lifecycle, against a real builder for every case but the injected-throw one.

**Nothing above renders a `GraphViewer`, mounts the detail panel, or draws a node.** Say that plainly rather than reporting a green run as a verified bump.

Per the workspace principle, a pre-existing bug this bump reveals gets fixed, and the changelog says the bump revealed it rather than caused it.

## Step 6 — Look at a real graph. This is the verification

```bash
make ext-install     # builds, packages the .vsix, installs it into Cursor or VS Code
```

Then **reload the window** — an already-running Extension Host keeps the code it loaded at activation, so a bump checked without a reload is a bump checked against the old library.

Open a `.mthds` bundle and run **`Pipelex: Show Method Graph`**. Check, in both a light and a dark editor theme:

- **The graph draws at all**, and every pipe you expect is present. A pipe missing along with its edges is the static builder failing to parse an authored form, not a layout quirk.
- **The in-graph theme toggle still flips both the graph and the detail panel.** The panel following the toggle is what the `shell.css` token map buys; a panel stuck on one theme means the tokens have been hoisted or re-pointed.
- **The detail panel**, clicking a pipe node and a data node: controls rendered, readable, not transparent. Transparent controls are the undefined-token failure the token test exists to prevent — if you see them and the test was green, the test's supplied-token list has gone stale.
- **The validation widget** on a bundle with a real error: the dropdown lists the issue, the ring and count badge land on the right node, clicking the badge opens the dropdown, clicking a row jumps to source and pans the node.
- **Folding**, if any fold or roll-up bullet was in the changelog: a folded controller's badge must aggregate its hidden descendants.

Then run **`Pipelex: Show Run Graph`** on a run directory that has `graphspec.json` **and** its `pipe_io_contracts.json` / `output_form.json` beside it — written by `pipelex` v0.57.0 and later. Click a data node and confirm the data tab still shows the value. This is the only surface that exercises the `contracts` / `outputForm` seam, and it is the one that regressed silently at `0.20.0`.

If the changelog only touched an entry point this extension does not consume, say so and skip what genuinely does not apply — but name the checks you skipped and why, rather than quietly narrowing the pass.

## Step 7 — Docs

The bump is not done until the docs that describe the library contract agree with reality:

```bash
grep -rln "mthds-ui" docs/ CLAUDE.md
```

`docs/features/method-graph.md` is the main one: it records the static-first flow, the two artifacts the data viewer needs, the token map and why it lives on `.react-flow-container`, and the `graph.js` / `graph.css` build table. `docs/features/graph-pipe-navigation.md` describes the `pipeCode` message contract and names `onNodeSelect` as the upgrade path — a release that changes either belongs there. `docs/features/syntax-color-palette.md` points at mthds-ui's shiki themes as the source the editor's TextMate hues mirror. `CLAUDE.md`'s "Graph Rendering (ReactFlow)" section states the palette and theme rules; if a release changes what `GraphViewer` owns, that section moves in the same commit. A doc describing the previous library is worse than no doc.

## Step 8 — Changelog and commit

Add the entry to the **root `CHANGELOG.md`** under `## [Unreleased]`. `editors/vscode/CHANGELOG.md` is generated from it — never edit that file; run `./scripts/compose-docs.sh` if it needs regenerating.

Write it in the voice of the existing entries: what the library changed, **what it meant here**, and what a user would have seen. The `0.20.0` entry is the model — it names the deleted component, the build failure the deletion caused, the props that went with it, the data-viewer floor a reader actually saw, and the test that had to stop being pinned to an upstream bug. A change that was invisible-but-consequential is exactly the entry someone will be grateful for six months out. Per the workspace rule, write "breaking", never "pre-1.0 breaking", and never hardcode counts.

Whether the extension's own version needs bumping is the `/release` skill's call, not this one — a dependency bump normally rides in an unreleased section and ships with the next release.

Then summarize for the user: the version move, every file touched, which peer warnings appeared and what you did about them, **which graphs you actually opened and in which themes**, and any unresolved item. On confirmation, stage only the files this bump touched — never `git add .` — and commit. Offer pushing and opening a PR against `dev`, and wait for explicit approval.

## Rules

- Set the version with `make use-npm VERSION=X.Y.Z`; never hand-edit the spec, and never leave it at `npm:latest`.
- Never commit a `portal:` or `file:` spec — `make check`, the pre-commit hook and CI each refuse it, and the fix is to pin the released version, not to bypass a guard.
- Never point the spec at an unpublished version; cut the release in `../mthds-ui` first.
- Commit `editors/vscode/yarn.lock` with `package.json` — both PR gates install with `--immutable`.
- Never report a green `make check` as a verified bump: no suite here renders a graph.
- When `formKernelTokens.test.ts` fails, fix the path or add the token to `shell.css`; never delete an entry or weaken an assertion to go green.
- Never send `config.paletteColors` from the host, whatever a release adds.
- Never re-pin the injected-throw test in `methodGraphPanel.test.ts` to a real upstream bug.
- Reload the Extension Host window before believing anything you see in it.
- Edit the root `CHANGELOG.md`, never the generated `editors/vscode/CHANGELOG.md`.
- Never use `git add .` or `git add -A`; never push or open a PR without explicit approval.
- If a step fails or the user wants to abort, stop immediately rather than continuing the workflow.
