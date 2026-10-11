//! `plxt`'s side of the usage-statistics contract (conformance's
//! `specs/usage-statistics.md`), checked against the schema this repository vendors
//! byte for byte at `test-data/usage-statistics.json`.
//!
//! Every binary run here happens in a throwaway home directory with a cleared
//! environment and `PIPELEX_USAGE_STATS_ENDPOINT` pointing at a loopback address,
//! either a port nothing listens on or the capture server below, so no test ever
//! posts to PostHog or touches the developer's own `~/.mthds/usage-stats/`.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clap::Parser;
use pipelex_cli::{
    args::PlxtArgs,
    usage_stats::{
        contract,
        event::{self, CommandCompleted, Common, Outcome},
        sender,
    },
};
use regex::Regex;
use serde_json::{json, Value};

/// A change that makes a valid event invalid, for checking the gate check itself.
type Mutation = Box<dyn Fn(&mut Value)>;
/// Environment variables a run adds to its cleared environment.
type Vars<'a> = &'a [(&'a str, &'a str)];

/// A loopback address nothing listens on: a post to it fails at once.
const UNREACHABLE_ENDPOINT: &str = "http://127.0.0.1:9";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should resolve")
}

fn schema() -> Value {
    let text = fs::read_to_string(repo_root().join("test-data/usage-statistics.json"))
        .expect("the vendored schema should be readable");
    serde_json::from_str(&text).expect("the vendored schema should be JSON")
}

// ── The gate ────────────────────────────────────────────────────────────────

/// The checks the PostHog gate applies to an event, read from the schema the way
/// conformance's reference evaluator (`conformance/usage_stats/gate.py`) reads it.
/// Answers the first reason the gate would drop the event.
fn gate(schema: &Value, envelope: &Value) -> Result<(), String> {
    let name = envelope["event"].as_str().ok_or("the event has no name")?;
    let event_spec = schema["events"]
        .get(name)
        .ok_or_else(|| format!("undeclared event {name}"))?;
    let properties = envelope["properties"]
        .as_object()
        .ok_or("properties are not an object")?;

    for (field, rule) in schema["envelope"]["fields"].as_object().unwrap() {
        let pattern = rule["pattern"].as_str().unwrap();
        match envelope.get(field).and_then(Value::as_str) {
            Some(value) if pattern_matches(schema, pattern, value) => {}
            _ => return Err(format!("envelope field {field} is not a {pattern}")),
        }
    }
    for field in schema["envelope"]["empty_fields"]
        .as_object()
        .unwrap()
        .keys()
    {
        match envelope.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) if text.is_empty() => {}
            Some(_) => return Err(format!("envelope field {field} is not empty")),
        }
    }

    let profile = schema["person_profile_property"].as_str().unwrap();
    let is_deletion = event_spec["person_profile"] == "deletion";
    if properties.get(profile) != Some(&Value::Bool(is_deletion)) {
        return Err(format!("{profile} must be {is_deletion}"));
    }
    let tools = event_spec["tools"].as_array().unwrap();
    if !tools.is_empty()
        && !properties
            .get("tool")
            .is_some_and(|tool| tools.contains(tool))
    {
        return Err("the tool may not send this event".into());
    }

    let mut declared = serde_json::Map::new();
    if event_spec["common"] == true {
        declared.extend(schema["common_properties"].as_object().unwrap().clone());
    }
    declared.extend(event_spec["properties"].as_object().unwrap().clone());
    let added = schema["posthog_added_properties"].as_object().unwrap();

    for (name, value) in properties {
        if name == profile {
            continue;
        }
        let Some(rule) = declared.get(name) else {
            if added.contains_key(name) {
                continue;
            }
            return Err(format!("undeclared property {name}"));
        };
        if let Some(condition) = rule.get("when") {
            if !condition_holds(condition, properties) {
                return Err(format!("{name} is not allowed here"));
            }
        }
        if !value_is_valid(schema, rule, value, properties) {
            return Err(format!("invalid value for {name}: {value}"));
        }
    }
    for (name, rule) in &declared {
        if rule["required"] != true || properties.get(name).is_some_and(|value| !value.is_null()) {
            continue;
        }
        if rule
            .get("when")
            .map_or(true, |condition| condition_holds(condition, properties))
        {
            return Err(format!("missing required {name}"));
        }
    }
    Ok(())
}

fn condition_holds(condition: &Value, properties: &serde_json::Map<String, Value>) -> bool {
    let property = condition["property"].as_str().unwrap();
    properties.get(property) == Some(&condition["equals"])
}

