//! `plxt usage-stats status|disable|enable|reset-id`: the statistics command group.
//! Its commands never send, queue or print the notice, and exit `0` unless they
//! could not do what they say.

use serde_json::json;

use super::{
    context::Context,
    contract, detect,
    state::{IdReading, StateDir},
    switches::{self, OffBy},
};

/// How `status` prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum StatusFormat {
    #[default]
    Text,
    Json,
}

/// The verbs of the group.
#[derive(Debug, Clone, clap::Subcommand)]
pub enum UsageStatsCommand {
    /// Print whether usage statistics are on, the switches that turn them off, the
    /// installation identifier and the notice version seen. Changes nothing.
    Status {
        /// `text` for people, `json` for programs.
        #[clap(long, value_enum, default_value = "text")]
        format: StatusFormat,
    },
    /// Turn usage statistics off on this machine, for every Pipelex tool and the
    /// `mthds` CLI, and delete every queued event.
    Disable,
    /// Turn the machine choice back on, and name any other switch that keeps
    /// statistics off.
    Enable,
    /// Delete every queued event, replace the installation identifier with a new
    /// random one, and print it.
    ResetId,
}

/// Run one verb, answering the process's exit code.
pub fn run(command: &UsageStatsCommand) -> i32 {
    let context = Context::from_process();
    let Some(state) = StateDir::from_context(&context) else {
        eprintln!("plxt usage-stats: no home directory, so there is no usage statistics state");
        return 1;
    };
    match command {
        UsageStatsCommand::Status { format } => status(&context, &state, *format),
        UsageStatsCommand::Disable => disable(&state),
        UsageStatsCommand::Enable => enable(&context, &state),
        UsageStatsCommand::ResetId => reset_id(&state),
    }
}

fn status(context: &Context, state: &StateDir, format: StatusFormat) -> i32 {
    let off_by = switches::read(context, Some(state));
    let installation_id = match state.read_id() {
        IdReading::Valid(id) => Some(id),
        IdReading::Absent | IdReading::Malformed => None,
    };
    let notice_version = state.notice_version();
    let internal = state.is_internal();
    let ci = detect::is_ci(context);
    let container = detect::is_container(context);
    let state_dir = state.root().to_string_lossy().into_owned();
    let tokens = off_by.iter().map(|off| off.token()).collect::<Vec<_>>();
    match format {
        StatusFormat::Json => {
            println!(
                "{}",
                json!({
                    "tool": contract::TOOL,
                    "enabled": off_by.is_empty(),
                    "off_by": tokens,
                    "installation_id": installation_id,
                    "notice_version": notice_version,
                    "internal": internal,
                    "ci": ci,
                    "container": container,
                    "state_dir": state_dir,
                })
            );
        }
        StatusFormat::Text => {
            if off_by.is_empty() {
                println!("Usage statistics: on");
            } else {
                println!("Usage statistics: off ({})", describe(&off_by));
            }
            println!(
                "Installation identifier: {}",
                installation_id.as_deref().unwrap_or("none")
            );
            println!("Notice version seen: {notice_version}");
            println!("Team machine: {}", yes_no(internal));
            println!("Continuous integration: {}", yes_no(ci));
            println!("Container: {}", yes_no(container));
            println!("State directory: {state_dir}");
            println!("Details: {}", contract::NOTICE_DETAILS_URL);
        }
    }
    0
}

fn disable(state: &StateDir) -> i32 {
    let created = state.create_disabled();
    let emptied = state.delete_every_spool();
    match (created, emptied) {
        (Ok(()), Ok(())) => {
            println!("Usage statistics are off on this machine, for every Pipelex tool and the mthds CLI. Run `plxt usage-stats enable` to turn them back on.");
            0
        }
        (Err(error), _) | (_, Err(error)) => {
            eprintln!("plxt usage-stats disable: {error}");
            1
        }
    }
}

fn enable(context: &Context, state: &StateDir) -> i32 {
    if let Err(error) = state.delete_disabled() {
        eprintln!("plxt usage-stats enable: {error}");
        return 1;
    }
    if let Err(error) = state.mark_legacy_migrated(context.legacy_config().as_deref()) {
        eprintln!("plxt usage-stats enable: {error}");
        return 1;
    }
    let still_off = switches::read(context, Some(state));
    if still_off.is_empty() {
        println!("Usage statistics are on.");
    } else {
        println!(
            "The machine choice is on, but usage statistics stay off: {}.",
            describe(&still_off)
        );
    }
    0
}

fn reset_id(state: &StateDir) -> i32 {
    let result = state
        .delete_every_spool()
        .and_then(|()| state.delete_id())
        .and_then(|()| state.create_id());
    match result {
        Ok(identity) if identity.persisted => {
            println!("{}", identity.id);
            0
        }
        Ok(_) => {
            eprintln!(
                "plxt usage-stats reset-id: another process wrote an identifier that is not valid"
            );
            1
        }
        Err(error) => {
            eprintln!("plxt usage-stats reset-id: {error}");
            1
        }
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

/// The switches saying off, each with its token and what it means.
fn describe(off_by: &[OffBy]) -> String {
    off_by
        .iter()
        .map(|off| {
            let meaning = match off {
                OffBy::DoNotTrack => "DO_NOT_TRACK is set",
                OffBy::ToolVariable => "PIPELEX_USAGE_STATS says off",
                OffBy::MachineChoice => "turned off on this machine",
                OffBy::LegacyMthdsChoice => "DISABLE_TELEMETRY is on in ~/.mthds/config",
                OffBy::ProjectSetting => "the project's .pipelex/pipelex.toml turns them off",
                OffBy::InvalidEndpointOverride => {
                    "PIPELEX_USAGE_STATS_ENDPOINT is not a loopback address"
                }
            };
            format!("{} ({meaning})", off.token())
        })
        .collect::<Vec<_>>()
        .join(", ")
}
