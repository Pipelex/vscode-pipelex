//! [`NullEnvironment`] — an [`Environment`] with no clock, no filesystem, no
//! processes, no JS host.
//!
//! The offline lint path needs an `Environment` only because
//! `taplo_common::schema::Schemas` is generic over one: on that path the
//! environment is consulted for nothing but [`Environment::now`] (the schema
//! cache's LRU expiry bookkeeping — no cache path is ever set, so no IO
//! happens). This stub exists so the wasm binding (`pipelex-tools-wasm`) can
//! run lint without the JS callback object the LSP-oriented `WasmEnvironment`
//! requires — and so the very same environment can be exercised in native
//! tests, proving the wasm code path agrees with the native one.
//!
//! Every capability the offline path genuinely cannot need is explicit about
//! being absent: filesystem and stdio accessors return errors or empty
//! streams, and task spawning — which would silently drop work if stubbed as a
//! no-op — panics instead.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use taplo_common::environment::Environment;
use time::OffsetDateTime;
use url::Url;

/// A capability-less [`Environment`] for the offline lint/format engine.
#[derive(Debug, Clone, Copy, Default)]
pub struct NullEnvironment;

#[async_trait(?Send)]
impl Environment for NullEnvironment {
    type Stdin = tokio::io::Empty;
    type Stdout = tokio::io::Sink;
    type Stderr = tokio::io::Sink;

    fn now(&self) -> OffsetDateTime {
        // A fixed clock keeps the schema cache's LRU expiry arithmetic
        // deterministic ("never expired") and needs no host time source.
        OffsetDateTime::UNIX_EPOCH
    }

    fn spawn<F>(&self, _fut: F)
    where
        F: futures::Future + Send + 'static,
        F::Output: Send,
    {
        // Dropping the future silently would be a silent failure; nothing on
        // the offline lint/format path spawns, so reaching this is a bug.
        panic!("NullEnvironment cannot spawn tasks");
    }

    fn spawn_local<F>(&self, _fut: F)
    where
        F: futures::Future + 'static,
    {
        panic!("NullEnvironment cannot spawn tasks");
    }

    fn env_var(&self, _name: &str) -> Option<String> {
        None
    }

    fn env_vars(&self) -> Vec<(String, String)> {
        Vec::new()
    }

    fn atty_stderr(&self) -> bool {
        false
    }

    fn stdin(&self) -> Self::Stdin {
        tokio::io::empty()
    }

    fn stdout(&self) -> Self::Stdout {
        tokio::io::sink()
    }

    fn stderr(&self) -> Self::Stderr {
        tokio::io::sink()
    }

    fn glob_files(&self, _glob: &str) -> Result<Vec<PathBuf>, anyhow::Error> {
        Err(anyhow::anyhow!(
            "NullEnvironment has no filesystem (glob_files)"
        ))
    }

    async fn read_file(&self, _path: &Path) -> Result<Vec<u8>, anyhow::Error> {
        Err(anyhow::anyhow!(
            "NullEnvironment has no filesystem (read_file)"
        ))
    }

    async fn write_file(&self, _path: &Path, _bytes: &[u8]) -> Result<(), anyhow::Error> {
        Err(anyhow::anyhow!(
            "NullEnvironment has no filesystem (write_file)"
        ))
    }

    fn to_file_path(&self, _url: &Url) -> Option<PathBuf> {
        None
    }

    fn is_absolute(&self, path: &Path) -> bool {
        path.is_absolute()
    }

    fn cwd(&self) -> Option<PathBuf> {
        None
    }

    async fn find_config_file(&self, _from: &Path) -> Option<PathBuf> {
        None
    }
}
