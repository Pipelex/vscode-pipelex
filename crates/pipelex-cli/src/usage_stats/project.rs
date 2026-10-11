//! The project setting: `[usage_stats] enabled = false` in the project's committed
//! `.pipelex/pipelex.toml`, found the way pipelex finds its project configuration.

use std::{
    fs,
    path::{Path, PathBuf},
};

use super::contract;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectSetting {
    /// No project root, no file there, or a file that leaves statistics as they are.
    NoEffect,
    /// `enabled = false`, or a file that cannot be read as the setting: it fails closed.
    Off,
}

/// Walk up from `start` to the first directory holding a project marker, stopping at
/// the home directory, which is never a project, and at the filesystem root.
pub fn project_root(start: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let start = fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
    let home = home.map(|home| fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()));
    let mut current = start.as_path();
    loop {
        if home.as_deref() == Some(current) {
            return None;
        }
        if contract::PROJECT_MARKERS
            .iter()
            .any(|marker| current.join(marker).exists())
        {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}

/// What the project's `.pipelex/pipelex.toml` says about statistics. It can only
/// turn them off: `enabled = true` has no effect.
pub fn setting(cwd: &Path, home: Option<&Path>) -> ProjectSetting {
    let Some(root) = project_root(cwd, home) else {
        return ProjectSetting::NoEffect;
    };
    let file = root.join(".pipelex").join("pipelex.toml");
    if !file.exists() {
        return ProjectSetting::NoEffect;
    }
    let Ok(text) = fs::read_to_string(&file) else {
        return ProjectSetting::Off;
    };
    read_setting(&text)
}

/// The setting a `pipelex.toml` text holds.
pub fn read_setting(text: &str) -> ProjectSetting {
    let Ok(table) = text.parse::<toml::Table>() else {
        return ProjectSetting::Off;
    };
    match table.get("usage_stats") {
        None => ProjectSetting::NoEffect,
        Some(toml::Value::Table(section)) => match section.get("enabled") {
            None | Some(toml::Value::Boolean(true)) => ProjectSetting::NoEffect,
            Some(toml::Value::Boolean(false)) => ProjectSetting::Off,
            Some(_) => ProjectSetting::Off,
        },
        Some(_) => ProjectSetting::Off,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setting_fails_closed() {
        assert_eq!(
            read_setting("[usage_stats]\nenabled = false\n"),
            ProjectSetting::Off
        );
        assert_eq!(
            read_setting("[usage_stats]\nenabled = true\n"),
            ProjectSetting::NoEffect
        );
        assert_eq!(read_setting("[usage_stats]\n"), ProjectSetting::NoEffect);
        assert_eq!(
            read_setting("[other]\nenabled = false\n"),
            ProjectSetting::NoEffect
        );
        assert_eq!(read_setting(""), ProjectSetting::NoEffect);
        assert_eq!(
            read_setting("[usage_stats\nenabled = \n"),
            ProjectSetting::Off
        );
        assert_eq!(
            read_setting("[usage_stats]\nenabled = \"no\"\n"),
            ProjectSetting::Off
        );
        assert_eq!(read_setting("usage_stats = false\n"), ProjectSetting::Off);
    }
}
