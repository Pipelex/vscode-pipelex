//! The facts of the usage-statistics contract that `plxt` relies on.
//!
//! The contract lives in the conformance repository (`specs/usage-statistics.md`,
//! machine source `specs/usage-statistics.json`). This repository vendors the JSON
//! byte for byte at `test-data/usage-statistics.json`, and the tests in
//! `tests/usage_stats.rs` check every constant here against that copy, so a schema
//! refresh that changes one of them fails until this file follows.

/// The version of the event schema every event follows (`schema_version`).
pub const SCHEMA_VERSION: u64 = 2;
/// The reporting tool, and its only surface.
pub const TOOL: &str = "plxt";
pub const SURFACE: &str = "plxt";
/// The released version of the `pipelex-tools` package, which maturin takes from
/// this crate's manifest.
pub const TOOL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Where events go: PostHog's EU capture host and its batch endpoint. The project
/// token is public by design: it can only write events, and the project's gate
/// decides what is kept.
pub const CAPTURE_HOST: &str = "https://eu.i.posthog.com";
pub const BATCH_PATH: &str = "/batch/";
pub const PROJECT_TOKEN: &str = "phc_uQjSVbzNPJxA8bHxfevn7NMzB6PbC6aJQRB6ka6MxT7a";
/// Set to `false` on every event, so PostHog never builds a person profile.
pub const PERSON_PROFILE_PROPERTY: &str = "$process_person_profile";

/// The notice, its version and how `plxt` names its own way to disable.
pub const NOTICE_VERSION: u32 = 1;
pub const NOTICE_TEMPLATE: &str = "Pipelex collects anonymous usage statistics: counts of commands, runs, pipe types, models and tokens, and the country your IP address maps to; the address itself is never stored. It never collects your methods, prompts, inputs, outputs, file names or pipe names. To turn it off, run `{disable_command}` or set DO_NOT_TRACK=1. Details: {details_url}";
pub const NOTICE_DETAILS_URL: &str = "https://docs.pipelex.com/latest/setup/usage-statistics/";
pub const DISABLE_COMMAND: &str = "plxt usage-stats disable";

/// The notice as `plxt` prints it.
pub fn notice_text() -> String {
    NOTICE_TEMPLATE
        .replace("{disable_command}", DISABLE_COMMAND)
        .replace("{details_url}", NOTICE_DETAILS_URL)
}

/// The environment variables of the contract.
pub const ENV_DO_NOT_TRACK: &str = "DO_NOT_TRACK";
pub const ENV_TOOL_SWITCH: &str = "PIPELEX_USAGE_STATS";
pub const ENV_DEBUG: &str = "PIPELEX_USAGE_STATS_DEBUG";
pub const ENV_ENDPOINT_OVERRIDE: &str = "PIPELEX_USAGE_STATS_ENDPOINT";
pub const ENV_HOST: &str = "PIPELEX_USAGE_STATS_HOST";
/// Set by pre-commit in the environment of the hooks it runs.
pub const ENV_PRE_COMMIT: &str = "PRE_COMMIT";

/// The shared state directory, relative to the home directory, and its files.
pub const STATE_DIRECTORY: [&str; 2] = [".mthds", "usage-stats"];
pub const STATE_ID: &str = "id";
pub const STATE_DISABLED: &str = "disabled";
pub const STATE_LEGACY_MIGRATED: &str = "legacy-migrated";
pub const STATE_NOTICE_PREFIX: &str = "notice-v";
pub const STATE_INTERNAL: &str = "internal";
pub const STATE_SPOOL: &str = "spool";
/// Today's `mthds` CLI keeps its opt-out under this key of `~/.mthds/config`.
pub const LEGACY_CONFIG: [&str; 2] = [".mthds", "config"];
pub const LEGACY_KEY: &str = "DISABLE_TELEMETRY";

/// How each switch variable is read, trimmed and lowercased.
pub const FALSY_VALUES: [&str; 3] = ["", "0", "false"];
pub const TOOL_SWITCH_OFF_VALUES: [&str; 4] = ["0", "false", "no", "off"];
pub const TOOL_SWITCH_NO_EFFECT_VALUES: [&str; 5] = ["", "1", "true", "yes", "on"];
pub const LEGACY_DISABLE_ON_VALUES: [&str; 4] = ["1", "true", "yes", "on"];

/// The spool's limits.
pub const SPOOL_MAX_FILES: usize = 100;
pub const SPOOL_MAX_AGE_DAYS: u64 = 30;
pub const SPOOL_STALE_CLAIM_MINUTES: u64 = 10;
pub const SPOOL_STALE_TEMP_MINUTES: u64 = 60;

/// The send budgets that apply to a CLI, in milliseconds.
pub const BUDGET_CLI_IN_PROCESS_MS: u64 = 1000;
pub const BUDGET_DETACHED_SENDER_MS: u64 = 10000;

/// A process is in CI when one of these is set to anything but a falsy value.
pub const CI_VARIABLES: [&str; 17] = [
    "CI",
    "CONTINUOUS_INTEGRATION",
    "BUILD_NUMBER",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "TRAVIS",
    "BUILDKITE",
    "TF_BUILD",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
    "BITBUCKET_BUILD_NUMBER",
    "CODEBUILD_BUILD_ID",
    "DRONE",
    "APPVEYOR",
    "SEMAPHORE",
    "WOODPECKER",
];

/// A process is in a container when one of these files exists, one of these
/// variables is set and not empty, or `/proc/1/cgroup` mentions one of the words.
pub const CONTAINER_FILES: [&str; 2] = ["/.dockerenv", "/run/.containerenv"];
pub const CONTAINER_VARIABLES: [&str; 2] = ["container", "KUBERNETES_SERVICE_HOST"];
pub const CONTAINER_CGROUP_WORDS: [&str; 4] = ["docker", "kubepods", "containerd", "lxc"];

/// The first directory, walking up, that contains one of these is the project root.
pub const PROJECT_MARKERS: [&str; 7] = [
    ".pipelex",
    ".git",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "package.json",
    ".hg",
];

/// The values of the `host` property a declaration can name; any other value sends `other`.
pub const HOST_VALUES: [&str; 2] = ["cocode", "mthds-agent"];
pub const HOST_OTHER: &str = "other";

/// The command paths `plxt` reports, aliases resolved.
pub const COMMAND_FORMAT: &str = "format";
pub const COMMAND_LINT: &str = "lint";
pub const COMMAND_GET: &str = "get";
pub const COMMAND_CONFIG: &str = "config";

/// The upper bounds the schema sets on the counts `plxt` sends.
pub const MAX_DURATION_MS: u64 = 2_592_000_000;
pub const MAX_DIAGNOSTICS: u64 = 1_000_000;
