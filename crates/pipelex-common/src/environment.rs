use std::path::{Path, PathBuf};

use async_trait::async_trait;
use taplo_common::environment::Environment;
use time::OffsetDateTime;
use url::Url;

use crate::config::PIPELEX_CONFIG_FILE_NAMES;

/// An environment wrapper that searches for `.pipelex/plxt.toml` or `plxt.toml`
/// before falling back to the inner environment's config file discovery
/// (which looks for `.taplo.toml` / `taplo.toml`).
#[derive(Clone)]
pub struct MthdsEnvironment<E: Environment> {
    inner: E,
}

impl<E: Environment> MthdsEnvironment<E> {
    pub fn new(inner: E) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &E {
        &self.inner
    }
}

#[async_trait(?Send)]
impl<E: Environment> Environment for MthdsEnvironment<E> {
    type Stdin = E::Stdin;
    type Stdout = E::Stdout;
    type Stderr = E::Stderr;

    fn now(&self) -> OffsetDateTime {
        self.inner.now()
    }

    fn spawn<F>(&self, fut: F)
    where
        F: futures::Future + Send + 'static,
        F::Output: Send,
    {
        self.inner.spawn(fut);
    }

    fn spawn_local<F>(&self, fut: F)
    where
        F: futures::Future + 'static,
    {
        self.inner.spawn_local(fut);
    }

    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }

    fn env_vars(&self) -> Vec<(String, String)> {
        self.inner.env_vars()
    }

    fn atty_stderr(&self) -> bool {
        self.inner.atty_stderr()
    }

    fn stdin(&self) -> Self::Stdin {
        self.inner.stdin()
    }

    fn stdout(&self) -> Self::Stdout {
        self.inner.stdout()
    }

    fn stderr(&self) -> Self::Stderr {
        self.inner.stderr()
    }

    fn glob_files(&self, glob: &str) -> Result<Vec<PathBuf>, anyhow::Error> {
        self.inner.glob_files(glob)
    }

    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, anyhow::Error> {
        self.inner.read_file(path).await
    }

    async fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), anyhow::Error> {
        self.inner.write_file(path, bytes).await
    }

    fn to_file_path(&self, url: &Url) -> Option<PathBuf> {
        self.inner.to_file_path(url)
    }

    fn is_absolute(&self, path: &Path) -> bool {
        self.inner.is_absolute(path)
    }

    fn cwd(&self) -> Option<PathBuf> {
        self.inner.cwd()
    }

    fn is_config_file(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy();
        let is_pipelex = PIPELEX_CONFIG_FILE_NAMES
            .iter()
            .any(|name| path_str.ends_with(name));
        is_pipelex || self.inner.is_config_file(path)
    }

    async fn find_config_file(&self, from: &Path) -> Option<PathBuf> {
        // Walk directories upward looking for pipelex config files first.
        let mut p = from;
        loop {
            for name in PIPELEX_CONFIG_FILE_NAMES {
                let candidate = p.join(name);
                if self.inner.read_file(&candidate).await.is_ok() {
                    return Some(candidate);
                }
            }

            match p.parent() {
                Some(parent) => p = parent,
                None => break,
            }
        }

        // Fall back to the inner environment's config discovery (.taplo.toml).
        self.inner.find_config_file(from).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A minimal mock environment for testing config file discovery.
    #[derive(Clone)]
    struct MockEnv {
        files: Vec<PathBuf>,
    }

    #[async_trait(?Send)]
    impl Environment for MockEnv {
        type Stdin = tokio::io::Empty;
        type Stdout = tokio::io::Sink;
        type Stderr = tokio::io::Sink;

        fn now(&self) -> OffsetDateTime {
            OffsetDateTime::now_utc()
        }
        fn spawn<F>(&self, _fut: F)
        where
            F: futures::Future + Send + 'static,
            F::Output: Send,
        {
        }
        fn spawn_local<F>(&self, _fut: F)
        where
            F: futures::Future + 'static,
        {
        }
        fn env_var(&self, _name: &str) -> Option<String> {
            None
        }
        fn env_vars(&self) -> Vec<(String, String)> {
            vec![]
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
            Ok(vec![])
        }
        async fn read_file(&self, path: &Path) -> Result<Vec<u8>, anyhow::Error> {
            if self.files.contains(&path.to_path_buf()) {
                Ok(vec![])
            } else {
                Err(anyhow::anyhow!("file not found: {}", path.display()))
            }
        }
        async fn write_file(&self, _path: &Path, _bytes: &[u8]) -> Result<(), anyhow::Error> {
            Ok(())
        }
        fn to_file_path(&self, url: &Url) -> Option<PathBuf> {
            url.to_file_path().ok()
        }
        fn is_absolute(&self, path: &Path) -> bool {
            path.is_absolute()
        }
        fn cwd(&self) -> Option<PathBuf> {
            Some(PathBuf::from("/"))
        }
        async fn find_config_file(&self, from: &Path) -> Option<PathBuf> {
            // Simulate taplo's behavior: walk up looking for .taplo.toml
            let taplo_names = [".taplo.toml", "taplo.toml"];
            let mut p = from;
            loop {
                for name in &taplo_names {
                    let candidate = p.join(name);
                    if self.files.contains(&candidate) {
                        return Some(candidate);
                    }
                }
                match p.parent() {
                    Some(parent) => p = parent,
                    None => return None,
                }
            }
        }
    }

    #[tokio::test]
    async fn pipelex_config_takes_priority() {
        let env = MockEnv {
            files: vec![
                PathBuf::from("/project/.pipelex/plxt.toml"),
                PathBuf::from("/project/.taplo.toml"),
            ],
        };
        let mthds = MthdsEnvironment::new(env);
        let result = mthds.find_config_file(Path::new("/project")).await;
        assert_eq!(
            result,
            Some(PathBuf::from("/project/.pipelex/plxt.toml"))
        );
    }

    #[tokio::test]
    async fn falls_back_to_taplo_config() {
        let env = MockEnv {
            files: vec![PathBuf::from("/project/.taplo.toml")],
        };
        let mthds = MthdsEnvironment::new(env);
        let result = mthds.find_config_file(Path::new("/project")).await;
        assert_eq!(result, Some(PathBuf::from("/project/.taplo.toml")));
    }

    #[tokio::test]
    async fn pipelex_config_in_parent() {
        let env = MockEnv {
            files: vec![PathBuf::from("/project/.pipelex/plxt.toml")],
        };
        let mthds = MthdsEnvironment::new(env);
        let result = mthds
            .find_config_file(Path::new("/project/sub/dir"))
            .await;
        assert_eq!(
            result,
            Some(PathBuf::from("/project/.pipelex/plxt.toml"))
        );
    }

    #[tokio::test]
    async fn no_config_found() {
        let env = MockEnv { files: vec![] };
        let mthds = MthdsEnvironment::new(env);
        let result = mthds.find_config_file(Path::new("/project")).await;
        assert_eq!(result, None);
    }

    #[test]
    fn is_config_file_pipelex() {
        let env = MockEnv { files: vec![] };
        let mthds = MthdsEnvironment::new(env);
        assert!(mthds.is_config_file(Path::new("/project/.pipelex/plxt.toml")));
    }

    #[test]
    fn is_config_file_taplo() {
        let env = MockEnv { files: vec![] };
        let mthds = MthdsEnvironment::new(env);
        assert!(mthds.is_config_file(Path::new("/project/.taplo.toml")));
        assert!(mthds.is_config_file(Path::new("/project/taplo.toml")));
    }

    #[test]
    fn is_config_file_rejects_regular_toml() {
        let env = MockEnv { files: vec![] };
        let mthds = MthdsEnvironment::new(env);
        assert!(!mthds.is_config_file(Path::new("/project/Cargo.toml")));
        assert!(!mthds.is_config_file(Path::new("/project/pyproject.toml")));
        assert!(!mthds.is_config_file(Path::new("/project/config.toml")));
    }

    #[tokio::test]
    async fn plxt_config_at_root() {
        let env = MockEnv {
            files: vec![PathBuf::from("/project/plxt.toml")],
        };
        let mthds = MthdsEnvironment::new(env);
        let result = mthds.find_config_file(Path::new("/project")).await;
        assert_eq!(result, Some(PathBuf::from("/project/plxt.toml")));
    }

    #[tokio::test]
    async fn plxt_in_subdir_takes_priority() {
        let env = MockEnv {
            files: vec![
                PathBuf::from("/project/.pipelex/plxt.toml"),
                PathBuf::from("/project/plxt.toml"),
            ],
        };
        let mthds = MthdsEnvironment::new(env);
        let result = mthds.find_config_file(Path::new("/project")).await;
        assert_eq!(
            result,
            Some(PathBuf::from("/project/.pipelex/plxt.toml"))
        );
    }
}
