use taplo_cli::args::{TaploArgs, TaploCommand};
use taplo_common::environment::Environment;

use crate::{
    args::{PlxtArgs, PlxtCommand},
    PlxtCli,
};

mod config;
#[cfg(feature = "lsp")]
mod lsp;

impl<E: Environment> PlxtCli<E> {
    pub async fn execute(&mut self, args: PlxtArgs) -> Result<(), anyhow::Error> {
        self.colors = match args.colors {
            crate::args::Colors::Auto => self.env.atty_stderr(),
            crate::args::Colors::Always => true,
            crate::args::Colors::Never => false,
        };

        match args.cmd {
            #[cfg(feature = "completions")]
            PlxtCommand::Completions { shell } => {
                use anyhow::anyhow;
                use clap::CommandFactory;
                use clap_complete::{generate, shells::Shell};
                use std::{io::stdout, str::FromStr};

                let shell = Shell::from_str(&shell).map_err(|e| anyhow!(e))?;
                generate(
                    shell,
                    &mut PlxtArgs::command(),
                    PlxtArgs::command().get_bin_name().unwrap(),
                    &mut stdout(),
                );
                Ok(())
            }
            PlxtCommand::Config { cmd } => self.execute_config(cmd).await,
            PlxtCommand::Format(cmd) => {
                // Delegate to taplo's execute_format via execute()
                let taplo_args = TaploArgs {
                    colors: args.colors,
                    verbose: args.verbose,
                    log_spans: args.log_spans,
                    cmd: TaploCommand::Format(cmd),
                };
                self.inner.execute(taplo_args).await
            }
            PlxtCommand::Get(cmd) => {
                let taplo_args = TaploArgs {
                    colors: args.colors,
                    verbose: args.verbose,
                    log_spans: args.log_spans,
                    cmd: TaploCommand::Get(cmd),
                };
                self.inner.execute(taplo_args).await
            }
            #[cfg(feature = "lint")]
            PlxtCommand::Lint(cmd) => {
                let taplo_args = TaploArgs {
                    colors: args.colors,
                    verbose: args.verbose,
                    log_spans: args.log_spans,
                    cmd: TaploCommand::Lint(cmd),
                };
                self.inner.execute(taplo_args).await
            }
            #[cfg(feature = "lsp")]
            PlxtCommand::Lsp { cmd } => self.execute_lsp(cmd).await,
        }
    }
}
