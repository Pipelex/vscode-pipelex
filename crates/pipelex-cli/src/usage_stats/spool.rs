//! `plxt`'s spool, `spool/plxt/` in the shared state: queued events waiting for a
//! sender. A file is `<created-ms>-<random>.json`, written under a dot name and
//! renamed into place; a sender claims it by renaming it to
//! `<name>.sending-<random>`, then deletes it or renames it back.

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde_json::{json, Value};

use super::{
    contract, random,
    state::{create_private_dir, is_older_than, minutes, remove_if_present, write_atomically},
};

const SPOOL_VERSION: u64 = 1;
const CLAIM_MARK: &str = ".sending-";
const EXTENSION: &str = ".json";

#[derive(Debug, Clone)]
pub struct Spool {
    dir: PathBuf,
}

/// A spool file this process has claimed.
#[derive(Debug)]
pub struct Claimed {
    original: PathBuf,
    claimed: PathBuf,
}

impl Spool {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Queue `events` in a new file, then trim the spool to its limit, oldest first.
    pub fn write(&self, events: &[Value]) -> io::Result<PathBuf> {
        create_private_dir(&self.dir)?;
        let name = format!("{}-{}{EXTENSION}", random::now_ms(), random::suffix());
        let path = self.dir.join(&name);
        write_atomically(&self.dir.join(format!(".{name}.tmp")), &path, &body(events))?;
        self.trim_to_limit();
        Ok(path)
    }

    /// The spool's files, claimed or not, oldest first; temporary files excluded.
    fn files(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut files = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && !is_hidden(path))
            .collect::<Vec<_>>();
        files.sort_by_key(|path| created_ms(path));
        files
    }

    fn trim_to_limit(&self) {
        let files = self.files();
        if files.len() > contract::SPOOL_MAX_FILES {
            for path in &files[..files.len() - contract::SPOOL_MAX_FILES] {
                let _ = remove_if_present(path);
            }
        }
    }

    /// Tidy the spool before draining it: delete temporary files older than an hour,
    /// rename back claims older than ten minutes, and delete unsent files older than
    /// thirty days.
    pub fn tidy(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let stale_temporary = minutes(contract::SPOOL_STALE_TEMP_MINUTES);
        let stale_claim = minutes(contract::SPOOL_STALE_CLAIM_MINUTES);
        let max_age = Duration::from_secs(contract::SPOOL_MAX_AGE_DAYS * 24 * 60 * 60);
        for path in entries.flatten().map(|entry| entry.path()) {
            if !path.is_file() {
                continue;
            }
            if is_hidden(&path) {
                if is_older_than(&path, stale_temporary) {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }
            if age_from_name(&path).is_some_and(|age| age > max_age) {
                let _ = fs::remove_file(&path);
                continue;
            }
            if let Some(original) = unclaimed_name(&path) {
                if is_older_than(&path, stale_claim) {
                    let _ = fs::rename(&path, original);
                }
            }
        }
    }

    /// Claim one file by renaming it, or `None` when another sender got it first.
    pub fn claim(&self, path: &Path) -> Option<Claimed> {
        let name = path.file_name()?.to_string_lossy().into_owned();
        let claimed = self
            .dir
            .join(format!("{name}{CLAIM_MARK}{}", random::suffix()));
        fs::rename(path, &claimed).ok()?;
        // The rename keeps the file's time; stamp the claim so another sender can
        // tell a live claim from a crashed one.
        let _ = filetime::set_file_mtime(&claimed, filetime::FileTime::now());
        Some(Claimed {
            original: path.to_path_buf(),
            claimed,
        })
    }

    /// Claim every unclaimed file, oldest first.
    pub fn claim_all(&self) -> Vec<Claimed> {
        self.files()
            .into_iter()
            .filter(|path| path.to_string_lossy().ends_with(EXTENSION))
            .filter_map(|path| self.claim(&path))
            .collect()
    }
}

impl Claimed {
    /// The events the file holds, or `None` when it is not a spool file this
    /// version reads.
    pub fn events(&self) -> Option<Vec<Value>> {
        let text = fs::read_to_string(&self.claimed).ok()?;
        let body: Value = serde_json::from_str(&text).ok()?;
        if body.get("spool_version").and_then(Value::as_u64) != Some(SPOOL_VERSION) {
            return None;
        }
        body.get("events")?.as_array().cloned()
    }

    /// Replace the claimed file's events, after dropping some of them.
    pub fn rewrite(&self, events: &[Value]) -> io::Result<()> {
        let dir = self.claimed.parent().unwrap_or_else(|| Path::new("."));
        let temporary = dir.join(format!(".rewrite-{}.tmp", random::suffix()));
        write_atomically(&temporary, &self.claimed, &body(events))
    }

    pub fn delete(self) {
        let _ = remove_if_present(&self.claimed);
    }

    /// Give the file back to the next sender.
    pub fn release(self) {
        if fs::rename(&self.claimed, &self.original).is_err() {
            let _ = remove_if_present(&self.claimed);
        }
    }
}

/// A spool file's content.
fn body(events: &[Value]) -> Vec<u8> {
    json!({ "spool_version": SPOOL_VERSION, "events": events })
        .to_string()
        .into_bytes()
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with('.'))
}

/// The milliseconds a file name starts with, `u128::MAX` when it has none.
fn created_ms(path: &Path) -> u128 {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.split('-').next())
        .and_then(|prefix| prefix.parse::<u128>().ok())
        .unwrap_or(u128::MAX)
}

/// How long ago the file was created, from its name, or from its modification
/// time when the name carries none.
fn age_from_name(path: &Path) -> Option<Duration> {
    let created = created_ms(path);
    if created == u128::MAX {
        return fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok());
    }
    let now = random::now_ms();
    let elapsed = now.checked_sub(created)?;
    Some(Duration::from_millis(u64::try_from(elapsed).ok()?))
}

/// For a claimed file, the name it had before its claim.
fn unclaimed_name(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let index = name.find(CLAIM_MARK)?;
    Some(path.with_file_name(&name[..index]))
}
