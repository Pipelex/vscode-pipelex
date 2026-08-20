# What the vendored corpus is checked for here, and what it still isn't

Recorded 2026-08-20 from the code review of the corpus vendoring change on `feature/MthdsTestCorpus`, and revised in the same review once the cost of the missing check turned out to be much lower than first assessed. This note now records only the half that genuinely remains.

## What parity proves, and what it does not

`crates/pipelex-cli/tests/parity.rs` formats and lints every fixture through the in-process `pipelex_tools` library and through the shipped `plxt` binary, and requires the two to agree. Both sides are **the same Rust engine**, in two embeddings. So parity proves the library and the binary do not drift — a real property, now checked over a much larger and independently-owned body of MTHDS than this repo authors — but it says nothing about whether the engine's verdict is *correct*.

That was measured, not assumed. Two identical **non-empty** diagnostic sets satisfy the equality assertion exactly as well as two empty ones, so parity stays green over content the toolchain rejects, provided it rejects it the same way twice. `test-data/mthds/` demonstrates it in the repository as it stands: most of those fixtures are curated bad MTHDS that `plxt lint` rejects, and parity is green over all of them. A raw TOML syntax error is weaker still — `format_matches_cli_on_every_fixture` hits its `continue` and asserts nothing at all for that fixture.

## The half that is now covered

`crates/pipelex-cli/tests/corpus.rs` requires every `.mthds` file under `test-data/mthds-corpus/` to lint clean through the embedded MTHDS schema. That closes the failure the vendoring exists to catch: `pipelex` adds a pipe kind or a field, the `mthds.schema.json` vendored here goes stale, the re-sync lands, and CI here stays green while the toolchain has silently stopped accepting the canonical corpus. It now goes red in the commit that syncs it.

The sweep is deliberately scoped to the corpus tree alone, because `test-data/mthds/` holds negative fixtures whose purpose is to be rejected. It guards against discovering nothing, so a moved or emptied corpus fails rather than passing vacuously. Every vendored entry declares `validity = "valid"` today, upstream included, so the sweep asserts cleanliness unconditionally; when the corpus grows curated invalid entries it must read each entry's `entry.toml` and require a diagnostic for those instead of none.

## The half that remains, and why this toolchain cannot do it

What is still missing is the actual cross-language conformance check: does a second, independent implementation of MTHDS agree with the canonical set's own declared verdicts?

`plxt lint` cannot answer that, and the reach of the gap is worth stating precisely, because the obvious framing overstates what is achievable here. Linting is TOML syntax plus JSON Schema validation — it never resolves references. A corpus bundle whose `output` names a concept that exists nowhere in the bundle lints **clean, exit 0**. So structural acceptance is the ceiling of what this repo can check on its own, and "an invalid entry must produce a diagnostic" is not a claim `plxt` can make good on: an entry curated to be semantically wrong will lint clean here.

Agreement with `expected_error` is further out still. That field names a `pipelex` runtime `error_type`, produced by loading and dry-running a bundle, which is a Python-side capability with no counterpart in this toolchain.

## When to revisit

At Phase 3 of the corpus work, which introduces the `error.*` vocabulary and the `expected_error` agreement check on the `pipelex` side. Two things should happen then:

- the corpus sweep here branches on each entry's `validity`, so curated invalid entries are held to a different expectation than valid ones;
- the design settles where semantic conformance actually belongs. If it needs the runtime, it belongs in `pipelex` or in `conformance/`, not in a Rust crate that has no semantic layer to compare against — and this repo's honest contribution stays what `corpus.rs` already does.

Worth coordinating with the `pipelex`-side agreement check so the two read `expected_error` the same way, rather than inventing a second reading of it here.

The separate question of whether the vendored copy is still byte-identical to upstream is **not** part of this gap and is not this repo's to answer: `docs/specs/mthds-test-corpus.md` assigns it to the workspace-side `mthds-corpus-sync` sweep, because a consumer's CI only ever checks out one tree. Automating that sweep is tracked in the workspace's `wip/corpus/automating-the-corpus-freshness-sweep.md`.
