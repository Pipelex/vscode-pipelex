# Handoff: `/v1/version` cannot carry runner feature detection

**Audience.** Whoever owns `pipelex-server/platform`. Written from `vscode-pipelex` after a false-alarm warning in the VS Code extension; the fix is split across both repos and the decision on the platform half is yours.

**One-line summary.** The extension gates a runner capability on `implementation_version` from `GET /v1/version`. That field reports `pipelex-platform`'s own package version, which says nothing about the runner behind platform's internal proxy — so the gate compares two unrelated version lines and fires against a perfectly current api-dev.

## The symptom

Opening a method view against `pipelex.api.baseUrl = https://api-dev.pipelex.com` raises:

> The Pipelex API at https://api-dev.pipelex.com is 0.3.1, but the extension expects ≥ 0.4.0 for structured validation diagnostics. Upgrade the pipelex-api server (or its pipelex pin).

Nothing on api-dev is out of date. The advice in that message is wrong and, if followed, sends someone chasing a non-existent deployment problem.

## What api-dev returns

```
GET https://api-dev.pipelex.com/v1/version
{"protocol_version":"0.1.0","implementation":"pipelex-hosted",
 "implementation_version":"0.3.1","runtime_version":null,
 "extensions":["runs","method_id"]}
```

## The version lines being conflated

- `pipelex-platform` — **0.3.1** as deployed on dev. Serves `/v1/version`; the number in the response is this one (`platform/src/pipelex_platform/routers/v1/version.py:47-52`, `package_version("pipelex-platform")`).
- `pipelex-api-hosted` — 0.3.1. The runner image composition (`api-hosted/pyproject.toml:30`). Coincidentally the same number, which makes this even easier to misread.
- `pipelex-api` — **0.12.0**, pinned at `api-hosted/pyproject.toml` (`pipelex-api==0.12.0`). This is the package that actually implements structured validation diagnostics.

The extension's floor is `MIN_API_IMPLEMENTATION_VERSION = [0, 4, 0]` (`editors/vscode/src/pipelex/validation/apiVersionGate.ts:10`), and its comment is honest about where the number came from: *"Mirrors the Phase 2 pipelex-api version."* That is correct — structured `validation_errors[]` with `source` landed in **pipelex-api 0.4.0** (its CHANGELOG, 2026-06-17, "MTHDS Protocol surface alignment (Phase 2)"). But the value it compares against is platform's. `0.3.1` on platform's line versus `0.4.0` on pipelex-api's line is apples to oranges, and the runner is in fact eight minors past the floor.

## Why this is structural, not a stale number

All of `/v1` goes to platform. `apigateway_http.tf:562-568` declares `ANY /v1/{proxy+}` targeting the platform ALB, and the comment above it (`:553-558`) states the design plainly: one public service per hostname, platform serves the protocol routes and proxies the tooling routes to the runner over the internal ALB. Only `/v1/upload` and `/v1/resolve-storage-url` are runner-bound exceptions (`:404-413`). `GET /v1/version` additionally gets its own integration so it can skip the authorizer (`:628-648`) — a public handshake, per spec.

So `/v1/version` is a static handler describing the front door, while `/v1/validate` is proxied through to a runner whose version the handshake never mentions. Platform's own route docstring already says it can't do better without paying for it: *"`runtime_version` is None: the platform fronts the runner over the internal ALB and reporting the runner's pipelex version would require an internal call per request — deferred (plan 06-T5 explicitly allows it)."*

That deferral is defensible. The consequence is what needs a decision: **as it stands, no client can feature-detect a runner capability from `/v1/version`.**

## The spec already anticipated this

`docs/specs/pipelex-mthds-protocol.md:404`:

> `version` reports `protocol_version` sourced from the SDK's `PROTOCOL_VERSION` constant (single source of truth — runners do not override it), plus implementation identification: local says `implementation: "pipelex"`, hosted says `"pipelex-api"` with its own `implementation_version` and the underlying `runtime_version`. Genuinely different implementations are protocol-legal; clients must key feature detection on `protocol_version`.

