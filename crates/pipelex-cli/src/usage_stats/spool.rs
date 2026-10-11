//! `plxt`'s spool, `spool/plxt/` in the shared state: queued events waiting for a
//! sender. A file is `<created-ms>-<random>.json`, written under a dot name and
//! renamed into place; a sender claims it by renaming it to
//! `<name>.sending-<random>`, then deletes it or renames it back.
//!
//! A file holds `{"spool_version": 1, "endpoint": <origin>, "events": [...]}`, the
//! endpoint being the origin of the capture endpoint its events were queued for,
//! exactly as the switches resolved it. A sender posts a file only to that origin and
//! leaves it for a sender posting there otherwise, so events queued under a test's
//! loopback override never reach PostHog. A file naming no endpoint may be posted by
//! any sender.

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
/// The member naming the origin a file's events were queued for.
const ENDPOINT_KEY: &str = "endpoint";
const CLAIM_MARK: &str = ".sending-";
const EXTENSION: &str = ".json";

/// What a spool file holds.
#[derive(Debug, Clone, PartialEq)]
pub struct Content {
    /// The origin of the endpoint the events were queued for; `None` in a file that
    /// names none.
    pub endpoint: Option<String>,
    pub events: Vec<Value>,
}

impl Content {
    /// Whether a sender posting to `origin` may post these events: the file names
    /// that origin, or names none.
    pub fn is_queued_for(&self, origin: &str) -> bool {
        match &self.endpoint {
            None => true,
            Some(endpoint) => endpoint == origin,
        }
    }
}

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

    /// Queue `events` for the endpoint at `origin` in a new file, then trim the spool
    /// to its limit, oldest first.
    pub fn write(&self, origin: &str, events: &[Value]) -> io::Result<PathBuf> {
        create_private_dir(&self.dir)?;
        let name = format!("{}-{}{EXTENSION}", random::now_ms(), random::suffix());
        let path = self.dir.join(&name);
        write_atomically(
            &self.dir.join(format!(".{name}.tmp")),
            &path,
            &body(Some(origin), events),
        )?;
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

    /// Claim, oldest first, every unclaimed file a sender posting to `origin` may
    /// post. A file queued for another endpoint is left unclaimed, for a sender
    /// posting there; one that cannot be read is claimed, so that its sender deletes it.
    pub fn claim_all(&self, origin: &str) -> Vec<Claimed> {
        self.files()
            .into_iter()
            .filter(|path| path.to_string_lossy().ends_with(EXTENSION))
            .filter(|path| match read(path) {
                Some(content) => content.is_queued_for(origin),
                None => true,
            })
            .filter_map(|path| self.claim(&path))
            .collect()
    }
}

impl Claimed {
    /// What the file holds, or `None` when it is not a spool file this version reads.
    pub fn content(&self) -> Option<Content> {
        read(&self.claimed)
    }

    /// Replace the claimed file's content, after dropping some of its events; the
    /// endpoint it names, or names none, stays as it was.
    pub fn rewrite(&self, content: &Content) -> io::Result<()> {
        let dir = self.claimed.parent().unwrap_or_else(|| Path::new("."));
        let temporary = dir.join(format!(".rewrite-{}.tmp", random::suffix()));
        write_atomically(
            &temporary,
            &self.claimed,
            &body(content.endpoint.as_deref(), &content.events),
        )
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

/// A spool file's bytes, naming `endpoint` when there is one.
fn body(endpoint: Option<&str>, events: &[Value]) -> Vec<u8> {
    let mut body = json!({ "spool_version": SPOOL_VERSION, "events": events });
    if let (Some(endpoint), Some(members)) = (endpoint, body.as_object_mut()) {
        members.insert(ENDPOINT_KEY.to_string(), Value::from(endpoint));
    }
    body.to_string().into_bytes()
}

/// What the spool file at `path` holds, or `None` when it is not one this version
/// reads: unreadable, not JSON, of another version, or naming an endpoint that is not
/// a string. A `null` endpoint names none.
fn read(path: &Path) -> Option<Content> {
    let text = fs::read_to_string(path).ok()?;
    let body: Value = serde_json::from_str(&text).ok()?;
    if body.get("spool_version").and_then(Value::as_u64) != Some(SPOOL_VERSION) {
        return None;
    }
    let endpoint = match body.get(ENDPOINT_KEY) {
        None | Some(Value::Null) => None,
        Some(Value::String(endpoint)) => Some(endpoint.clone()),
        Some(_) => return None,
    };
    let events = body.get("events")?.as_array()?.clone();
    Some(Content { endpoint, events })
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::usage_stats::{context::Context, switches::Endpoint};

    /// A spool in a directory of its own under the system's temporary directory,
    /// removed when dropped.
    struct Scratch {
        root: PathBuf,
        spool: Spool,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "plxt-spool-{name}-{}-{}",
                std::process::id(),
                random::suffix()
            ));
            let spool = Spool::new(root.join("spool").join("plxt"));
            Self { root, spool }
        }

        /// The names of the spool's files, sorted.
        fn names(&self) -> Vec<String> {
            let mut names = fs::read_dir(&self.spool.dir)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            names.sort();
            names
        }

