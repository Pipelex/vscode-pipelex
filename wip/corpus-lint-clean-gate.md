# The vendored corpus is parity *input*, not yet a cross-language conformance *check*

Recorded 2026-08-20 from the code review of the corpus vendoring change on `feature/MthdsTestCorpus`. The vendoring itself is sound and stays; what follows is the check it does not yet perform, and why building it was deferred rather than bolted on.

## What parity actually asserts

`crates/pipelex-cli/tests/parity.rs` formats and lints every fixture through the in-process `pipelex_tools` library and through the shipped `plxt` binary, and requires the two to agree. Both sides are **the same Rust engine**, in two embeddings. So parity proves the library and the binary do not drift — a real property, now checked over a much larger and independently-owned body of MTHDS than this repo authors — but it says nothing about whether the engine's verdict is *correct*.

That was measured, not assumed. Dropping a syntactically valid entry declaring `type = "PipeNotARealThing"` into `test-data/mthds-corpus/entries/` leaves parity green: `plxt lint` rejects the file, the library rejects it identically, and agreeing on a rejection is all parity asks. A raw TOML syntax error is weaker still — `format_matches_cli_on_every_fixture` hits its `continue` and asserts nothing at all for that fixture.

The failure this permits: `pipelex` adds a pipe kind or a field, this repo's vendored `mthds.schema.json` goes stale, the re-sync lands, and CI here stays green while the toolchain has silently stopped accepting the canonical corpus. That is precisely the drift the vendoring exists to catch.

## Why the check was not added in the same change

The obvious assertion — "every corpus bundle lints clean" — is wrong as written, and would have to be un-written almost immediately. `validity` is a coverage axis of the corpus (`docs/specs/mthds-test-corpus.md`): entries are `valid` or `invalid`, invalid ones are curated bad methods, and each declares the `expected_error` it must produce. A blanket lint-clean sweep would fail on the first invalid entry synced here.

Doing it correctly means reading each entry's `entry.toml`, branching on `validity`, and — to be worth more than a smoke test — checking an invalid entry's diagnostic against its declared `expected_error`. That is a TOML dependency and a real chunk of test surface in a Rust crate that currently needs neither.

It is also not urgent: today's slice is entirely `validity = "valid"`, and the whole vendored set does lint clean right now (verified: every `.mthds` file returns zero diagnostics from `plxt lint --schema pipelex://mthds.schema.json`). Nothing is broken; the claim was just larger than the check.

## When to build it

When the corpus grows invalid entries — Phase 3 of the corpus work, which introduces the `error.*` vocabulary and the `expected_error` agreement check on the `pipelex` side. At that point this repo should gain the sweep it deserves:

- read each entry's `entry.toml`;
- a `valid` entry must lint clean through `plxt`;
- an `invalid` entry must produce a diagnostic, and ideally one matching its `expected_error`.

That sweep, not parity, is the cross-language conformance the corpus was built to give: a second, independent implementation of MTHDS agreeing with the canonical set's own declared verdicts. Worth coordinating with the `pipelex`-side agreement check so the two read `expected_error` the same way.

Until then, the changelog and `docs/dev/mthds-engine-bindings.md` describe parity as what it is — library against binary — and claim nothing more.
