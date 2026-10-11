//! The switches that turn statistics off, read in the contract's order, and the
//! migration of today's `mthds` opt-out into the shared state.

use std::{fs, io, path::Path, time::SystemTime};

use super::{
    context::{normalized, Context},
    contract, project,
    state::StateDir,
};

/// A switch saying off, by the token `status` prints for it. The order of the
/// variants is the order of the contract, which `status` keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum OffBy {
    DoNotTrack,
    ToolVariable,
    MachineChoice,
    LegacyMthdsChoice,
    ProjectSetting,
    InvalidEndpointOverride,
}

impl OffBy {
    pub fn token(self) -> &'static str {
        match self {
            OffBy::DoNotTrack => "do_not_track",
            OffBy::ToolVariable => "tool_variable",
            OffBy::MachineChoice => "machine_choice",
            OffBy::LegacyMthdsChoice => "legacy_mthds_choice",
            OffBy::ProjectSetting => "project_setting",
            OffBy::InvalidEndpointOverride => "invalid_endpoint_override",
        }
    }
}

/// Where events are posted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// PostHog's capture host.
    Default,
    /// A loopback origin the test-only override names.
    Loopback(String),
    /// The override names anything else, which turns statistics off.
    Invalid,
}

impl Endpoint {
    pub fn from_context(context: &Context) -> Self {
        match context.var(contract::ENV_ENDPOINT_OVERRIDE) {
            None => Endpoint::Default,
            Some(value) => match loopback_origin(value) {
                Some(origin) => Endpoint::Loopback(origin),
                None => Endpoint::Invalid,
            },
        }
    }

    /// The origin to post to, or `None` when the override is invalid.
    pub fn origin(&self) -> Option<&str> {
        match self {
            Endpoint::Default => Some(contract::CAPTURE_HOST),
            Endpoint::Loopback(origin) => Some(origin),
            Endpoint::Invalid => None,
        }
    }
}

/// `http://127.0.0.1:<port>`, `http://localhost:<port>` or `http://[::1]:<port>`,
/// with no path, taken verbatim. Unlike a switch value, the override is not trimmed,
/// and a trailing slash is a path: either makes it invalid, as it is for pipelex and
/// `mthds`, so the same value sends from every tool or from none.
fn loopback_origin(value: &str) -> Option<String> {
    let rest = value.strip_prefix("http://")?;
    let port = ["127.0.0.1:", "localhost:", "[::1]:"]
        .iter()
        .find_map(|host| rest.strip_prefix(host))?;
    if port.is_empty() || port.len() > 5 || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match port.parse::<u32>() {
        Ok(number) if (1..=65535).contains(&number) => Some(value.to_string()),
        _ => None,
    }
}

/// What `PIPELEX_USAGE_STATS` says: off for the off values, no effect for the
/// no-effect values and when unset, and off, failing closed, for anything else.
fn tool_variable_says_off(context: &Context) -> bool {
    match context.var(contract::ENV_TOOL_SWITCH) {
        None => false,
        Some(value) => {
            let value = normalized(value);
            if contract::TOOL_SWITCH_NO_EFFECT_VALUES.contains(&value.as_str()) {
                false
            } else {
                // The off values, and any value nobody can read.
                true
            }
        }
    }
}

/// Every switch that says off, in the contract's order. Read-only: it migrates
/// nothing and creates nothing, so `status` can call it.
pub fn read(context: &Context, state: Option<&StateDir>) -> Vec<OffBy> {
    let mut off_by = Vec::new();
    if context.flag_is_on(contract::ENV_DO_NOT_TRACK) {
        off_by.push(OffBy::DoNotTrack);
    }
    if tool_variable_says_off(context) {
        off_by.push(OffBy::ToolVariable);
    }
    if state.is_some_and(StateDir::is_disabled) {
        off_by.push(OffBy::MachineChoice);
    }
    if legacy_choice_pending(context, state) {
        off_by.push(OffBy::LegacyMthdsChoice);
    }
    if let Some(cwd) = context.cwd() {
        if project::setting(cwd, context.home()) == project::ProjectSetting::Off {
            off_by.push(OffBy::ProjectSetting);
        }
    }
    if Endpoint::from_context(context) == Endpoint::Invalid {
        off_by.push(OffBy::InvalidEndpointOverride);
    }
    off_by
}

/// Whether `~/.mthds/config` says `DISABLE_TELEMETRY` is on.
fn legacy_says_off(legacy_config: &Path) -> bool {
    let Ok(content) = fs::read_to_string(legacy_config) else {
        return false;
    };
    match legacy_value(&content) {
        Some(value) => contract::LEGACY_DISABLE_ON_VALUES.contains(&normalized(&value).as_str()),
        None => false,
    }
}