fn value_is_valid(
    schema: &Value,
    rule: &Value,
    value: &Value,
    properties: &serde_json::Map<String, Value>,
) -> bool {
    let valid = match rule["type"].as_str().unwrap() {
        "integer" => value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && !value.is_boolean())
            .is_some_and(|number| in_bounds(rule, number)),
        "number" => value.as_f64().is_some_and(|number| in_bounds(rule, number)),
        "boolean" => value.is_boolean(),
        "enum" => {
            let allowed = match rule.get("values") {
                Some(values) => values.as_array().cloned(),
                None => {
                    let by = &rule["values_by"];
                    let selector = by["property"].as_str().unwrap();
                    properties
                        .get(selector)
                        .and_then(Value::as_str)
                        .and_then(|selected| by["values"].get(selected))
                        .and_then(Value::as_array)
                        .cloned()
                }
            };
            value.is_string() && allowed.is_some_and(|allowed| allowed.contains(value))
        }
        "pattern" => value
            .as_str()
            .is_some_and(|text| pattern_matches(schema, rule["pattern"].as_str().unwrap(), text)),
        "secret" => true,
        other => panic!("the schema names a type this test does not know: {other}"),
    };
    if !valid {
        return false;
    }
    match rule.get("fixed_when") {
        Some(fixed)
            if properties.get(fixed["property"].as_str().unwrap()) == Some(&fixed["equals"]) =>
        {
            value == &fixed["value"]
        }
        _ => true,
    }
}

fn in_bounds(rule: &Value, number: f64) -> bool {
    let min = rule["min"]
        .as_f64()
        .expect("a numeric property has a minimum");
    let max = rule["max"]
        .as_f64()
        .expect("a numeric property has a maximum");
    (min..=max).contains(&number)
}

/// A named pattern, matched as written and no longer than its maximum length in
/// UTF-16 code units, as JavaScript and Hog count a string.
fn pattern_matches(schema: &Value, name: &str, text: &str) -> bool {
    let pattern = &schema["patterns"][name];
    let regex =
        Regex::new(pattern["regex"].as_str().unwrap()).expect("the schema's patterns compile");
    let max_length = pattern["max_length"].as_u64().unwrap() as usize;
    text.encode_utf16().count() <= max_length && regex.is_match(text)
}

/// What an emitter must hold to on top of the gate: the envelope carries only the
/// fields the contract names, so no `$lib`, `sent_at`, `$set` or `$geoip_disable`.
fn assert_envelope_shape(envelope: &Value) {
    let mut keys = envelope
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        ["distinct_id", "event", "properties", "timestamp", "uuid"],
        "{envelope}"
    );
}

// ── A sandboxed home, the binary, and a capture server ──────────────────────

struct Sandbox {
    root: PathBuf,
    home: PathBuf,
    project: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "plxt-usage-stats-{name}-{}-{nanos}",
            std::process::id()
        ));
        let project = root.join("home").join("work").join("project");
        fs::create_dir_all(&project).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        let project = home.join("work").join("project");
        // A project root, so that the walk up from the working directory stops here.
        fs::create_dir_all(project.join(".git")).unwrap();
        Self {
            root,
            home,
            project,
        }
    }

    fn state_dir(&self) -> PathBuf {
        self.home.join(".mthds").join("usage-stats")
    }

    fn spool(&self) -> PathBuf {
        self.state_dir().join("spool").join("plxt")
    }

    fn spooled_files(&self) -> Vec<PathBuf> {
        fs::read_dir(self.spool())
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }

    fn write(&self, name: &str, content: &str) {
        fs::write(self.project.join(name), content).unwrap();
    }

    /// `plxt` with nothing of the developer's environment but `PATH`, in this home.
    fn plxt(&self, endpoint: &str, args: &[&str], vars: &[(&str, &str)]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_plxt"));
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env(contract::ENV_ENDPOINT_OVERRIDE, endpoint)
            .args(["--colors", "never"])
            .args(args)
            .current_dir(&self.project)
            .stdin(Stdio::null());
        if let Some(system_root) = std::env::var_os("SYSTEMROOT") {
            command.env("SYSTEMROOT", system_root);
        }
        for (name, value) in vars {
            command.env(name, value);
        }
        command.output().expect("plxt should run")
    }

    /// The events `plxt` printed under the debug variable.
    fn debug_events(&self, args: &[&str], vars: &[(&str, &str)]) -> (Output, Vec<Value>) {
        let mut vars = vars.to_vec();
        vars.push((contract::ENV_DEBUG, "1"));
        let output = self.plxt(UNREACHABLE_ENDPOINT, args, &vars);
        let events = String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter(|line| line.starts_with("{\"usage_stats_debug\""))
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["usage_stats_debug"].clone())
            .collect();
        (output, events)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A loopback HTTP server that records every request and answers with one status.
struct CaptureServer {
    origin: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
}

