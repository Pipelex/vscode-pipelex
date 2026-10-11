//! Posting events to PostHog: the detached sender a command starts, the in-process
//! send of CI and containers, and the checks every post is preceded by.

use std::{
    io,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::{
    context::Context,
    contract,
    event::distinct_id,
    spool::{Claimed, Spool},
    state::{IdReading, StateDir},
    switches::{run_legacy_migration, Endpoint},
};

/// The hidden subcommand the detached sender runs as.
pub const SENDER_SUBCOMMAND: &str = "send-usage-stats";

/// How PostHog answered one post.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostOutcome {
    /// `2xx`: delete what was posted.
    Accepted,
    /// `400`, `401`, `403`, `413`: delete it too, since a resend would be refused again.
    Refused,
    /// Any other status, a timeout or a network error: keep it for the next sender.
    Failed,
}

/// What the checks before a post allow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrePost {
    /// `disabled` exists: send nothing and drop what is held.
    Disabled,
    /// Send the events made under this identifier, and drop the others.
    Current(Option<String>),
}

/// Immediately before each post: run the legacy migration, stop when `disabled`
/// exists, and read the current identifier. `own_local_id` is the identifier a
/// process drew for itself when `id` could not hold one; it stays current for that
/// process's own events while `id` holds nothing valid.
pub fn before_post(context: &Context, state: &StateDir, own_local_id: Option<&str>) -> PrePost {
    let _ = run_legacy_migration(context, state);
    if state.is_disabled() {
        return PrePost::Disabled;
    }
    match state.read_id() {
        IdReading::Valid(id) => PrePost::Current(Some(id)),
        IdReading::Absent | IdReading::Malformed => {
            PrePost::Current(own_local_id.map(str::to_string))
        }
    }
}

/// The events made under `current`.
pub fn keep_current(events: Vec<Value>, current: Option<&str>) -> Vec<Value> {
    match current {
        None => Vec::new(),
        Some(current) => events
            .into_iter()
            .filter(|event| distinct_id(event) == Some(current))
            .collect(),
    }
}

/// Post one batch, waiting no longer than `timeout`.
pub async fn post(endpoint: &Endpoint, events: &[Value], timeout: Duration) -> PostOutcome {
    let Some(origin) = endpoint.origin() else {
        return PostOutcome::Failed;
    };
    if timeout.is_zero() {
        return PostOutcome::Failed;
    }
    let mut builder = reqwest::Client::builder().timeout(timeout);
    if matches!(endpoint, Endpoint::Loopback(_)) {
        builder = builder.no_proxy();
    }
    let Ok(client) = builder.build() else {
        return PostOutcome::Failed;
    };
    let body = json!({ "api_key": contract::PROJECT_TOKEN, "batch": events });
    let response = client
        .post(format!("{origin}{}", contract::BATCH_PATH))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => PostOutcome::Accepted,
        Ok(response) if matches!(response.status().as_u16(), 400 | 401 | 403 | 413) => {
            PostOutcome::Refused
        }
        Ok(_) | Err(_) => PostOutcome::Failed,
    }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// Send one claimed spool file: check, filter, post, and delete it or give it back.
/// Answers false when `disabled` stopped the drain.
pub async fn send_claimed(
    context: &Context,
    state: &StateDir,
    endpoint: &Endpoint,
    claimed: Claimed,
    deadline: Instant,
) -> bool {
    let current = match before_post(context, state, None) {
        PrePost::Disabled => {
            claimed.delete();
            return false;
        }
        PrePost::Current(current) => current,
    };
    let Some(events) = claimed.events() else {
        // Not a spool file this version can read or send: nobody ever will.
        claimed.delete();
        return true;
    };
    let total = events.len();
    let events = keep_current(events, current.as_deref());
    if events.is_empty() {
        claimed.delete();
        return true;
    }
    if events.len() != total && claimed.rewrite(&events).is_err() {
        claimed.delete();
        return true;
    }
    match post(endpoint, &events, remaining(deadline)).await {
        PostOutcome::Accepted | PostOutcome::Refused => claimed.delete(),
        PostOutcome::Failed => claimed.release(),
    }
    true
}

/// The detached sender's run: post every file of `plxt`'s spool within its budget.
pub async fn run_detached() {
    let context = Context::from_process();
    let Some(state) = StateDir::from_context(&context) else {
        return;
    };
    let endpoint = Endpoint::from_context(&context);
    if endpoint == Endpoint::Invalid {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(contract::BUDGET_DETACHED_SENDER_MS);
    drain(&context, &state, &endpoint, deadline).await;
}

/// Post every file of `plxt`'s spool until the deadline; what is left stays queued.
pub async fn drain(context: &Context, state: &StateDir, endpoint: &Endpoint, deadline: Instant) {
    let spool = Spool::new(state.tool_spool(contract::TOOL));
    spool.tidy();
    let mut claimed = spool.claim_all().into_iter();
    while let Some(file) = claimed.next() {
        if remaining(deadline).is_zero() {
            file.release();
            claimed.for_each(Claimed::release);
            return;
        }
        if !send_claimed(context, state, endpoint, file, deadline).await {
            // `disabled` appeared: what is still claimed is deleted unsent.
            claimed.for_each(Claimed::delete);
            return;
        }
    }
}

/// Start the detached sender: this binary, with no terminal and no output, in a
/// process group of its own so that a Ctrl-C at the terminal does not reach it.
pub fn start_detached_sender(state_dir: &Path) -> io::Result<()> {
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .arg(SENDER_SUBCOMMAND)
        .current_dir(state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    command.spawn().map(drop)
}
