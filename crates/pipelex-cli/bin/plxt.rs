use clap::Parser;
use pipelex_common::environment::MthdsEnvironment;
use std::process::exit;
use taplo_common::{environment::native::NativeEnvironment, log::setup_stderr_logging};
use tracing::Instrument;

use pipelex_cli::{
    args::{Colors, PlxtArgs},
    PlxtCli,
};

#[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
use pipelex_cli::usage_stats::{event::Outcome, session::Session};

/// The exit code of a command interrupted by Ctrl-C, as a shell reports it.
#[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
const INTERRUPTED_EXIT_CODE: i32 = 130;

#[tokio::main]
async fn main() {
    let cli = PlxtArgs::parse();
    let quiet = cli.quiet;
    if quiet {
        std::env::set_var("RUST_LOG", "off");
    }
    setup_stderr_logging(
        NativeEnvironment::new(),
        cli.log_spans,
        cli.verbose,
        match cli.colors {
            Colors::Auto => None,
            Colors::Always => Some(true),
            Colors::Never => Some(false),
        },
    );

    // Every switch is read, and the notice printed, before the command does anything.
    #[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
    let session = cli.cmd.statistics_name().and_then(Session::begin);

    let env = MthdsEnvironment::new(NativeEnvironment::new());
    let mut plxt = PlxtCli::new(env);

    #[cfg(all(feature = "usage-stats", not(target_family = "wasm")))]
    if let Some(session) = session {
        let result = {
            let execution = plxt.execute(cli).instrument(tracing::info_span!("plxt"));
            tokio::pin!(execution);
            // A Ctrl-C still sends the command's statistics, as `cancelled`.
            tokio::select! {
                result = &mut execution => Some(result),
                _ = tokio::signal::ctrl_c() => None,
            }
        };
        let outcome = match &result {
            Some(Ok(_)) => Outcome::Succeeded,
            Some(Err(_)) => Outcome::Failed,
            None => Outcome::Cancelled,
        };
        session.finish(outcome, plxt.run_stats()).await;
        match result {
            Some(result) => finish(result, quiet),
            None => exit(INTERRUPTED_EXIT_CODE),
        }
    }

    let result = plxt
        .execute(cli)
        .instrument(tracing::info_span!("plxt"))
        .await;
    finish(result, quiet);
}

fn finish(result: Result<(), anyhow::Error>, quiet: bool) -> ! {
    match result {
        Ok(_) => {
            exit(0);
        }
        Err(error) => {
            if !quiet {
                tracing::error!(error = %format!("{error:#}"), "operation failed");
            }
            exit(1);
        }
    }
}
