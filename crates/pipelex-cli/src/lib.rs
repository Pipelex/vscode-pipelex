use taplo_common::environment::Environment;

pub mod args;
pub mod commands;
#[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
pub mod usage_stats;

pub struct PlxtCli<E: Environment> {
    pub(crate) inner: taplo_cli::Taplo<E>,
    pub(crate) colors: bool,
    pub(crate) env: E,
}

impl<E: Environment> PlxtCli<E> {
    pub fn new(env: E) -> Self {
        let colors = env.atty_stderr();
        Self {
            inner: taplo_cli::Taplo::new(env.clone()),
            colors,
            env,
        }
    }

    /// What the commands run so far processed: documents and diagnostics by kind.
    pub fn run_stats(&self) -> taplo_cli::RunStats {
        self.inner.run_stats()
    }
}