impl CaptureServer {
    fn start(status: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Some(request) = Self::serve(stream, status) {
                    recorded.lock().unwrap().push(request);
                }
            }
        });
        Self { origin, requests }
    }

    fn serve(mut stream: TcpStream, status: u16) -> Option<(String, Value)> {
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).ok()?;
        let mut content_length = 0;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).ok()?;
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().ok()?;
                }
            }
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).ok()?;
        let response = format!(
            "HTTP/1.1 {status} Status\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        );
        stream.write_all(response.as_bytes()).ok()?;
        let path = request_line.split_whitespace().nth(1)?.to_string();
        Some((path, serde_json::from_slice(&body).ok()?))
    }

    fn requests(&self) -> Vec<(String, Value)> {
        self.requests.lock().unwrap().clone()
    }

    fn wait_for_requests(&self, count: usize, timeout: Duration) -> Vec<(String, Value)> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let requests = self.requests();
            if requests.len() >= count {
                return requests;
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.requests()
    }
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    condition()
}

fn status_json(sandbox: &Sandbox, vars: &[(&str, &str)]) -> Value {
    let output = sandbox.plxt(
        UNREACHABLE_ENDPOINT,
        &["usage-stats", "status", "--format", "json"],
        vars,
    );
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).expect("status --format json prints JSON")
}

// ── The contract's constants ────────────────────────────────────────────────

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn the_contract_constants_follow_the_vendored_schema() {
    let schema = schema();
    assert_eq!(schema["schema_version"], json!(contract::SCHEMA_VERSION));
    assert_eq!(
        schema["destination"]["capture_host"],
        contract::CAPTURE_HOST
    );
    assert_eq!(schema["destination"]["batch_path"], contract::BATCH_PATH);
    assert_eq!(
        schema["destination"]["project_token"],
        contract::PROJECT_TOKEN
    );
    assert_eq!(
        schema["person_profile_property"],
        contract::PERSON_PROFILE_PROPERTY
    );

    let notice = &schema["notice"];
    assert_eq!(notice["version"], json!(contract::NOTICE_VERSION));
    assert_eq!(notice["text"], contract::NOTICE_TEMPLATE);
    assert_eq!(notice["details_url"], contract::NOTICE_DETAILS_URL);
    assert_eq!(
        notice["disable_commands"][contract::TOOL],
        contract::DISABLE_COMMAND
    );

    let environment = &schema["environment"];
    assert_eq!(environment["do_not_track"], contract::ENV_DO_NOT_TRACK);
    assert_eq!(environment["tool_switch"], contract::ENV_TOOL_SWITCH);
    assert_eq!(environment["debug"], contract::ENV_DEBUG);
    assert_eq!(
        environment["endpoint_override"],
        contract::ENV_ENDPOINT_OVERRIDE
    );
    assert_eq!(environment["host"], contract::ENV_HOST);

    let state = &schema["state"];
    assert_eq!(
        state["directory"],
        format!("~/{}", contract::STATE_DIRECTORY.join("/"))
    );
    assert_eq!(state["id"], contract::STATE_ID);
    assert_eq!(state["disabled"], contract::STATE_DISABLED);
    assert_eq!(state["legacy_migrated"], contract::STATE_LEGACY_MIGRATED);
    assert_eq!(state["notice_prefix"], contract::STATE_NOTICE_PREFIX);
    assert_eq!(state["internal"], contract::STATE_INTERNAL);
    assert_eq!(state["spool"], contract::STATE_SPOOL);
    assert_eq!(
        state["legacy_config"],
        format!("~/{}", contract::LEGACY_CONFIG.join("/"))
    );
    assert_eq!(state["legacy_key"], contract::LEGACY_KEY);

    let switch_values = &schema["switch_values"];
    assert_eq!(
        strings(&switch_values["falsy"]),
        owned(&contract::FALSY_VALUES)
    );
    assert_eq!(
        strings(&switch_values["tool_switch_off"]),
        owned(&contract::TOOL_SWITCH_OFF_VALUES)
    );
    assert_eq!(
        strings(&switch_values["tool_switch_no_effect"]),
        owned(&contract::TOOL_SWITCH_NO_EFFECT_VALUES)
    );
    assert_eq!(
        strings(&switch_values["mthds_disable_on"]),
        owned(&contract::LEGACY_DISABLE_ON_VALUES)
    );

    let spool = &schema["spool"];
    assert_eq!(
        spool["max_files_per_tool"],
        json!(contract::SPOOL_MAX_FILES)
    );
    assert_eq!(spool["max_age_days"], json!(contract::SPOOL_MAX_AGE_DAYS));
    assert_eq!(
        spool["stale_claim_minutes"],
        json!(contract::SPOOL_STALE_CLAIM_MINUTES)
    );
    assert_eq!(
        spool["stale_temp_minutes"],
        json!(contract::SPOOL_STALE_TEMP_MINUTES)
    );
    assert_eq!(
        schema["budgets_ms"]["cli_in_process"],
        json!(contract::BUDGET_CLI_IN_PROCESS_MS)
    );
    assert_eq!(
        schema["budgets_ms"]["detached_sender"],
        json!(contract::BUDGET_DETACHED_SENDER_MS)
    );

    assert_eq!(
        strings(&schema["ci_variables"]),
        owned(&contract::CI_VARIABLES)
    );
    let markers = &schema["container_markers"];
    assert_eq!(
        strings(&markers["files"]),
        owned(&contract::CONTAINER_FILES)
    );
    assert_eq!(
        strings(&markers["environment"]),
        owned(&contract::CONTAINER_VARIABLES)
    );
    assert_eq!(
        strings(&markers["cgroup_words"]),
        owned(&contract::CONTAINER_CGROUP_WORDS)
    );
    assert_eq!(
        strings(&schema["project_markers"]),
        owned(&contract::PROJECT_MARKERS)
    );

    let mut hosts = owned(&contract::HOST_VALUES);
    hosts.push(contract::HOST_OTHER.to_string());
    assert_eq!(
        strings(&schema["common_properties"]["host"]["values"]),
        hosts
    );

    let command_completed = &schema["events"]["command_completed"];
    assert!(strings(&command_completed["tools"]).contains(&contract::TOOL.to_string()));
    let plxt_commands = strings(
        &command_completed["properties"]["command"]["values_by"]["values"][contract::SURFACE],
    );
    assert_eq!(
        plxt_commands,
        owned(&[
            contract::COMMAND_FORMAT,
            contract::COMMAND_LINT,
            contract::COMMAND_GET,
            contract::COMMAND_CONFIG,
            "other"
        ])
    );
    assert_eq!(
        command_completed["properties"]["duration_ms"]["max"],
        json!(contract::MAX_DURATION_MS)
    );
    for kind in [
        "diagnostics_syntax",
        "diagnostics_semantic",
        "diagnostics_schema",
    ] {
        assert_eq!(
            command_completed["properties"][kind]["max"],
            json!(contract::MAX_DIAGNOSTICS)
        );
    }
    assert!(strings(
        &schema["common_properties"]["surface"]["values_by"]["values"][contract::TOOL]
    )
    .contains(&contract::SURFACE.to_string()));
}

