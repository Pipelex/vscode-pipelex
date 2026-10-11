//! What a statistics decision reads from the process: its environment, its home
//! directory and its working directory, captured once so that tests can build one
//! by hand.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use super::contract;

#[derive(Debug, Clone, Default)]
pub struct Context {
    vars: HashMap<String, String>,
    home: Option<PathBuf>,
    cwd: Option<PathBuf>,
}

impl Context {
    /// The running process's view. Variables that are not valid Unicode are left
    /// out, since no switch can be spelled with them.
    pub fn from_process() -> Self {
        let vars = std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect::<HashMap<_, _>>();
        let home_variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let home = vars
            .get(home_variable)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Self {
            vars,
            home,
            cwd: std::env::current_dir().ok(),
        }
    }

    /// A context built from explicit parts, for tests.
    pub fn new(vars: HashMap<String, String>, home: Option<PathBuf>, cwd: Option<PathBuf>) -> Self {
        Self { vars, home, cwd }
    }

    pub fn var(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    pub fn cwd(&self) -> Option<&Path> {
        self.cwd.as_deref()
    }

    /// `~/.mthds/usage-stats`, shared by every reporting tool on the machine.
    pub fn state_dir(&self) -> Option<PathBuf> {
        let home = self.home.as_ref()?;
        Some(
            contract::STATE_DIRECTORY
                .iter()
                .fold(home.clone(), |path, part| path.join(part)),
        )
    }

    /// `~/.mthds/config`, where today's `mthds` CLI keeps its opt-out.
    pub fn legacy_config(&self) -> Option<PathBuf> {
        let home = self.home.as_ref()?;
        Some(
            contract::LEGACY_CONFIG
                .iter()
                .fold(home.clone(), |path, part| path.join(part)),
        )
    }

    /// Whether a variable read the way `DO_NOT_TRACK` is read is on: set to anything
    /// but the empty string, `0` or `false`, trimmed and with case ignored.
    pub fn flag_is_on(&self, name: &str) -> bool {
        match self.var(name) {
            None => false,
            Some(value) => !contract::FALSY_VALUES.contains(&normalized(value).as_str()),
        }
    }
}

/// A switch value as every switch reads it: surrounding whitespace removed, case ignored.
pub fn normalized(value: &str) -> String {
    value.trim().to_lowercase()
}