        /// Queue a file holding `body` as it is, as another tool or version may have.
        fn queue_raw(&self, label: &str, body: &Value) -> PathBuf {
            create_private_dir(&self.spool.dir).unwrap();
            let path = self
                .spool
                .dir
                .join(format!("{}-{label}{EXTENSION}", random::now_ms()));
            fs::write(&path, body.to_string()).unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn event(uuid: &str) -> Value {
        json!({ "event": "command_completed", "uuid": uuid })
    }

    fn origin_resolved_from(vars: &[(&str, &str)]) -> String {
        let vars = vars
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect::<HashMap<_, _>>();
        Endpoint::from_context(&Context::new(vars, None, None))
            .origin()
            .unwrap()
            .to_string()
    }

    fn file_json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_written_file_names_the_origin_the_switches_resolved() {
        let scratch = Scratch::new("written");
        for (vars, expected) in [
            (&[][..], "https://eu.i.posthog.com"),
            (
                &[(contract::ENV_ENDPOINT_OVERRIDE, "http://127.0.0.1:9")][..],
                "http://127.0.0.1:9",
            ),
            (
                &[(contract::ENV_ENDPOINT_OVERRIDE, "http://[::1]:8080")][..],
                "http://[::1]:8080",
            ),
        ] {
            let origin = origin_resolved_from(vars);
            let path = scratch.spool.write(&origin, &[event("a")]).unwrap();
            let body = file_json(&path);
            assert_eq!(body["spool_version"], json!(1), "{vars:?}");
            assert_eq!(body["endpoint"], json!(expected), "{vars:?}");
            assert_eq!(body["events"], json!([event("a")]), "{vars:?}");
        }
    }

    #[test]
    fn a_sender_claims_only_the_files_queued_for_its_endpoint() {
        let scratch = Scratch::new("claim");
        let own = scratch
            .spool
            .write("http://127.0.0.1:9", &[event("own")])
            .unwrap();
        let foreign = scratch
            .spool
            .write("http://127.0.0.1:10", &[event("foreign")])
            .unwrap();
        let production = scratch
            .spool
            .write(contract::CAPTURE_HOST, &[event("production")])
            .unwrap();
        let anywhere = scratch.queue_raw(
            "anywhere",
            &json!({ "spool_version": 1, "events": [event("anywhere")] }),
        );
        let null = scratch.queue_raw(
            "null",
            &json!({ "spool_version": 1, "endpoint": null, "events": [event("null")] }),
        );
        let unreadable = scratch.queue_raw("unreadable", &json!("not a spool file"));
        let foreign_before = fs::read(&foreign).unwrap();
        let production_before = fs::read(&production).unwrap();

        let claimed = scratch.spool.claim_all("http://127.0.0.1:9");
        let mut originals = claimed
            .iter()
            .map(|file| file.original.clone())
            .collect::<Vec<_>>();
        originals.sort();
        let mut expected = vec![own, anywhere, null, unreadable];
        expected.sort();
        assert_eq!(originals, expected);

        // The files queued elsewhere stay where they were, as they were.
        assert_eq!(fs::read(&foreign).unwrap(), foreign_before);
        assert_eq!(fs::read(&production).unwrap(), production_before);

        let contents = claimed.iter().map(Claimed::content).collect::<Vec<_>>();
        assert!(contents.contains(&Some(Content {
            endpoint: Some("http://127.0.0.1:9".to_string()),
            events: vec![event("own")],
        })));
        assert!(contents.contains(&Some(Content {
            endpoint: None,
            events: vec![event("anywhere")],
        })));
        assert!(contents.contains(&Some(Content {
            endpoint: None,
            events: vec![event("null")],
        })));
        assert!(contents.contains(&None));
        claimed.into_iter().for_each(Claimed::release);
    }

    #[test]
    fn a_file_naming_an_endpoint_that_is_not_a_string_is_not_read() {
        let scratch = Scratch::new("malformed");
        let path = scratch.queue_raw(
            "malformed",
            &json!({ "spool_version": 1, "endpoint": 9, "events": [event("a")] }),
        );
        assert_eq!(read(&path), None);
    }

    #[test]
    fn a_rewrite_keeps_the_endpoint_the_file_named() {
        let scratch = Scratch::new("rewrite");
        scratch
            .spool
            .write("http://127.0.0.1:9", &[event("a"), event("b")])
            .unwrap();
        scratch.queue_raw(
            "anywhere",
            &json!({ "spool_version": 1, "events": [event("c"), event("d")] }),
        );
        for file in scratch.spool.claim_all("http://127.0.0.1:9") {
            let mut content = file.content().unwrap();
            content.events.truncate(1);
            file.rewrite(&content).unwrap();
            assert_eq!(file.content(), Some(content.clone()));
            let body = file_json(&file.claimed);
            assert_eq!(
                body.get("endpoint").cloned(),
                content.endpoint.map(Value::from),
                "a file naming no endpoint is rewritten naming none"
            );
            file.release();
        }
        assert_eq!(scratch.names().len(), 2);
    }
}
