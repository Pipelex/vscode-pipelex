# Brief: domain-qualified pipe refs (`pipeRef`) through the validation-targeting chain

**Goal.** Validation-issue targeting (node decorations, locator chips, click-to-navigate) must identify pipes the way the Pipelex runtime does: by **pipe ref** — `domain_code.pipe_code` — never by bare `pipe_code`. Today the domain is dropped in the presentation chain, so in a bundle where two domains declare the same pipe code, one issue rings every same-code node and a click can open the wrong declaration. This brief is the cold-start guide to fix it rigorously across `mthds-ui` and the VS Code extension. No pipelex wire change is needed (verify step aside): the validator already sends `domain_code`.

**Principle (user-stated).** We did the work to make this correct in Pipelex; the satellite repos must match that rigor. The canonical solution is the pipe ref, with domain inference following the obvious rules when a ref is bare.

## The canon in pipelex (read these first)

- `pipelex/pipelex/core/qualified_ref.py` — `QualifiedRef`: `domain_path` (nullable, may be multi-segment) + `local_code`; `parse` splits on the **last dot**; `parse_pipe_ref` validates snake_case on both sides; `full_ref` renders `domain.code`; `is_local_to`/`is_external_to`; cross-package refs use an `alias->domain.pipe_code` prefix (`has_cross_package_prefix` / `split_cross_package_ref`).
- `pipelex/pipelex/core/pipes/pipe_abstract.py:99` — `pipe_ref` property = `f"{domain_code}.{code}"`; `pipe_factory.py:43` `make_pipe_ref_with_domain`.
- Inference rule: `pipelex/pipelex/libraries/crate_normalization.py:269` `_qualify_pipe_ref` — already-qualified → keep; special outcomes → keep; bare → qualify with the **declaring domain**. That is "the obvious rules": a bare ref belongs to the domain of the file/namespace that utters it.
- GraphSpec is already ref-based: node ids are qualified paths (`demo.main_flow/step_2`), `pipe_registry` keys are `domain.code`. Execution has no ambiguity — this is purely a presentation-chain fix.

## Where the domain is dropped today (receipts)

Validator → extension wire is fine: `editors/vscode/src/pipelex/validation/types.ts:20-22` (`ValidationErrorItem` has both `pipe_code` and `domain_code`; populated by `pipelex/pipelex/pipeline/validation_errors.py` on the blueprint/factory/pipe paths). Then:

1. **Extension mapper** — `editors/vscode/src/pipelex/graph/validationStatus.ts`: `validationErrorsToIssues` copies only `pipe_code` into `issue.pipeCode`; `errorContext` renders a bare `pipe.<code>` chip. `domain_code` is never read.
2. **Extension static-issue navigation** — `parseStaticIssueContext` (same file) parses a bare `pipe.<code>` context; `methodGraphPanel.resolveStaticIssueTargets` scans **all** bundle files for a `[pipe.<code>]` header, first match wins → wrong-file navigation when domains collide. Same weakness in `crossFileDiagnostics.resolveErrorLocations`' declaration-scan fallback tier (its first tier, the error's `source` path, is file-precise when present).
3. **mthds-ui `ValidationIssue`** — `src/graph/types.ts:611-633` has `pipeCode?: string` and no domain field: nowhere to carry the domain even if the host sent it.
4. **mthds-ui matcher** — `src/graph/graphValidation.ts` `issueTargetIds`: `nodes.filter(n => n.pipe_code === issue.pipeCode)` — ignores `n.domain_code` sitting right next to it.
5. **mthds-ui static mapper** — `src/static-graph/validationIssues.ts` `targetFromPath`: a declaration path `pipe.<code>` yields a bare `pipeCode`. Root cause: `Diagnostic` (`src/static-graph/types.ts:38-44`) is a per-file TOML locator with **no domain/file identity**, so the mapper cannot qualify. Note the static walk itself is already rigorous — `buildStaticGraphSpec.ts` `resolvePipe` handles bare refs in the current domain, `domain.code`, and opaque `alias->…`; the cycle guard and registry are keyed by qualified refs. Only the diagnostic→issue bridge loses the domain.

`nodeId` targeting is already precise (node ids embed the domain) — don't touch it. Also note the model to imitate inside the extension: `navigateToPipe` already carries `domainCode` and resolves through the registry's `source`.

## Design

### mthds-ui (do first — the extension consumes the released package)

