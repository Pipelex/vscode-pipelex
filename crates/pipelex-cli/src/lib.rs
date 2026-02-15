use taplo_common::environment::Environment;

pub mod args;
pub mod commands;

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
}
