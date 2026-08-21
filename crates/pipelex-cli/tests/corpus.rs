//! The vendored MTHDS Test Corpus must still be *accepted* by this toolchain —
//! not merely handled consistently by it — and the entries curated to be rejected
//! must still be rejected.
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
//! **The failure this closes, in both directions.** `pipelex` adds a pipe kind or
//! a field, the `mthds.schema.json` vendored here goes stale, a corpus re-sync
//! lands, and CI stays green while the toolchain has silently stopped accepting
//! the canonical corpus. That is the permissive-to-strict direction. The other one
//! matters just as much and nothing else here covers it: a schema that quietly
//! stopped *rejecting* an unknown pipe type, or a key it does not allow, would
//! leave every valid entry green. Holding the schema-fault entries to a diagnostic
//! is what closes it.
//!
//! **How the two populations are told apart — read from the corpus, never guessed.**
//! An entry declares which vocabulary tags it `covers`, and since `pipelex` v0.51.0
//! each non-excluded `error.*` tag in `vocabulary.toml` declares `fails_at`: the
//! earliest layer of checking that rejects a bundle carrying the fault. `schema`
//! means a check of the document's shape alone already catches it, which is exactly
//! the reach of `plxt lint` — TOML syntax, then DOM validation, then JSON Schema,
//! with references never resolved. So the contract's consumer rule drops straight
//! out: **a structural sweep expects a diagnostic exactly when `fails_at = "schema"`.**
//!
//! Two earlier candidate partitions were measured and rejected, and neither should
//! come back. Branching on the entry's `validity` is wrong because `validity` is a
//! *semantic* declaration about the `pipelex` runtime and the two axes cross: most
//! invalid entries carry faults — unresolved concepts, missing input variables,
//! unguarded optionals — that a structural check cannot see, so "invalid ⇒ expect a
//! diagnostic" goes red on the majority of them, while "invalid ⇒ skip" throws away
//! the only probes this repo has for the permissive direction. Deriving the layer
//! here from the *name* of the error type is wrong for a different reason: it would
//! be a second reading of `pipelex`'s registry, invented downstream and free to
//! drift from it. `fails_at` exists so neither is necessary.
//!
//! **Why the library and not the binary.** `parity.rs` already pins the two
//! together over this same tree, so spawning `plxt` once per entry would re-prove
//! that at the cost of a process per file. `lint_mthds_impl` validates against the
//! same embedded MTHDS schema the CLI is pointed at there.

mod common;

use common::{collect_mthds_fixtures, corpus_dir, corpus_entry_dirs};
use pipelex_tools::lint::lint_mthds_impl;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The `fails_at` values the corpus contract defines. A value outside this set is a
/// contract this sweep does not understand, and is refused rather than bucketed into
/// whichever branch happens to be the lenient one.
const FAILS_AT_VALUES: [&str; 2] = ["schema", "runtime"];

/// Every `error.*` tag the vendored vocabulary marks `fails_at = "schema"` — the
/// faults a structural check is expected to catch.
///
/// Read off the vendored `vocabulary.toml` rather than hardcoded, so a fault moving
/// between layers upstream arrives with the sync instead of needing an edit here.
fn schema_fault_tags() -> BTreeSet<String> {
    let path = corpus_dir().join("vocabulary.toml");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "cannot read the vendored corpus vocabulary at {} ({err}) — the sync that \
             wrote this copy was partial, and without it no entry can be classified",
            path.display()
        )
    });
    let vocabulary: toml::Value =
        toml::from_str(&raw).expect("vendored vocabulary.toml should parse");
    let errors = vocabulary
        .get("error")
        .and_then(toml::Value::as_table)
        .unwrap_or_else(|| {
            panic!(
                "the vendored vocabulary at {} declares no `error.*` namespace — this sweep \
                 would then hold every entry to the clean branch, including the ones curated \
                 to be rejected",
                path.display()
            )
        });

    let mut tags = BTreeSet::new();
    for (code, entry) in errors {
        let Some(fails_at) = entry.get("fails_at") else {
            // An excluded tag carries no `fails_at`, by contract: a code is excluded
            // precisely when no bundle produces it, so there is nothing to measure on
            // and no entry can cover it. But the exclusion has to be *stated*. A tag
            // carrying neither key is a vocabulary this sweep cannot read, and reading
            // it as excluded is the one lenient default that would retire a probe in
            // silence — the tag might be a schema fault whose layer went missing.
            assert!(
                entry.get("excluded").is_some(),
                "vocabulary tag error.{code} declares neither `fails_at` nor `excluded`. Upstream \
                 requires every tag that is owed an entry to name the layer it fails at, so this \
                 copy is partial or hand-edited — re-sync it. Treating the tag as excluded here \
                 would drop it from the classification and could quietly retire a rejecting-\
                 direction probe."
            );
            continue;
        };
        let fails_at = fails_at.as_str().unwrap_or_else(|| {
            panic!("vocabulary tag error.{code}: `fails_at` is not a string — {fails_at:?}")
        });
        assert!(
            FAILS_AT_VALUES.contains(&fails_at),
            "vocabulary tag error.{code}: fails_at is {fails_at:?}, which the corpus contract \
             does not define (expected one of {FAILS_AT_VALUES:?}). Re-sync the copy; if the \
             contract really did grow a layer, this sweep has to learn what it means before it \
             can keep classifying entries."
        );
        if fails_at == "schema" {
            tags.insert(format!("error.{code}"));
        }
    }
    tags
}