- **`ValidationIssue`: replace `pipeCode` with `pipeRef`** (`domain_code.pipe_code`, fully qualified). Breaking — fine, we don't do backward compatibility; note it in the changelog. Keep `nodeId` and its precedence.
- **Matcher** (`graphValidation.ts`): match `issue.pipeRef === \`${n.domain_code}.${n.pipe_code}\``. No bare-match fallback: an emitter that can't qualify must leave the issue untargeted (panel-only) rather than decorate by guess — same stance as the existing "targets that don't resolve produce no decoration".
- **`Diagnostic`**: add the declaring-file identity the mapper needs — a `domain_code` field stamped by the builder (it knows each file's `domain` while parsing; additive change). Keep `path` as the TOML-shaped locator (it must keep matching the file's actual `[pipe.<code>]` header text — the extension greps for it).
- **Static mapper** (`validationIssues.ts`): a declaration path `pipe.<code>` + the diagnostic's `domain_code` → `pipeRef: \`${domain_code}.${code}\``. A diagnostic without `domain_code` stays panel-only.
- **Shared ref helper**: export a small `parsePipeRef` / `makePipeRef` from mthds-ui (last-dot split, mirroring `QualifiedRef.parse` semantics incl. rejecting empty/consecutive-dot forms; treat `alias->` cross-package refs as opaque/untargetable for now). The extension must consume this helper, not re-implement.
- Update `docs/validation-widget.md`, unit tests (two domains, same pipe code: only the right domain's nodes decorate; fold roll-up lands on the right controller), Storybook play test if one exercises decorations. Release a new version.

### VS Code extension (after the mthds-ui pin bump)

- **`validationErrorsToIssues`**: build `pipeRef` from the error's `domain_code` + `pipe_code` when both are present. When only `pipe_code` arrives (the wire fields are nullable), apply the obvious inference: look the bare code up in the static graphspec's `pipe_registry` keys — exactly one key ending in `.${pipe_code}` → use it; zero or several → leave untargeted. Never guess among several.
- **Chip policy** (`errorContext`): decide whether the chip shows `pipe.<code>` (local) vs the qualified form when the issue's domain differs from the shown file's domain — mirror the owning-file-label policy (label only when it's not the obvious place). Open decision, see below.
- **Static-issue targets** (`parseStaticIssueContext` + `resolveStaticIssueTargets`): with the diagnostic's `domain_code` now available, resolve the declaring **file** first (the bundle file whose `domain =` matches), then scan only that file for the `[pipe.<code>]` header. Same constraint added to `crossFileDiagnostics.resolveErrorLocations`' declaration-scan fallback when the error carries `domain_code`.
- **Issue navigation** aligns with `navigateToPipe`'s existing domain-aware path where possible (registry `source` first, then the domain-constrained scan).
- Tests: a two-file, two-domain fixture with a colliding pipe code (extension vitest — panel decorations target only the right node; `navigateToError` opens the right file; the inference cases: unique-match qualifies, collision stays untargeted). Update `docs/features/method-graph.md`, `CLAUDE.md` graph section, root `CHANGELOG.md` (then `./scripts/compose-docs.sh`).

### Verify upstream (small, do during phase 1)

Audit `pipelex/pipelex/pipeline/validation_errors.py`: every error variant that sets `pipe_code` should also set `domain_code`. If a variant can't, that's a pipelex fix (separate small PR there) — the extension-side inference is the safety net, not the design.

## Out of scope

- Cross-package (`alias->…`) targeting: opaque in the static walk today; issues about them stay panel-only.
- Errors with **no** `pipe_code` at all (message-prose inference was reviewed and rejected — wrong-node risk): see "Validator errors without `pipe_code` never decorate a node" in `wip/graph-validation-followups.md`; the fix is broader structured attribution upstream.
- Concept-targeted decorations (v2 candidate, unchanged).

## Open decisions (settle at implementation time)

1. Chip rendering for cross-domain issues (bare vs qualified `pipe.` chip) — recommend qualified only when the domain differs from the shown file's, mirroring the owning-file label.
2. Whether `ValidationIssue.pipeRef` should also carry through to the badge→panel navigation payload (`navigateToError` is index-based today and can stay index-based — the targets array just becomes domain-precise).

## Checkpoints

- [ ] **Checkpoint 1 — mthds-ui released.** `pipeRef` in `ValidationIssue` + matcher, `Diagnostic.domain_code`, static mapper qualification, `parsePipeRef` helper exported, tests + docs + changelog, version released. Record the version here and hand off.
- [ ] **Checkpoint 2 — extension switched.** Pin bumped; mapper/inference, domain-constrained static targets and declaration scans, chip policy decided and implemented, fixture + tests green (`make check`), docs + changelog updated. Record decisions taken here.
- [ ] **Checkpoint 3 — upstream audit.** `validation_errors.py` coverage confirmed (or pipelex PR opened). Close out by updating the "Multi-domain bundles" item in `wip/graph-validation-followups.md` to point at the shipped fix.