// ── The events ──────────────────────────────────────────────────────────────

fn sample_common() -> Common {
    Common {
        host: None,
        id_new: true,
        os: "linux",
        arch: "x86_64",
        ci: false,
        container: false,
        internal: false,
        notice_version: 1,
    }
}

fn sample_command(outcome: Outcome) -> CommandCompleted {
    CommandCompleted {
        command: "lint",
        outcome,
        error_domain: Some("input"),
        duration_ms: 42,
        files: 3,
        invocation: "terminal",
        diagnostics_syntax: 1,
        diagnostics_semantic: 2,
        diagnostics_schema: 3,
    }
}

const SAMPLE_ID: &str = "0a6dccf4-9cda-44ee-b0a3-97191c19d98d";

#[test]
fn built_events_pass_the_gate() {
    let schema = schema();
    let hosts = [None, Some("cocode"), Some("mthds-agent"), Some("other")];
    for outcome in [Outcome::Succeeded, Outcome::Failed, Outcome::Cancelled] {
        for host in hosts {
            for command in ["format", "lint", "get", "config"] {
                let common = Common {
                    host,
                    ..sample_common()
                };
                let completed = CommandCompleted {
                    command,
                    ..sample_command(outcome)
                };
                let envelope = event::command_completed(SAMPLE_ID, &common, &completed).unwrap();
                assert_envelope_shape(&envelope);
                gate(&schema, &envelope).unwrap_or_else(|reason| panic!("{reason}: {envelope}"));
                let has_domain = envelope["properties"].get("error_domain").is_some();
                assert_eq!(has_domain, outcome == Outcome::Failed, "{envelope}");
            }
        }
    }
    // Counts beyond the schema's bounds are capped rather than dropped by the gate.
    let huge = CommandCompleted {
        duration_ms: u64::MAX,
        files: usize::MAX,
        diagnostics_syntax: usize::MAX,
        ..sample_command(Outcome::Failed)
    };
    let envelope = event::command_completed(SAMPLE_ID, &sample_common(), &huge).unwrap();
    gate(&schema, &envelope).unwrap_or_else(|reason| panic!("{reason}: {envelope}"));
}