/// The tags one entry declares it covers, read off its `entry.toml`.
fn covers_of(entry_dir: &Path) -> Vec<String> {
    let manifest_path = entry_dir.join("entry.toml");
    let raw = std::fs::read_to_string(&manifest_path).unwrap_or_else(|err| {
        panic!(
            "cannot read corpus manifest {} ({err})",
            manifest_path.display()
        )
    });
    let manifest: toml::Value = toml::from_str(&raw).unwrap_or_else(|err| {
        panic!(
            "corpus manifest {} should parse ({err})",
            manifest_path.display()
        )
    });
    match manifest.get("covers") {
        None => Vec::new(),
        Some(covers) => covers
            .as_array()
            .unwrap_or_else(|| {
                panic!(
                    "corpus manifest {}: `covers` is not an array",
                    manifest_path.display()
                )
            })
            .iter()
            .map(|tag| {
                tag.as_str()
                    .unwrap_or_else(|| {
                        panic!(
                            "corpus manifest {}: a `covers` tag is not a string",
                            manifest_path.display()
                        )
                    })
                    .to_string()
            })
            .collect(),
    }
}

/// Which of this entry's declared faults are ones a structural check can see.
///
/// Returned as the set rather than as a bare "does it expect a diagnostic?", so the
/// sweep can afterwards check that every schema fault the vocabulary declares was
/// actually probed by some entry — not merely that some entry probed something.
///
/// An `error.*` tag that the vendored vocabulary does not classify is refused rather
/// than assumed clean: it means the copy is partial or the contract moved, and the
/// lenient reading would silently retire a probe.
fn schema_faults_covered_by(
    entry_dir: &Path,
    schema_faults: &BTreeSet<String>,
    all_error_tags: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut covered = BTreeSet::new();
    for tag in covers_of(entry_dir) {
        if !tag.starts_with("error.") {
            continue;
        }
        assert!(
            all_error_tags.contains(&tag),
            "corpus entry {} covers {tag}, which the vendored vocabulary does not declare — \
             the copy is out of step with itself, so this entry cannot be classified. Re-sync it.",
            entry_dir.display()
        );
        if schema_faults.contains(&tag) {
            covered.insert(tag);
        }
    }
    covered
}

/// Every `error.*` tag the vendored vocabulary declares *and* classifies.
fn classified_error_tags() -> BTreeSet<String> {
    let path = corpus_dir().join("vocabulary.toml");
    let raw = std::fs::read_to_string(&path).expect("vendored vocabulary should be readable");
    let vocabulary: toml::Value =
        toml::from_str(&raw).expect("vendored vocabulary.toml should parse");
    vocabulary
        .get("error")
        .and_then(toml::Value::as_table)
        .map(|errors| {
            errors
                .iter()
                .filter(|(_, entry)| entry.get("fails_at").is_some())
                .map(|(code, _)| format!("error.{code}"))
                .collect()
        })
        .unwrap_or_default()
}

