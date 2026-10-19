//! The one event `plxt` sends, `command_completed`, in the envelope PostHog receives.
//!
//! Every value is an enum value, a count or one of the contract's own identifiers:
//! no path, argument, key, message or other free text can reach an event.

use serde_json::{json, Map, Value};

use super::{contract, random};

pub const COMMAND_COMPLETED: &str = "command_completed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed,
    Cancelled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Succeeded => "succeeded",
            Outcome::Failed => "failed",
            Outcome::Cancelled => "cancelled",
        }
    }
}

/// The error a failed command names: a code of the MTHDS problem registry, and
/// the domain the registry gives it, who must act on it. `plxt` names only the
/// faults its own diagnostics find in a method file, so every code it sends is
/// a core code of the `method` family; the tests hold each one to the vendored
/// core registry (`test-data/mthds-error-registry.json`). A fault in plain
/// TOML, such as a `Cargo.toml`, names no error: the registry has no code for
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorCode {
    pub code: &'static str,
    pub domain: &'static str,
}

impl ErrorCode {
    /// A file that does not parse: a syntax error, or a semantic one such as a
    /// duplicate key or conflicting tables, which make it invalid TOML.
    pub const METHOD_SYNTAX: ErrorCode = ErrorCode {
        code: "method.syntax",
        domain: "method",
    };
    /// A file that parses but breaks its JSON Schema: the MTHDS schema, for a
    /// `.mthds` file.
    pub const METHOD_SCHEMA_VIOLATION: ErrorCode = ErrorCode {
        code: "method.schema_violation",
        domain: "method",
    };
    /// Every code `plxt` sends.
    pub const ALL: [ErrorCode; 2] = [ErrorCode::METHOD_SYNTAX, ErrorCode::METHOD_SCHEMA_VIOLATION];

    /// The error a command's diagnostics on method files name, given their
    /// counts by kind, or `None` when it found none there, in which case `plxt`
    /// cannot say what failed: a syntax or semantic error before a schema one,
    /// since a file that does not parse is never checked against its schema.
    /// A failure on plain TOML alone names none, and neither does a
    /// `format --check` that found unformatted files and nothing else, as the
    /// registry has no code for a file that is valid but not formatted.
    pub fn of_diagnostics(syntax: usize, semantic: usize, schema: usize) -> Option<ErrorCode> {
        if syntax + semantic > 0 {
            Some(ErrorCode::METHOD_SYNTAX)
        } else if schema > 0 {
            Some(ErrorCode::METHOD_SCHEMA_VIOLATION)
        } else {
            None
        }
    }
}

/// The common properties, computed once per process.
#[derive(Debug, Clone)]
pub struct Common {
    pub host: Option<&'static str>,
    pub id_new: bool,
    pub os: &'static str,
    pub arch: &'static str,
    pub ci: bool,
    pub container: bool,
    pub internal: bool,
    pub notice_version: u32,
}

/// What a command did, in the properties `command_completed` carries for `plxt`.
#[derive(Debug, Clone)]
pub struct CommandCompleted {
    pub command: &'static str,
    pub outcome: Outcome,
    /// The error the command's diagnostics name, sent as `error_code` and
    /// `error_domain` when the command failed; absent when `plxt` cannot say.
    pub error: Option<ErrorCode>,
    pub duration_ms: u64,
    pub files: usize,
    pub invocation: &'static str,
    pub diagnostics_syntax: usize,
    pub diagnostics_semantic: usize,
    pub diagnostics_schema: usize,
}

/// `files_bucket`: how many files were processed, in buckets.
pub fn files_bucket(files: usize) -> &'static str {
    match files {
        0 => "0",
        1 => "1",
        2..=10 => "2-10",
        11..=100 => "11-100",
        101..=1000 => "101-1000",
        _ => "1001+",
    }
}

fn capped(count: usize, max: u64) -> u64 {
    (count as u64).min(max)
}

