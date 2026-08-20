# What the vendored corpus is checked for here, and what it still isn't

Recorded 2026-08-20 from the code review of the corpus vendoring change on `feature/MthdsTestCorpus`, and revised twice in that review: first once the cost of the missing check turned out to be much lower than first assessed, then again once the prescribed fix for the *next* corpus sync was measured and found to be wrong. What is left is the half that genuinely remains, plus the measurement that rules out the obvious way to close it.

## What parity proves, and what it does not

`crates/pipelex-cli/tests/parity.rs` formats and lints every fixture through the in-process `pipelex_tools` library and through the shipped `plxt` binary, and requires the two to agree. Both sides are **the same Rust engine**, in two embeddings. So parity proves the library and the binary do not drift — a real property, now checked over a much larger and independently-owned body of MTHDS than this repo authors — but it says nothing about whether the engine's verdict is *correct*.

That was measured, not assumed. Two identical **non-empty** diagnostic sets satisfy the equality assertion exactly as well as two empty ones, so parity stays green over content the toolchain rejects, provided it rejects it the same way twice. `test-data/mthds/` demonstrates it in the repository as it stands: most of those fixtures are curated bad MTHDS that `plxt lint` rejects, and parity is green over all of them. A raw TOML syntax error is weaker still — `format_matches_cli_on_every_fixture` hits its `continue` and asserts nothing at all for that fixture.

## The half that is now covered

`crates/pipelex-cli/tests/corpus.rs` requires every `.mthds` file under `test-data/mthds-corpus/` to lint clean through the embedded MTHDS schema. That closes the failure the vendoring exists to catch: `pipelex` adds a pipe kind or a field, the `mthds.schema.json` vendored here goes stale, the re-sync lands, and CI here stays green while the toolchain has silently stopped accepting the canonical corpus. It now goes red in the commit that syncs it.

The sweep is deliberately scoped to the corpus tree alone, because `test-data/mthds/` holds negative fixtures whose purpose is to be rejected. It guards against discovering nothing, so a moved or emptied corpus fails rather than passing vacuously, and a companion test requires every directory carrying an `entry.toml` to carry at least one `.mthds`, so a partial sync fails too. Every entry vendored today is structurally clean, so the sweep asserts cleanliness unconditionally. The next section explains why the obvious way to preserve that — branching on each entry's `validity` — is the wrong fix, and was recorded here only after being measured.

## Why `validity` is the wrong axis for the corpus sweep — measured, 2026-08-20

The natural-looking fix, once the corpus grows curated invalid entries, is to have the sweep read each entry's `entry.toml` and branch on `validity`. It was written into this note and into `corpus.rs` as the prescription before it was checked. It is wrong, and the two prescriptions have been corrected.

`validity` is a **semantic** declaration: it says what the `pipelex` runtime makes of the bundle when it loads and dry-runs it. `plxt lint` is **structural**: TOML syntax, then DOM validation, then JSON Schema, with references never resolved. The two axes cross rather than nest, so neither branch of the obvious fix survives contact:

- **"invalid ⇒ require a diagnostic"** goes red on the great majority of the invalid entries queued upstream, because their faults are semantic — unresolved concepts, missing or extraneous input variables, unguarded optionals — and are invisible to a structural check. That is the same shallowness this note already establishes in the section below.
- **"invalid ⇒ skip"** throws away the handful whose declared fault *is* structural, and those are the corpus's only probes for staleness in the **permissive** direction: a vendored `mthds.schema.json` that quietly stopped rejecting an unknown pipe type, or stopped rejecting a key the schema does not allow. Nothing else in this repo covers that direction, since every other corpus entry is expected to pass.

Measured on 2026-08-20 with this repo's `plxt` against every `invalid_*` entry on `pipelex` commit `3361711a7`: all but two lint clean, and the two that do not are `invalid_unknown_pipe_type` (`"PipeWondrous" is not one of [...]`, at `pipe.write_catalog_line.type`) and `invalid_missing_pipe_type` (`Additional properties are not allowed ('prompt' was unexpected)`, at `pipe.write_round_sheet`). Both are `error[schema]`, which is the point: the schema stage is exactly the part of the fault a structural check can see.

**When re-measuring, run from outside the repo root, or drive `plxt` on stdin with `--no-auto-config`.** `plxt.toml` excludes `test-data/**`, so pointing the CLI at those paths from the repo root reports `found files total=1 excluded=1` and exits **0** having linted nothing — a false clean that looks exactly like a pass.

The partition the sweep actually needs is "is this entry's declared fault structural?", and nothing in `entry.toml` expresses it today. An entry's `error.*` tag is the obvious candidate signal, but reading structure out of an error-type name would be a second reading of `pipelex`'s registry invented here, which is the thing this note argues against at the end. It has to be settled with `pipelex`, not decided in this repo.

Which is also why the gate is not built yet. The entries are still in open `pipelex` PR #1139 and may be renamed in review; the signal that would drive the partition does not exist; and the natural home for the change is the sync commit itself, which is gated on the same `pipelex` release that carries the entries.

## The half that remains, and why this toolchain cannot do it

What is still missing is the actual cross-language conformance check: does a second, independent implementation of MTHDS agree with the canonical set's own declared verdicts?

`plxt lint` cannot answer that, and the reach of the gap is worth stating precisely, because the obvious framing overstates what is achievable here. Linting is TOML syntax, then DOM validation, then JSON Schema validation — it never resolves references. A corpus bundle whose `output` names a concept that exists nowhere in the bundle lints **clean, exit 0**. So structural acceptance is the ceiling of what this repo can check on its own, and "an invalid entry must produce a diagnostic" is not a claim `plxt` can make good on: an entry curated to be semantically wrong will lint clean here.

Agreement with `expected_error` is further out still. That field names a `pipelex` runtime `error_type`, produced by loading and dry-running a bundle, which is a Python-side capability with no counterpart in this toolchain.

## When to revisit

At Phase 3 of the corpus work, which introduces the `error.*` vocabulary and the `expected_error` agreement check on the `pipelex` side. Two things should happen then:

- the corpus sweep here gains a *structural* partition — not a `validity` one, for the reasons measured above — so entries whose declared fault the schema can see are held to a different expectation than the rest;
- the design settles where semantic conformance actually belongs. If it needs the runtime, it belongs in `pipelex` or in `conformance/`, not in a Rust crate that has no semantic layer to compare against — and this repo's honest contribution stays what `corpus.rs` already does.

Worth coordinating with the `pipelex`-side agreement check so the two read `expected_error` the same way, rather than inventing a second reading of it here.

The separate question of whether the vendored copy is still byte-identical to upstream is **not** part of this gap and is not this repo's to answer: the workspace-root `docs/specs/mthds-test-corpus.md` assigns it to the workspace-side `mthds-corpus-sync` sweep, because a consumer's CI only ever checks out one tree. Automating that sweep is tracked in the workspace's `wip/corpus/automating-the-corpus-freshness-sweep.md`.
