//! The shared state directory, `~/.mthds/usage-stats/`: one small file per fact,
//! each created or deleted whole and never rewritten, so tools running at once never
//! undo each other's choice. Every reporting tool on the machine reads and writes it.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use super::{context::Context, contract, random};

/// What the `id` file holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdReading {
    Absent,
    Valid(String),
    Malformed,
}

/// The installation identifier a process reports under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub id: String,
    /// Whether this process created the identifier (`id_new`).
    pub created: bool,
    /// Whether the identifier is the one `id` holds. When it is not, the process
    /// drew one for itself alone: the directory could not be written, hard links are
    /// not available, or `id` is malformed.
    pub persisted: bool,
}

#[derive(Debug, Clone)]
pub struct StateDir {
    root: PathBuf,
}

impl StateDir {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn from_context(context: &Context) -> Option<Self> {
        context.state_dir().map(Self::new)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn spool_root(&self) -> PathBuf {
        self.file(contract::STATE_SPOOL)
    }

    pub fn tool_spool(&self, tool: &str) -> PathBuf {
        self.spool_root().join(tool)
    }

    /// Create the directory, with mode `0700` on POSIX, when it does not exist yet.
    pub fn ensure(&self) -> io::Result<()> {
        create_private_dir(&self.root)
    }

    pub fn read_id(&self) -> IdReading {
        match fs::read(self.file(contract::STATE_ID)) {
            Err(_) => IdReading::Absent,
            Ok(bytes) => match std::str::from_utf8(&bytes) {
                Ok(text) if is_installation_id(text.trim()) => {
                    IdReading::Valid(text.trim().to_string())
                }
                _ => IdReading::Malformed,
            },
        }
    }

    /// The identifier to report under, created the race-free way when `id` does not
    /// exist yet, and drawn for this process alone when it cannot be persisted.
    pub fn obtain_identity(&self) -> Option<Identity> {
        self.remove_stale_id_temporaries();
        match self.read_id() {
            IdReading::Valid(id) => Some(Identity {
                id,
                created: false,
                persisted: true,
            }),
            IdReading::Malformed => process_local_identity(),
            IdReading::Absent => match self.create_id() {
                Ok(identity) => Some(identity),
                Err(_) => process_local_identity(),
            },
        }
    }

