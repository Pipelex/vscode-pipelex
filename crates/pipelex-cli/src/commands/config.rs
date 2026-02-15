use taplo_common::environment::Environment;

use crate::{args::PlxtConfigCommand, PlxtCli};

impl<E: Environment> PlxtCli<E> {
    pub async fn execute_config(&self, cmd: PlxtConfigCommand) -> Result<(), anyhow::Error> {
        let taplo_cmd = match cmd {
            PlxtConfigCommand::Default => taplo_cli::args::ConfigCommand::Default,
            PlxtConfigCommand::Schema => taplo_cli::args::ConfigCommand::Schema,
        };
        self.inner.execute_config(taplo_cmd).await
    }
}
