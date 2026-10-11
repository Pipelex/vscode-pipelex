//! One reporting command, from the switches read before it does anything to the
//! event delivered after it ends.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use taplo_cli::RunStats;

use super::{
    context::Context,
    contract, detect,
    event::{self, CommandCompleted, Common, Outcome},
    sender::{self, PostOutcome, PrePost},
    spool::Spool,
    state::{Identity, StateDir},
    switches::{self, Endpoint},
};

/// A command whose statistics are on.
pub struct Session {
    context: Context,
    state: StateDir,
    endpoint: Endpoint,
    command: &'static str,
    started: Instant,
}

impl Session {
    /// Start the statistics of a command: run the legacy migration, read every
    /// switch, and print the notice when this machine has not shown it yet. `None`
    /// when any switch says off, in which case nothing is created or printed.
    pub fn begin(command: &'static str) -> Option<Session> {
        let started = Instant::now();
        let context = Context::from_process();
        let state = StateDir::from_context(&context)?;
        let _ = switches::run_legacy_migration(&context, &state);
        if !switches::read(&context, Some(&state)).is_empty() {
            return None;
        }
        if !state.has_notice(contract::NOTICE_VERSION) {
            eprintln!("{}", contract::notice_text());
            // When the marker cannot be written the notice is printed again next
            // time, rather than not at all.
            let _ = state.record_notice(contract::NOTICE_VERSION);
        }
        let endpoint = Endpoint::from_context(&context);
        Some(Session {
            context,
            state,
            endpoint,
            command,
            started,
        })
    }

    /// Make the command's `command_completed` and deliver it: print it under the
    /// debug variable, post it in-process in CI and containers, and otherwise queue
    /// it for a detached sender.
    pub async fn finish(self, outcome: Outcome, stats: RunStats) {
        let Some(identity) = self.state.obtain_identity() else {
            return;
        };
        let ci = detect::is_ci(&self.context);
        let container = detect::is_container(&self.context);
        let common = Common {
            host: detect::host(&self.context),
            id_new: identity.created,
            os: detect::os(),
            arch: detect::arch(),
            ci,
            container,
            internal: self.state.is_internal(),
            notice_version: self.state.notice_version(),
        };
        let diagnostics =
            stats.diagnostics_syntax + stats.diagnostics_semantic + stats.diagnostics_schema;
        let error_domain = (diagnostics > 0 || stats.unformatted > 0).then_some("input");
        let command = CommandCompleted {
            command: self.command,
            outcome,
            error_domain,
            duration_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            files: stats.documents,
            invocation: detect::invocation(&self.context, ci),
            diagnostics_syntax: stats.diagnostics_syntax,
            diagnostics_semantic: stats.diagnostics_semantic,
            diagnostics_schema: stats.diagnostics_schema,
        };
        let Some(event) = event::command_completed(&identity.id, &common, &command) else {
            return;
        };
        let events = vec![event];

        if self.context.flag_is_on(contract::ENV_DEBUG) {
            for event in &events {
                eprintln!("{}", json!({ "usage_stats_debug": event }));
            }
            return;
        }
        self.deliver(events, &identity, ci || container).await;
    }

    async fn deliver(&self, events: Vec<Value>, identity: &Identity, in_process: bool) {
        let budget = Duration::from_millis(contract::BUDGET_CLI_IN_PROCESS_MS);
        if !identity.persisted {
            // No sender could match an identifier drawn for this process alone, so
            // its events are posted now or not at all.
            let _ = self.post_in_process(events, identity, budget).await;
            return;
        }
        let spool = Spool::new(self.state.tool_spool(contract::TOOL));
        if in_process {
            if let Some(unsent) = self.post_in_process(events, identity, budget).await {
                let _ = spool.write(&unsent);
            }
            return;
        }
        let path = match spool.write(&events) {
            Ok(path) => path,
            Err(_) => {
                let _ = self.post_in_process(events, identity, budget).await;
                return;
            }
        };
        if sender::start_detached_sender(self.state.root()).is_ok() {
            return;
        }
        // No sender could start: post the file now, within the CLI budget, and leave
        // it queued when that fails.
        if let Some(claimed) = spool.claim(&path) {
            let deadline = Instant::now() + budget;
            let _ = sender::send_claimed(
                &self.context,
                &self.state,
                &self.endpoint,
                claimed,
                deadline,
            )
            .await;
        }
    }

    /// Post events held in memory within `budget`, after the checks every post is
    /// preceded by. Answers the events a transient failure left unsent.
    async fn post_in_process(
        &self,
        events: Vec<Value>,
        identity: &Identity,
        budget: Duration,
    ) -> Option<Vec<Value>> {
        let own_local_id = (!identity.persisted).then_some(identity.id.as_str());
        let current = match sender::before_post(&self.context, &self.state, own_local_id) {
            PrePost::Disabled => return None,
            PrePost::Current(current) => current,
        };
        let events = sender::keep_current(events, current.as_deref());
        if events.is_empty() {
            return None;
        }
        match sender::post(&self.endpoint, &events, budget).await {
            PostOutcome::Accepted | PostOutcome::Refused => None,
            PostOutcome::Failed => Some(events),
        }
    }
}
