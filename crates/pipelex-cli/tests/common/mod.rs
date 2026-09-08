//! Fixture discovery shared by this crate's integration suites.
//!
//! Cargo compiles every file directly under `tests/` as its own test binary, so a
//! helper shared between two suites has to live in a subdirectory — hence
//! `tests/common/mod.rs`, pulled in with `mod common;` by each suite that wants it.
//! Each binary compiles the whole module and uses only part of it, which is why
//! `dead_code` is allowed here rather than at each unused item.
//!
//! **Only discovery is shared, and deliberately so.** The two suites sweep
//! different tree sets and mean different things by the sweep: `parity.rs` compares
//! the library against the binary over both trees, while `corpus.rs` requires the
//! vendored corpus alone to be *accepted*. Pointing either at the other's tree
//! would assert the opposite of what it is for — `test-data/mthds/` is largely
//! negative fixtures — so each suite names the directories it wants at its own call
//! site instead of inheriting a set from here.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Repo root, resolved from this crate's manifest dir (`<root>/crates/pipelex-cli`).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should resolve")
}

/// This repo's own MTHDS fixtures. Largely *negative* — curated bad MTHDS that
/// `plxt` is supposed to reject — so no suite may require this tree to lint clean.
pub fn mthds_dir() -> PathBuf {
    repo_root().join("test-data/mthds")
}

/// The vendored MTHDS Test Corpus: owned by `pipelex`, re-synced from it, never
/// edited here. A sibling of [`mthds_dir`] rather than a directory inside it
/// because that tree is also swept by the wasm suite, which snapshot-pins per-fixture
/// output — see the module docs of `parity.rs`.
pub fn corpus_dir() -> PathBuf {
    repo_root().join("test-data/mthds-corpus")
}

/// Recursively collect every `.mthds` file under `dir` into `files`.
pub fn collect_mthds_fixtures(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("fixture dir should be readable") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_mthds_fixtures(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("mthds") {
            files.push(path);
        }
    }
}

/// Every corpus *entry* directory, identified by the `entry.toml` the corpus
/// contract requires each one to carry. Returns the directories, not the manifests.
pub fn corpus_entry_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    collect_entry_dirs(&corpus_dir(), &mut dirs);
    dirs.sort();
    dirs
}

fn collect_entry_dirs(dir: &Path, dirs: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("corpus dir should be readable") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_entry_dirs(&path, dirs);
        } else if path.file_name().and_then(|name| name.to_str()) == Some("entry.toml") {
            dirs.push(dir.to_path_buf());
        }
    }
}