/// The value of `DISABLE_TELEMETRY` in the config file's dialect: `KEY=value` lines
/// split on `\n` alone, trimmed, whole-line `#` comments, the first `=` separating,
/// and the last occurrence of a key winning.
pub fn legacy_value(content: &str) -> Option<String> {
    let mut found = None;
    for line in content.split('\n') {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == contract::LEGACY_KEY {
            found = Some(value.trim().to_string());
        }
    }
    found
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

/// Whether the legacy opt-out says off and is newer than the `legacy-migrated`
/// marker (or the marker does not exist), so that the next migration takes it.
fn legacy_choice_pending(context: &Context, state: Option<&StateDir>) -> bool {
    let Some(legacy_config) = context.legacy_config() else {
        return false;
    };
    if !legacy_says_off(&legacy_config) {
        return false;
    }
    let Some(config_modified) = modified(&legacy_config) else {
        return false;
    };
    match state.and_then(StateDir::legacy_marker_modified) {
        None => true,
        Some(marker_modified) => config_modified > marker_modified,
    }
}

/// Carry today's `mthds` opt-out into the shared state: when it says off and is
/// newer than the marker, create `disabled`, delete every tool's spool, and move the
/// marker to the later of now and the config file's modification time. Every
/// reporting process runs it before reading any other switch, and every sender
/// before each post. Answers whether it migrated.
pub fn run_legacy_migration(context: &Context, state: &StateDir) -> io::Result<bool> {
    if !legacy_choice_pending(context, Some(state)) {
        return Ok(false);
    }
    state.create_disabled()?;
    state.delete_every_spool()?;
    state.mark_legacy_migrated(context.legacy_config().as_deref())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn context(vars: &[(&str, &str)]) -> Context {
        let vars = vars
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect::<HashMap<_, _>>();
        Context::new(vars, None, None)
    }

    #[test]
    fn do_not_track_reads_falsy_values_as_no_effect() {
        for value in ["", "0", "false", " FALSE ", " 0 "] {
            assert!(
                read(&context(&[("DO_NOT_TRACK", value)]), None).is_empty(),
                "{value:?}"
            );
        }
        for value in ["1", "true", " TRUE ", "yes", "anything"] {
            assert_eq!(
                read(&context(&[("DO_NOT_TRACK", value)]), None),
                vec![OffBy::DoNotTrack],
                "{value:?}"
            );
        }
    }

    #[test]
    fn tool_variable_fails_closed() {
        for value in ["0", "false", "no", "off", " OFF ", "maybe"] {
            assert_eq!(
                read(&context(&[("PIPELEX_USAGE_STATS", value)]), None),
                vec![OffBy::ToolVariable],
                "{value:?}"
            );
        }
        for value in ["", "1", "true", "yes", "on", " ON "] {
            assert!(
                read(&context(&[("PIPELEX_USAGE_STATS", value)]), None).is_empty(),
                "{value:?}"
            );
        }
    }

    #[test]
    fn endpoint_override_accepts_loopback_origins_only() {
        for value in [
            "http://127.0.0.1:9",
            "http://localhost:8080",
            "http://[::1]:443",
        ] {
            assert_eq!(
                Endpoint::from_context(&context(&[(contract::ENV_ENDPOINT_OVERRIDE, value)])),
                Endpoint::Loopback(value.to_string()),
                "{value:?}"
            );
        }
        for value in [
            "",
            "https://example.com",
            "https://127.0.0.1:9",
            "http://127.0.0.1",
            "http://127.0.0.1:9/",
            "http://localhost:8080/",
            "http://127.0.0.1:9/batch/",
            " http://127.0.0.1:9",
            "http://127.0.0.1:9 ",
            "http://127.0.0.1:9\n",
            "HTTP://127.0.0.1:9",
            "http://LOCALHOST:9",
            "http://127.0.0.1:0",
            "http://127.0.0.1:70000",
            "http://127.0.0.2:9",
            "http://localhost.example.com:9",
        ] {
            assert_eq!(
                Endpoint::from_context(&context(&[(contract::ENV_ENDPOINT_OVERRIDE, value)])),
                Endpoint::Invalid,
                "{value:?}"
            );
        }
        assert_eq!(Endpoint::from_context(&context(&[])), Endpoint::Default);
    }

    #[test]
    fn legacy_value_follows_the_config_dialect() {
        assert_eq!(legacy_value("DISABLE_TELEMETRY=1\n"), Some("1".into()));
        assert_eq!(
            legacy_value("  DISABLE_TELEMETRY = true  \r\n"),
            Some("true".into())
        );
        assert_eq!(legacy_value("# DISABLE_TELEMETRY=1\n"), None);
        assert_eq!(
            legacy_value("DISABLE_TELEMETRY=1\nDISABLE_TELEMETRY=0\n"),
            Some("0".into())
        );
        assert_eq!(legacy_value("OTHER=1\nDISABLE_TELEMETRY\n"), None);
        assert_eq!(legacy_value("disable_telemetry=1\n"), None);
    }
}
