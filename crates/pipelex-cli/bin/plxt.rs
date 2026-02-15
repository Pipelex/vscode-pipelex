use clap::Parser;
use pipelex_common::environment::MthdsEnvironment;
use std::process::exit;
use taplo_common::{environment::native::NativeEnvironment, log::setup_stderr_logging};
use tracing::Instrument;

use pipelex_cli::{
    args::{Colors, PlxtArgs},
    PlxtCli,
};

#[tokio::main]
async fn main() {
    let cli = PlxtArgs::parse();
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

    let env = MthdsEnvironment::new(NativeEnvironment::new());
    match PlxtCli::new(env)
        .execute(cli)
        .instrument(tracing::info_span!("plxt"))
        .await
    {
        Ok(_) => {
            exit(0);
        }
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), "operation failed");
            exit(1);
        }
    }
}