    /// Create `id`: write a fresh identifier to a temporary file, flush it, publish it
    /// with a hard link that fails when `id` exists, delete the temporary file, and
    /// read back the winner when another process published first.
    pub fn create_id(&self) -> io::Result<Identity> {
        self.ensure()?;
        let fresh = random::uuid_v4().ok_or_else(|| io::Error::other("no random source"))?;
        let temporary = self.file(&format!("{}.tmp-{}", contract::STATE_ID, random::suffix()));
        write_new_synced(&temporary, fresh.as_bytes())?;
        let linked = fs::hard_link(&temporary, self.file(contract::STATE_ID));
        let _ = fs::remove_file(&temporary);
        match linked {
            Ok(()) => Ok(Identity {
                id: fresh,
                created: true,
                persisted: true,
            }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => match self.read_id() {
                IdReading::Valid(id) => Ok(Identity {
                    id,
                    created: false,
                    persisted: true,
                }),
                // Another process published something that is not an identifier: use
                // the fresh one for this process alone, and never rewrite `id`.
                IdReading::Malformed | IdReading::Absent => Ok(Identity {
                    id: fresh,
                    created: true,
                    persisted: false,
                }),
            },
            Err(error) => Err(error),
        }
    }

    /// Delete `id`, the first half of `reset-id`.
    pub fn delete_id(&self) -> io::Result<()> {
        remove_if_present(&self.file(contract::STATE_ID))
    }

    /// A temporary identifier older than an hour is a crash's leftover.
    fn remove_stale_id_temporaries(&self) {
        let prefix = format!("{}.tmp-", contract::STATE_ID);
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(&prefix)
                && is_older_than(&entry.path(), minutes(contract::SPOOL_STALE_TEMP_MINUTES))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    pub fn is_disabled(&self) -> bool {
        self.file(contract::STATE_DISABLED).exists()
    }

    pub fn create_disabled(&self) -> io::Result<()> {
        self.ensure()?;
        create_marker(&self.file(contract::STATE_DISABLED))
    }

    pub fn delete_disabled(&self) -> io::Result<()> {
        remove_if_present(&self.file(contract::STATE_DISABLED))
    }

    pub fn is_internal(&self) -> bool {
        self.file(contract::STATE_INTERNAL).exists()
    }

    fn notice_marker(&self, version: u32) -> PathBuf {
        self.file(&format!("{}{version}", contract::STATE_NOTICE_PREFIX))
    }

    pub fn has_notice(&self, version: u32) -> bool {
        self.notice_marker(version).exists()
    }

    /// The highest notice version, no higher than this release's, recorded as shown.
    pub fn notice_version(&self) -> u32 {
        (1..=contract::NOTICE_VERSION)
            .rev()
            .find(|version| self.has_notice(*version))
            .unwrap_or(0)
    }

    pub fn record_notice(&self, version: u32) -> io::Result<()> {
        self.ensure()?;
        create_marker(&self.notice_marker(version))
    }

    pub fn legacy_marker_modified(&self) -> Option<SystemTime> {
        fs::metadata(self.file(contract::STATE_LEGACY_MIGRATED))
            .and_then(|metadata| metadata.modified())
            .ok()
    }

    /// Set `legacy-migrated`'s modification time to the later of now and the legacy
    /// config file's, creating the marker when it does not exist.
    pub fn mark_legacy_migrated(&self, legacy_config: Option<&Path>) -> io::Result<()> {
        self.ensure()?;
        let marker = self.file(contract::STATE_LEGACY_MIGRATED);
        create_marker(&marker)?;
        let now = SystemTime::now();
        let config_modified = legacy_config
            .and_then(|path| fs::metadata(path).ok())
            .and_then(|metadata| metadata.modified().ok());
        let stamp = match config_modified {
            Some(modified) if modified > now => modified,
            _ => now,
        };
        filetime::set_file_mtime(&marker, filetime::FileTime::from_system_time(stamp))
    }

    /// Delete every spooled file of every tool, claimed or not, as `disable`,
    /// `reset-id` and the legacy migration do.
    pub fn delete_every_spool(&self) -> io::Result<()> {
        let tools = match fs::read_dir(self.spool_root()) {
            Ok(tools) => tools,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut failure = None;
        for tool in tools.flatten() {
            if !tool.path().is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(tool.path()) else {
                continue;
            };
            for file in files.flatten() {
                if file.path().is_file() {
                    if let Err(error) = remove_if_present(&file.path()) {
                        failure = Some(error);
                    }
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// An identifier for this process alone, when none can be read or persisted.
fn process_local_identity() -> Option<Identity> {
    Some(Identity {
        id: random::uuid_v4()?,
        created: true,
        persisted: false,
    })
}

/// The `installation_id` pattern: a version 4 UUID, canonical and lowercase.
pub fn is_installation_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Create `dir` and its parents, with mode `0700` on POSIX, when it does not exist yet.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Write `bytes` to `path`, which must not exist yet, and flush them to disk. Nothing
/// is left at `path` when this fails.
pub fn write_new_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let written = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if written.is_err() {
        let _ = fs::remove_file(path);
    }
    written
}

/// Replace `target` whole, so that a reader never sees it partial: write `bytes` under
/// `temporary`, which must not exist yet, flush them, and rename it into place.
pub fn write_atomically(temporary: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    write_new_synced(temporary, bytes)?;
    let renamed = fs::rename(temporary, target);
    if renamed.is_err() {
        let _ = fs::remove_file(temporary);
    }
    renamed
}

/// Create an empty marker file; one that exists already is left as it is.
fn create_marker(path: &Path) -> io::Result<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn minutes(count: u64) -> Duration {
    Duration::from_secs(count * 60)
}

/// Whether the file was last modified longer than `age` ago.
pub fn is_older_than(path: &Path, age: Duration) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|elapsed| elapsed > age)
}