#[test]
fn the_gate_check_is_not_vacuous() {
    let schema = schema();
    let valid = event::command_completed(
        SAMPLE_ID,
        &sample_common(),
        &sample_command(Outcome::Failed),
    )
    .unwrap();
    gate(&schema, &valid).unwrap();
    let broken: Vec<(&str, Mutation)> = vec![
        (
            "undeclared property",
            Box::new(|event| event["properties"]["$lib"] = json!("rust")),
        ),
        (
            "wrong enum",
            Box::new(|event| event["properties"]["command"] = json!("lsp")),
        ),
        (
            "missing required",
            Box::new(|event| {
                event["properties"]
                    .as_object_mut()
                    .unwrap()
                    .remove("files_bucket");
            }),
        ),
        (
            "condition",
            Box::new(|event| event["properties"]["outcome"] = json!("succeeded")),
        ),
        (
            "profile",
            Box::new(|event| event["properties"]["$process_person_profile"] = json!(true)),
        ),
        (
            "pattern",
            Box::new(|event| event["distinct_id"] = json!("not-an-id")),
        ),
        (
            "bounds",
            Box::new(|event| event["properties"]["notice_version"] = json!(2)),
        ),
    ];
    for (case, mutate) in broken {
        let mut event = valid.clone();
        mutate(&mut event);
        assert!(
            gate(&schema, &event).is_err(),
            "the gate should drop the {case} case: {event}"
        );
    }
}

#[test]
fn commands_report_their_canonical_names_and_aliases_resolve() {
    let schema = schema();
    let sandbox = Sandbox::new("names");
    sandbox.write("doc.toml", "a = 1\n");
    let cases: &[(&[&str], &str)] = &[
        (&["lint", "doc.toml"], "lint"),
        (&["check", "doc.toml"], "lint"),
        (&["validate", "doc.toml"], "lint"),
        (&["format", "--check", "doc.toml"], "format"),
        (&["fmt", "--check", "doc.toml"], "format"),
        (&["get", "-f", "doc.toml", "a"], "get"),
        (&["config", "default"], "config"),
        (&["cfg", "schema"], "config"),
    ];
    for (args, expected) in cases {
        let (output, events) = sandbox.debug_events(args, &[]);
        assert_eq!(events.len(), 1, "{args:?}: {output:?}");
        let envelope = &events[0];
        gate(&schema, envelope).unwrap_or_else(|reason| panic!("{args:?}: {reason}: {envelope}"));
        assert_envelope_shape(envelope);
        assert_eq!(envelope["properties"]["command"], *expected, "{args:?}");
        assert_eq!(envelope["properties"]["outcome"], "succeeded", "{args:?}");
        assert_eq!(envelope["properties"]["tool"], "plxt");
        assert_eq!(envelope["properties"]["surface"], "plxt");
        assert!(envelope["properties"].get("language_runtime").is_none());
    }
    // Under the debug variable nothing is queued.
    assert!(sandbox.spooled_files().is_empty());
}

#[test]
fn the_language_server_completions_and_the_group_report_nothing() {
    for args in [
        vec!["plxt", "lsp", "stdio"],
        vec!["plxt", "completions", "bash"],
        vec!["plxt", "usage-stats", "status"],
        vec!["plxt", sender::SENDER_SUBCOMMAND],
    ] {
        let parsed =
            PlxtArgs::try_parse_from(&args).unwrap_or_else(|error| panic!("{args:?}: {error}"));
        assert_eq!(parsed.cmd.statistics_name(), None, "{args:?}");
    }
    let sandbox = Sandbox::new("silent");
    // Every shell's completions still generate with the statistics group and the
    // hidden sender in the command tree.
    for shell in ["bash", "zsh", "fish", "powershell", "elvish"] {
        let (output, events) = sandbox.debug_events(&["completions", shell], &[]);
        assert!(output.status.success(), "{shell}: {output:?}");
        assert!(events.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains(&contract::notice_text()));
    }
    assert!(
        !sandbox.state_dir().exists(),
        "completions should not create the shared state"
    );
}