/// The `.mthds` files of one entry, discovered by recursion so a multi-file entry
/// brings its library files along.
fn entry_fixtures(entry_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_mthds_fixtures(entry_dir, &mut files);
    files.sort();
    files
}

#[test]
fn every_corpus_entry_lints_as_its_declared_layer_says() {
    let entry_dirs = corpus_entry_dirs();
    // A sweep that discovers nothing passes trivially, which would hide exactly
    // the situation worth knowing about: the corpus moved, or a sync emptied it.
    assert!(
        !entry_dirs.is_empty(),
        "no entry.toml found under test-data/mthds-corpus — the vendored corpus is \
         missing or empty, so this gate would pass without checking anything"
    );

    let schema_faults = schema_fault_tags();
    let classified = classified_error_tags();
    // The schema-fault population is the whole of this suite's coverage in the
    // permissive direction. If a sync ever empties it, every entry falls into the
    // clean branch and the suite quietly stops checking that anything is rejected.
    assert!(
        !schema_faults.is_empty(),
        "the vendored vocabulary classifies no fault as `fails_at = \"schema\"`, so this sweep \
         would hold every entry to the clean branch and check nothing in the rejecting \
         direction. Either the copy is stale, or the contract moved and this suite has to \
         be re-thought rather than left green."
    );

    let mut probed_schema_faults: BTreeSet<String> = BTreeSet::new();
    for entry_dir in entry_dirs {
        let fixtures = entry_fixtures(&entry_dir);
        let covered = schema_faults_covered_by(&entry_dir, &schema_faults, &classified);
        let expects = !covered.is_empty();

        let mut entry_diagnostics = Vec::new();
        for fixture in &fixtures {
            let content = std::fs::read_to_string(fixture).expect("read corpus fixture");
            let diagnostics = lint_mthds_impl(&content).expect("binding lint should not raise");
            if expects {
                entry_diagnostics.extend(diagnostics);
            } else {
                assert!(
                    diagnostics.is_empty(),
                    "corpus entry {} no longer lints clean ({} diagnostic(s), first kind {:?}). \
                     Its declared faults are all `fails_at = \"runtime\"`, so a structural check \
                     is not supposed to see them. Two causes are worth separating before assuming \
                     either: the vendored mthds.schema.json (or the parser) has gone stale against \
                     the synced corpus, or a fault moved layer upstream and the copy is behind — \
                     re-sync before editing anything here. Diagnostics: {diagnostics:?}",
                    fixture.display(),
                    diagnostics.len(),
                    diagnostics[0].kind,
                );
            }
        }

        if expects {
            probed_schema_faults.extend(covered);
            // Asserted per entry rather than per file: a multi-file entry carries its
            // fault in one of its files, and the others are library fragments that are
            // supposed to lint clean on their own.
            assert!(
                !entry_diagnostics.is_empty(),
                "corpus entry {} covers a fault the vocabulary marks `fails_at = \"schema\"`, so \
                 this toolchain is supposed to reject it — and it linted clean across all {} of \
                 its files. The schema has gone permissive: it stopped rejecting a shape the \
                 canonical corpus says is invalid. Do NOT relax this expectation to make it pass; \
                 fix the vendored mthds.schema.json, which is what this direction of the sweep \
                 exists to catch.",
                entry_dir.display(),
                fixtures.len(),
            );
        }
    }

    // Every schema fault, not merely one of them. Counting probes would let the faults
    // that already have entries hold the number above zero while a newly declared one
    // arrives with no entry to exercise it — the rejecting direction would then be
    // unchecked for exactly the fault that just changed. Upstream's exhaustivity gate
    // owes every non-excluded tag a focused entry, and this consumer vendors the whole
    // corpus, so any gap here is a partial sync rather than a corpus that lacks the entry.
    let unprobed: Vec<&str> = schema_faults
        .difference(&probed_schema_faults)
        .map(String::as_str)
        .collect();
    assert!(
        unprobed.is_empty(),
        "the vendored vocabulary marks {unprobed:?} as `fails_at = \"schema\"`, but no vendored \
         entry covers them — so nothing exercised the rejecting direction for those faults, and \
         a schema that stopped rejecting them would leave this suite green. The slice is out of \
         step with the vocabulary it ships beside; re-sync the copy rather than narrowing this \
         expectation."
    );
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
