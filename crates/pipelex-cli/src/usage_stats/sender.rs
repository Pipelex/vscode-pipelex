//! Posting events to PostHog: the detached sender a command starts, the drain of the
//! spool it and the in-process send of CI and containers run, and the checks every
//! post is preceded by.

use std::{
    collections::VecDeque,
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
    spool::{Claimed, Content, Spool},
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

/// The most events one post carries: far below the capture endpoint's request size
/// limit, and enough that a full spool goes in a few posts rather than one per file.
pub const MAX_EVENTS_PER_POST: usize = 500;

/// One HTTP client for a whole run of posts, to the endpoint the switches allow.
pub struct Poster {
    client: reqwest::Client,
    origin: String,
    url: String,
}

impl Poster {
    /// `None` when the endpoint override is invalid or no client can be built.
    pub fn new(endpoint: &Endpoint) -> Option<Self> {
        // A unit test posts to a loopback capture server or nowhere, never to PostHog.
        #[cfg(test)]
        assert!(
            !matches!(endpoint, Endpoint::Default),
            "a unit test tried to post usage statistics to the real capture host"
        );
        let origin = endpoint.origin()?;
        let mut builder = reqwest::Client::builder();
        if matches!(endpoint, Endpoint::Loopback(_)) {
            builder = builder.no_proxy();
        }
        Some(Self {
            client: builder.build().ok()?,
            origin: origin.to_string(),
            url: format!("{origin}{}", contract::BATCH_PATH),
        })
    }

    /// The origin this poster posts to, as the switches resolved it: the one a spool
    /// file names when its events were queued for this endpoint.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Post one batch, waiting no longer than `timeout`.
    pub async fn post(&self, events: &[Value], timeout: Duration) -> PostOutcome {
        if timeout.is_zero() {
            return PostOutcome::Failed;
        }
        let body = json!({ "api_key": contract::PROJECT_TOKEN, "batch": events });
        let response = self
            .client
            .post(&self.url)
            .timeout(timeout)
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
}

pub fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// The detached sender's run: post every file of `plxt`'s spool within its budget.
pub async fn run_detached() {
    let context = Context::from_process();
    let Some(state) = StateDir::from_context(&context) else {
        return;
    };
    let Some(poster) = Poster::new(&Endpoint::from_context(&context)) else {
        return;
    };
    let deadline = Instant::now() + Duration::from_millis(contract::BUDGET_DETACHED_SENDER_MS);
    drain(&context, &state, &poster, deadline).await;
}

/// Post every file of `plxt`'s spool queued for the poster's endpoint until the
/// deadline, as few files to a post as [`MAX_EVENTS_PER_POST`] allows, each file once.
/// A file queued for another endpoint is left for a sender posting there, so events
/// queued under a test's loopback override never reach PostHog, and events queued for
/// PostHog never reach a loopback endpoint. The checks every post is preceded by run
/// before each post; a failed post leaves its files and every file not yet tried
/// queued for the next sender, since the endpoint is unreachable or failing.
pub async fn drain(context: &Context, state: &StateDir, poster: &Poster, deadline: Instant) {
    let spool = Spool::new(state.tool_spool(contract::TOOL));
    spool.tidy();
    let mut claimed: VecDeque<Claimed> = spool.claim_all(poster.origin()).into();
    while !claimed.is_empty() {
        if remaining(deadline).is_zero() {
            claimed.into_iter().for_each(Claimed::release);
            return;
        }
        let current = match before_post(context, state, None) {
            PrePost::Disabled => {
                // `disabled` appeared: what is claimed is deleted unsent.
                claimed.into_iter().for_each(Claimed::delete);
                return;
            }
            PrePost::Current(current) => current,
        };
        let (files, events) = next_batch(&mut claimed, current.as_deref(), poster.origin());
        if files.is_empty() {
            continue;
        }
        match poster.post(&events, remaining(deadline)).await {
            PostOutcome::Accepted | PostOutcome::Refused => {
                files.into_iter().for_each(Claimed::delete);
            }
            PostOutcome::Failed => {
                files.into_iter().chain(claimed).for_each(Claimed::release);
                return;
            }
        }
    }
}

/// Take from the front of `claimed` the files whose current events fit in one post to
/// `origin`, deleting on the way the files nothing of which is sent: unreadable ones,
/// and those whose events were all made under a replaced identifier. A file queued for
/// another endpoint is given back untouched. A file keeping only some of its events is
/// rewritten with them first.
fn next_batch(
    claimed: &mut VecDeque<Claimed>,
    current: Option<&str>,
    origin: &str,
) -> (Vec<Claimed>, Vec<Value>) {
    let mut files = Vec::new();
    let mut batch = Vec::new();
    while let Some(file) = claimed.pop_front() {
        let Some(content) = file.content() else {
            // Not a spool file this version can read or send: nobody ever will.
            file.delete();
            continue;
        };
        if !content.is_queued_for(origin) {
            // Queued for another endpoint, which only a read after the claim told:
            // a sender posting there sends it.
            file.release();
            continue;
        }
        let total = content.events.len();
        let events = keep_current(content.events, current);
        if events.is_empty() {
            file.delete();
            continue;
        }
        if !batch.is_empty() && batch.len() + events.len() > MAX_EVENTS_PER_POST {
            claimed.push_front(file);
            break;
        }
        let kept = Content {
            endpoint: content.endpoint,
            events,
        };
        if kept.events.len() != total && file.rewrite(&kept).is_err() {
            file.delete();
            continue;
        }
        batch.extend(kept.events);
        files.push(file);
    }
    (files, batch)
}

/// Start the detached sender: this binary, with no terminal and no output, in a
/// process group of its own so that a Ctrl-C at the terminal does not reach it.
///
/// It must hold none of the command's own standard streams: a caller reading `plxt`'s
/// output to its end, as `subprocess.run` or `Command::output` do, would otherwise
/// wait for the sender too. Its stdio is null on every platform; on POSIX nothing else
/// is inherited, since the standard library opens every other descriptor
/// close-on-exec, but Windows passes every inheritable handle to a child, and the
/// pipes a caller gave `plxt` usually are, so they are made non-inheritable first.
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
        keep_standard_handles_from_children();
    }
    command.spawn().map(drop)
}

/// Clear the inherit flag of this process's standard handles, so that no child it
/// starts from now on holds them. `plxt` starts the sender as the last thing it does.
#[cfg(windows)]
fn keep_standard_handles_from_children() {
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetHandleInformation(handle: *mut std::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;

    for handle in [
        io::stdin().as_raw_handle(),
        io::stdout().as_raw_handle(),
        io::stderr().as_raw_handle(),
    ] {
        if handle.is_null() {
            continue;
        }
        // SAFETY: the handle is one of this process's standard handles, and the call
        // only clears its inherit flag. It fails harmlessly on a handle that cannot be
        // inherited anyway, such as a console's or an invalid one.
        unsafe {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
        }
    }
}