The extension violates that outright: it reads only `implementation_version`, never `protocol_version` and never `implementation`. That is the extension's bug to fix and we own it.

Two spec-vs-reality gaps are yours, though:

- The spec says hosted answers `implementation: "pipelex-api"`. The deployed monorepo answers `"pipelex-hosted"` (`platform/.../v1/version.py:33`). A third implementation identity is protocol-legal, but the spec text names only two and should name this one.
- `extensions: ["runs","method_id"]` is the hosted feature-detection hint and is documented in the route's own docstring, but it is not in `docs/specs/pipelex-mthds-protocol.md`. A client is being told to key off `protocol_version` while the field that actually distinguishes hosted capabilities is undocumented at spec level.

## What we're fixing on the extension side

Ours, no platform action needed. Either scope the floor to the implementation it was derived from —

```ts
if (info.implementation === 'pipelex-api' && parsed && compareSemver(...) < 0)
```

— or, preferably and per spec, drop the `implementation_version` comparison and key on `protocol_version` plus `extensions`. Worth noting the gate already has a lenient policy (`parseCleanRelease` returns `null` for prerelease/dev/unparseable versions, which are then treated as capable rather than risk a false failure); a clean release from a *different implementation* falls straight through that leniency into a hard warning. Extending the leniency to unknown implementations is the minimal correct patch.

## The decision that's yours

Pick how a client is supposed to feature-detect a runner capability through platform:

1. **Declare it out of scope for `/v1/version`, and say so in the spec.** Clients key on `protocol_version` + `extensions` only; runner versions are never observable from the front door. Cheapest, consistent with the 06-T5 deferral, and enough for our fix.
2. **Surface the runner's identity on the handshake.** Add `runtime_version` and/or the runner's `implementation_version`, cached rather than fetched per request, so the per-request cost the docstring rejects is not incurred. More useful to every SDK, more work.
3. **Grow `extensions` into the real capability vocabulary** (e.g. a `structured_validation` token), so clients name the capability rather than infer it from a number. Most robust; needs a spec change and SDK agreement.

Our fix works under all three, so we are not blocked — this is about whether the next client to try this walks into the same trap.

## Loose ends

- **Deployed platform version doesn't match any local ref.** api-dev reports `0.3.1`; `platform/pyproject.toml` reads `0.2.8` on `fix/E2E-follow-ups` and `0.2.6` on `origin/main`. My clone is on a feature branch and may simply be behind whatever dev builds from, but it's worth a glance that dev isn't running something unexpected. Does not affect anything above — the number is platform's line either way.
- **Workspace `CLAUDE.md` is drifted on routing.** It says execution routes (`validate`, `execute`, `start`, `models`, `version`, `build/*`) go to the api-hosted runner. Terraform sends all of them to platform, which proxies. That doc misled this investigation for a while; worth correcting at workspace root.
- **`conformance` covers the bare runner's handshake only.** `docs/specs/pipelex-mthds-protocol.md:406` verifies `implementation: "pipelex-api"` against a subprocess-booted `pipelex-api`. Nothing exercises the hosted handshake, which is exactly the shape that broke a client. A conformance arm asserting the hosted response (including `extensions`) would have caught the spec-vs-reality gap.

## Receipts

- `platform/src/pipelex_platform/routers/v1/version.py` — the handler; `:33` implementation name, `:47-52` version source, module docstring on the `runtime_version` deferral
- `infra/api/apigateway_http.tf:553-568` — `/v1` greedy route to platform; `:404-413` runner exceptions; `:628-648` the public `/v1/version` integration
- `api-hosted/pyproject.toml:30` version, and the `pipelex-api==0.12.0` pin below it
- `pipelex-api/api/routes/version.py:21,45-51` — what a bare runner answers, for contrast
- `pipelex-api/CHANGELOG.md` v0.4.0 — the capability the floor was named after
- `vscode-pipelex/editors/vscode/src/pipelex/validation/apiVersionGate.ts:10,124-133,164-175` — the floor, the comparison, the message
