//! The vendored MTHDS Test Corpus must still be *accepted* by this toolchain —
//! not merely handled consistently by it.
//!
//! **Why this is a separate suite from `parity.rs`.** Parity asserts that the
//! in-process `pipelex_tools` library and the shipped `plxt` binary agree on the
//! same input. That is a real property, and it is deliberately *not* a
//! correctness property: two identical **non-empty** diagnostic sets satisfy it
//! exactly as well as two empty ones. So parity stays green when the toolchain
//! rejects a corpus entry, as long as it rejects it the same way twice — which is
//! precisely the regression the vendoring exists to catch. `test-data/mthds/`
//! makes that concrete: most of its fixtures are curated bad MTHDS that `plxt`
//! rejects, and parity is green over them.
//!
//! **The failure this closes.** `pipelex` adds a pipe kind or a field, the
//! `mthds.schema.json` vendored here goes stale, a corpus re-sync lands, and CI
//! stays green while the toolchain has silently stopped accepting the canonical
//! corpus. Requiring the corpus to lint clean turns that into a red build in the
//! same commit that syncs it.
//!
//! **What this does not prove.** `plxt lint` is TOML syntax, then DOM validation,
//! then JSON Schema — so this checks that every entry is *structurally acceptable*
//! MTHDS. It does not resolve concept or pipe references — a bundle whose `output`
//! names a concept that exists nowhere lints clean — and it says nothing about
//! whether an entry produces the verdict the corpus declares for it. That second
//! half needs the `pipelex` runtime rather than this toolchain; see
//! `wip/corpus-conformance-gap.md`.
//!
//! **Why the library and not the binary.** `parity.rs` already pins the two
//! together over this same tree, so spawning `plxt` once per entry would re-prove
//! that at the cost of a process per file. `lint_mthds_impl` validates against the
//! same embedded MTHDS schema the CLI is pointed at there.

mod common;

use common::{collect_mthds_fixtures, corpus_dir, corpus_entry_dirs};
use pipelex_tools::lint::lint_mthds_impl;
use std::path::PathBuf;

/// Every `.mthds` file in the vendored corpus, discovered by recursing the tree
/// rather than from a list, so a newly synced entry is swept with no wiring here.
///
/// Scoped to `test-data/mthds-corpus/` alone. The repo's own `test-data/mthds/`
/// is deliberately excluded: it holds negative fixtures whose whole purpose is to
/// be rejected, so sweeping both trees would assert the opposite of what each one
/// is for.
fn corpus_fixtures() -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_mthds_fixtures(&corpus_dir(), &mut files);
    files.sort();
    files
}

#[test]
fn every_corpus_bundle_lints_clean() {
    let fixtures = corpus_fixtures();
    // A sweep that discovers nothing passes trivially, which would hide exactly
    // the situation worth knowing about: the corpus moved, or a sync emptied it.
    assert!(
        !fixtures.is_empty(),
        "no .mthds files found under test-data/mthds-corpus — the vendored corpus \
         is missing or empty, so this gate would pass without checking anything"
    );

    for fixture in fixtures {
        let content = std::fs::read_to_string(&fixture).expect("read corpus fixture");
        let diagnostics = lint_mthds_impl(&content).expect("binding lint should not raise");
        // Every entry vendored today is structurally clean, so cleanliness is
        // asserted unconditionally. Do NOT "fix" a future failure here by branching
        // on the entry's `validity`: that field is a *semantic* declaration (does the
        // `pipelex` runtime validate this bundle?) and this gate is *structural*
        // (TOML → DOM → JSON Schema, references never resolved). The two axes cross,
        // and the correct partition is not expressible from `entry.toml` today —
        // `wip/corpus-conformance-gap.md` records the measurement and what a real fix
        // would need.
        assert!(
            diagnostics.is_empty(),
            "corpus entry {} no longer lints clean ({} diagnostic(s), first kind \
             {:?}). Two causes are worth separating before assuming either: the \
             vendored mthds.schema.json (or the parser) has gone stale against the \
             synced corpus, or the corpus now carries entries whose declared fault is \
             structural rather than semantic — see wip/corpus-conformance-gap.md. \
             Diagnostics: {diagnostics:?}",
            fixture.display(),
            diagnostics.len(),
            diagnostics[0].kind,
        );
    }
}

/// A sync that drops an entry's bundle but keeps its manifest leaves a directory
/// that looks like an entry and exercises nothing. Unlike "is the copy still what
/// the corpus says?" — which needs the canonical tree and is the workspace sync
/// sweep's job — this invariant is answerable from the vendored tree alone.
#[test]
fn every_corpus_entry_has_a_bundle() {
    let entry_dirs = corpus_entry_dirs();
    assert!(
        !entry_dirs.is_empty(),
        "no entry.toml found under test-data/mthds-corpus — the vendored corpus is \
         missing or empty, so this gate would pass without checking anything"
    );

    for dir in entry_dirs {
        let mut files = Vec::new();
        collect_mthds_fixtures(&dir, &mut files);
        assert!(
            !files.is_empty(),
            "corpus entry {} carries an entry.toml but no .mthds file — the sync that \
             wrote it was partial, so this entry is vendored without being exercised",
            dir.display()
        );
    }
}