#[test]
fn diagnostics_are_counted_by_kind() {
    let schema = schema();
    let sandbox = Sandbox::new("diagnostics");
    sandbox.write("syntax.toml", "a = \n");
    sandbox.write("semantic.toml", "a = 1\na = 2\n");
    sandbox.write("clean.toml", "a = 1\n");
    fs::copy(
        repo_root().join("test-data/mthds/lint/invalid_schema.mthds"),
        sandbox.project.join("schema.mthds"),
    )
    .unwrap();
    let cases: &[(&[&str], &str, [u64; 3])] = &[
        (&["lint", "syntax.toml"], "lint", [1, 0, 0]),
        (&["lint", "semantic.toml"], "lint", [0, 1, 0]),
        (&["lint", "schema.mthds"], "lint", [0, 0, 1]),
        (
            &["lint", "syntax.toml", "semantic.toml", "clean.toml"],
            "lint",
            [1, 1, 0],
        ),
        (&["format", "--check", "syntax.toml"], "format", [1, 0, 0]),
    ];
    for (args, command, [syntax, semantic, schema_count]) in cases {
        let (output, events) = sandbox.debug_events(args, &[]);
        assert!(!output.status.success(), "{args:?}");
        assert_eq!(events.len(), 1, "{args:?}: {output:?}");
        let properties = &events[0]["properties"];
        gate(&schema, &events[0]).unwrap_or_else(|reason| panic!("{args:?}: {reason}"));
        assert_eq!(properties["command"], *command);
        assert_eq!(properties["outcome"], "failed");
        assert_eq!(properties["error_domain"], "input");
        assert!(
            properties["diagnostics_syntax"].as_u64().unwrap() >= *syntax,
            "{args:?}: {properties}"
        );
        assert_eq!(
            properties["diagnostics_syntax"].as_u64().unwrap() > 0,
            *syntax > 0,
            "{args:?}"
        );
        assert_eq!(
            properties["diagnostics_semantic"],
            json!(semantic),
            "{args:?}"
        );
        assert_eq!(
            properties["diagnostics_schema"],
            json!(schema_count),
            "{args:?}"
        );
    }
    let (_, events) =
        sandbox.debug_events(&["lint", "syntax.toml", "semantic.toml", "clean.toml"], &[]);
    assert_eq!(events[0]["properties"]["files_bucket"], "2-10");
}

#[test]
fn invocation_and_host_are_reported() {
    let sandbox = Sandbox::new("invocation");
    sandbox.write("doc.toml", "a = 1\n");
    let cases: &[(Vars, &str, Option<&str>)] = &[
        (&[], "other", None),
        (&[("PRE_COMMIT", "1")], "pre_commit", None),
        (&[("CI", "true")], "ci", None),
        (
            &[("PIPELEX_USAGE_STATS_HOST", "mthds-agent")],
            "other",
            Some("mthds-agent"),
        ),
        (
            &[("PIPELEX_USAGE_STATS_HOST", "/somewhere/else")],
            "other",
            Some("other"),
        ),
    ];
    for (vars, invocation, host) in cases {
        let (_, events) = sandbox.debug_events(&["lint", "doc.toml"], vars);
        let properties = &events[0]["properties"];
        assert_eq!(properties["invocation"], *invocation, "{vars:?}");
        assert_eq!(
            properties.get("host").and_then(Value::as_str),
            *host,
            "{vars:?}"
        );
    }
}

// ── The notice, the switches and the group ──────────────────────────────────

#[test]
fn the_notice_is_printed_once_and_recorded() {
    let sandbox = Sandbox::new("notice");
    sandbox.write("doc.toml", "a = 1\n");
    let notice = contract::notice_text();
    let (first, _) = sandbox.debug_events(&["lint", "doc.toml"], &[]);
    assert_eq!(
        String::from_utf8_lossy(&first.stderr)
            .matches(&notice)
            .count(),
        1
    );
    assert!(sandbox.state_dir().join("notice-v1").exists());
    let (second, _) = sandbox.debug_events(&["lint", "doc.toml"], &[]);
    assert!(!String::from_utf8_lossy(&second.stderr).contains(&notice));
    assert_eq!(status_json(&sandbox, &[])["notice_version"], 1);
}

#[test]
fn status_names_every_switch_in_the_contract_order() {
    let sandbox = Sandbox::new("switches");
    let expected = schema()["switches"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|switch| strings(&switch["tools"]).contains(&contract::TOOL.to_string()))
        .map(|switch| switch["token"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    fs::create_dir_all(sandbox.state_dir()).unwrap();
    fs::write(sandbox.state_dir().join("disabled"), "").unwrap();
    fs::write(
        sandbox.home.join(".mthds").join("config"),
        "DISABLE_TELEMETRY=1\n",
    )
    .unwrap();
    fs::create_dir_all(sandbox.project.join(".pipelex")).unwrap();
    fs::write(
        sandbox.project.join(".pipelex").join("pipelex.toml"),
        "[usage_stats]\nenabled = false\n",
    )
    .unwrap();
    let output = sandbox.plxt(
        "https://example.com",
        &["usage-stats", "status", "--format", "json"],
        &[("DO_NOT_TRACK", "1"), ("PIPELEX_USAGE_STATS", "0")],
    );
    let status: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["enabled"], false);
    assert_eq!(strings(&status["off_by"]), expected);
    // `status` changes nothing: the legacy choice is not migrated and no identifier is made.
    assert!(!sandbox.state_dir().join("legacy-migrated").exists());
    assert!(!sandbox.state_dir().join("id").exists());

    let mut keys = status
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        [
            "ci",
            "container",
            "enabled",
            "installation_id",
            "internal",
            "notice_version",
            "off_by",
            "state_dir",
            "tool"
        ]
    );
    assert_eq!(status["tool"], "plxt");
    assert_eq!(status["installation_id"], Value::Null);
    assert_eq!(
        Path::new(status["state_dir"].as_str().unwrap()),
        sandbox.state_dir()
    );
}