fn common_properties(common: &Common) -> Map<String, Value> {
    let mut properties = Map::new();
    properties.insert("schema".into(), json!(contract::SCHEMA_VERSION));
    properties.insert("tool".into(), json!(contract::TOOL));
    properties.insert("tool_version".into(), json!(contract::TOOL_VERSION));
    properties.insert("surface".into(), json!(contract::SURFACE));
    if let Some(host) = common.host {
        properties.insert("host".into(), json!(host));
    }
    properties.insert("id_new".into(), json!(common.id_new));
    properties.insert("os".into(), json!(common.os));
    properties.insert("arch".into(), json!(common.arch));
    properties.insert("ci".into(), json!(common.ci));
    properties.insert("container".into(), json!(common.container));
    properties.insert("internal".into(), json!(common.internal));
    properties.insert("notice_version".into(), json!(common.notice_version));
    properties.insert(contract::PERSON_PROFILE_PROPERTY.into(), json!(false));
    properties
}

/// The envelope of one `command_completed`, its `uuid` and `timestamp` fixed now,
/// or `None` when no random identifier can be drawn.
pub fn command_completed(
    distinct_id: &str,
    common: &Common,
    command: &CommandCompleted,
) -> Option<Value> {
    let mut properties = common_properties(common);
    properties.insert("command".into(), json!(command.command));
    properties.insert("outcome".into(), json!(command.outcome.as_str()));
    if command.outcome == Outcome::Failed {
        if let Some(error) = command.error {
            properties.insert("error_code".into(), json!(error.code));
            properties.insert("error_domain".into(), json!(error.domain));
        }
    }
    properties.insert(
        "duration_ms".into(),
        json!(command.duration_ms.min(contract::MAX_DURATION_MS)),
    );
    properties.insert("files_bucket".into(), json!(files_bucket(command.files)));
    properties.insert("invocation".into(), json!(command.invocation));
    properties.insert(
        "diagnostics_syntax".into(),
        json!(capped(
            command.diagnostics_syntax,
            contract::MAX_DIAGNOSTICS
        )),
    );
    properties.insert(
        "diagnostics_semantic".into(),
        json!(capped(
            command.diagnostics_semantic,
            contract::MAX_DIAGNOSTICS
        )),
    );
    properties.insert(
        "diagnostics_schema".into(),
        json!(capped(
            command.diagnostics_schema,
            contract::MAX_DIAGNOSTICS
        )),
    );
    Some(json!({
        "event": COMMAND_COMPLETED,
        "distinct_id": distinct_id,
        "uuid": random::uuid_v4()?,
        "timestamp": random::timestamp_now(),
        "properties": Value::Object(properties),
    }))
}

/// The `distinct_id` of an envelope.
pub fn distinct_id(event: &Value) -> Option<&str> {
    event.get("distinct_id").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets() {
        assert_eq!(files_bucket(0), "0");
        assert_eq!(files_bucket(1), "1");
        assert_eq!(files_bucket(2), "2-10");
        assert_eq!(files_bucket(10), "2-10");
        assert_eq!(files_bucket(11), "11-100");
        assert_eq!(files_bucket(1000), "101-1000");
        assert_eq!(files_bucket(1001), "1001+");
    }

    #[test]
    fn diagnostics_name_their_error() {
        assert_eq!(ErrorCode::of_diagnostics(0, 0, 0), None);
        assert_eq!(
            ErrorCode::of_diagnostics(1, 0, 0),
            Some(ErrorCode::METHOD_SYNTAX)
        );
        assert_eq!(
            ErrorCode::of_diagnostics(0, 2, 0),
            Some(ErrorCode::METHOD_SYNTAX)
        );
        assert_eq!(
            ErrorCode::of_diagnostics(0, 0, 3),
            Some(ErrorCode::METHOD_SCHEMA_VIOLATION)
        );
        // A file that does not parse is never checked against its schema, so
        // the syntax error is the one named.
        assert_eq!(
            ErrorCode::of_diagnostics(1, 0, 3),
            Some(ErrorCode::METHOD_SYNTAX)
        );
    }
}