#[test]
fn switches_off_mean_no_event_no_notice_and_no_state() {
    let sandbox = Sandbox::new("off");
    sandbox.write("doc.toml", "a = 1\n");
    for vars in [
        vec![("DO_NOT_TRACK", "1")],
        vec![("PIPELEX_USAGE_STATS", "off")],
        vec![("PIPELEX_USAGE_STATS", "unreadable")],
    ] {
        let (output, events) = sandbox.debug_events(&["lint", "doc.toml"], &vars);
        assert!(output.status.success());
        assert!(events.is_empty(), "{vars:?}");
        assert!(!String::from_utf8_lossy(&output.stderr).contains(&contract::notice_text()));
    }
    assert!(!sandbox.state_dir().exists());
}

#[test]
fn the_group_disables_enables_and_resets_without_reporting() {
    let sandbox = Sandbox::new("group");
    sandbox.write("doc.toml", "a = 1\n");
    sandbox.debug_events(&["lint", "doc.toml"], &[]);
    let first_id = status_json(&sandbox, &[])["installation_id"]
        .as_str()
        .unwrap()
        .to_string();

    let disable = sandbox.plxt(UNREACHABLE_ENDPOINT, &["usage-stats", "disable"], &[]);
    assert!(disable.status.success());
    assert!(sandbox.state_dir().join("disabled").exists());
    assert_eq!(
        strings(&status_json(&sandbox, &[])["off_by"]),
        ["machine_choice"]
    );
    let (_, events) = sandbox.debug_events(&["lint", "doc.toml"], &[]);
    assert!(events.is_empty());

    let enable = sandbox.plxt(UNREACHABLE_ENDPOINT, &["usage-stats", "enable"], &[]);
    assert!(enable.status.success());
    assert!(!sandbox.state_dir().join("disabled").exists());
    assert_eq!(status_json(&sandbox, &[])["enabled"], true);

    let reset = sandbox.plxt(UNREACHABLE_ENDPOINT, &["usage-stats", "reset-id"], &[]);
    assert!(reset.status.success());
    let new_id = String::from_utf8_lossy(&reset.stdout).trim().to_string();
    assert_ne!(new_id, first_id);
    assert_eq!(status_json(&sandbox, &[])["installation_id"], new_id);

    for output in [&disable, &enable, &reset] {
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!stderr.contains(&contract::notice_text()));
        assert!(!stderr.contains("usage_stats_debug"));
    }
    let (_, events) = sandbox.debug_events(&["lint", "doc.toml"], &[]);
    assert_eq!(events[0]["distinct_id"], new_id);
    assert_eq!(events[0]["properties"]["id_new"], false);
}

// ── Delivery ────────────────────────────────────────────────────────────────

fn assert_batch(request: &(String, Value), schema: &Value) -> Vec<Value> {
    let (path, body) = request;
    assert_eq!(path, contract::BATCH_PATH);
    assert_eq!(body["api_key"], contract::PROJECT_TOKEN);
    let mut keys = body
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, ["api_key", "batch"]);
    let events = body["batch"].as_array().unwrap().clone();
    for envelope in &events {
        assert_envelope_shape(envelope);
        gate(schema, envelope).unwrap_or_else(|reason| panic!("{reason}: {envelope}"));
    }
    events
}

#[test]
fn a_detached_sender_posts_the_spooled_event() {
    let schema = schema();
    let server = CaptureServer::start(200);
    let sandbox = Sandbox::new("detached");
    sandbox.write("doc.toml", "a = 1\n");
    let output = sandbox.plxt(&server.origin, &["lint", "doc.toml"], &[]);
    assert!(output.status.success(), "{output:?}");
    let requests = server.wait_for_requests(1, Duration::from_secs(20));
    assert_eq!(requests.len(), 1, "the detached sender should post once");
    let events = assert_batch(&requests[0], &schema);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["properties"]["command"], "lint");
    assert_eq!(events[0]["properties"]["ci"], false);
    assert!(
        wait_until(Duration::from_secs(10), || sandbox
            .spooled_files()
            .is_empty()),
        "an accepted post empties the spool: {:?}",
        sandbox.spooled_files()
    );
}

#[test]
fn ci_posts_in_process_before_exiting() {
    let schema = schema();
    let server = CaptureServer::start(200);
    let sandbox = Sandbox::new("ci");
    sandbox.write("doc.toml", "a = 1\n");
    let output = sandbox.plxt(
        &server.origin,
        &["format", "--check", "doc.toml"],
        &[("GITHUB_ACTIONS", "true")],
    );
    assert!(output.status.success(), "{output:?}");
    // The post completes before the process exits; allow only for the server
    // thread to record it.
    let requests = server.wait_for_requests(1, Duration::from_millis(500));
    assert_eq!(requests.len(), 1, "CI posts in-process");
    let events = assert_batch(&requests[0], &schema);
    assert_eq!(events[0]["properties"]["ci"], true);
    assert_eq!(events[0]["properties"]["invocation"], "ci");
    assert!(sandbox.spooled_files().is_empty());
}

#[test]
fn a_failed_post_is_kept_and_a_refused_one_is_dropped() {
    let sandbox = Sandbox::new("failures");
    sandbox.write("doc.toml", "a = 1\n");

    let failing = CaptureServer::start(503);
    sandbox.plxt(&failing.origin, &["lint", "doc.toml"], &[("CI", "1")]);
    assert_eq!(
        failing
            .wait_for_requests(1, Duration::from_millis(500))
            .len(),
        1
    );
    let kept = sandbox.spooled_files();
    assert_eq!(kept.len(), 1, "a transient failure in CI spools the event");
    let spooled: Value = serde_json::from_str(&fs::read_to_string(&kept[0]).unwrap()).unwrap();
    assert_eq!(spooled["spool_version"], 1);

    let refusing = CaptureServer::start(400);
    sandbox.plxt(&refusing.origin, &["lint", "doc.toml"], &[]);
    let requests = refusing.wait_for_requests(1, Duration::from_secs(20));
    assert!(!requests.is_empty());
    // The spooled event from the failing run is resent unchanged.
    let resent = requests
        .iter()
        .flat_map(|(_, body)| body["batch"].as_array().unwrap().clone())
        .collect::<Vec<_>>();
    assert!(
        resent.contains(&spooled["events"][0]),
        "the queued event is resent as it was made"
    );
    assert!(
        wait_until(Duration::from_secs(10), || sandbox
            .spooled_files()
            .is_empty()),
        "a refused post is not retried: {:?}",
        sandbox.spooled_files()
    );
}

#[test]
fn queued_events_of_another_identifier_are_dropped_unsent() {
    let server = CaptureServer::start(200);
    let sandbox = Sandbox::new("identifier");
    sandbox.write("doc.toml", "a = 1\n");
    sandbox.debug_events(&["lint", "doc.toml"], &[]);
    let foreign = json!({
        "event": "command_completed",
        "distinct_id": "11111111-1111-4111-8111-111111111111",
        "uuid": "22222222-2222-4222-8222-222222222222",
        "timestamp": "2026-10-11T09:30:00.123Z",
        "properties": {}
    });
    fs::create_dir_all(sandbox.spool()).unwrap();
    let name = format!(
        "{}-foreign.json",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    fs::write(
        sandbox.spool().join(name),
        json!({ "spool_version": 1, "events": [foreign] }).to_string(),
    )
    .unwrap();
    sandbox.plxt(&server.origin, &["lint", "doc.toml"], &[]);
    server.wait_for_requests(1, Duration::from_secs(20));
    assert!(wait_until(Duration::from_secs(10), || sandbox
        .spooled_files()
        .is_empty()));
    let sent = server
        .requests()
        .iter()
        .flat_map(|(_, body)| body["batch"].as_array().unwrap().clone())
        .collect::<Vec<_>>();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_ne!(sent[0]["distinct_id"], foreign["distinct_id"]);
}

#[test]
fn the_endpoint_override_must_be_a_loopback_origin() {
    let sandbox = Sandbox::new("endpoint");
    let cases = [
        (
            true,
            vec![
                "https://eu.i.posthog.com",
                "http://example.com:80",
                "http://127.0.0.1:9/batch/",
                "",
            ],
        ),
        (
            false,
            vec!["http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9"],
        ),
    ];
    for (invalid, endpoints) in cases {
        for endpoint in endpoints {
            let output = sandbox.plxt(
                endpoint,
                &["usage-stats", "status", "--format", "json"],
                &[],
            );
            let status: Value = serde_json::from_slice(&output.stdout).unwrap();
            let off_by = strings(&status["off_by"]);
            assert_eq!(
                off_by.contains(&"invalid_endpoint_override".to_string()),
                invalid,
                "{endpoint:?}: {off_by:?}"
            );
        }
    }
}
