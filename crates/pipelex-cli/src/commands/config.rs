use taplo_common::environment::Environment;

use crate::{args::PlxtConfigCommand, PlxtCli};

impl<E: Environment> PlxtCli<E> {
    pub async fn execute_config(&self, cmd: PlxtConfigCommand) -> Result<(), anyhow::Error> {
        match cmd {
            PlxtConfigCommand::Default => {
                self.inner
                    .execute_config(taplo_cli::args::ConfigCommand::Default)
                    .await
            }
            PlxtConfigCommand::Schema => {
                self.inner
                    .execute_config(taplo_cli::args::ConfigCommand::Schema)
                    .await
            }
            PlxtConfigCommand::Which => {
                if let Some(cwd) = self.env.cwd_normalized() {
                    if let Some(path) = self.env.find_config_file_normalized(&cwd).await {
                        println!("{}", path.display());
                        Ok(())
                    } else {
                        Err(anyhow::anyhow!("no config file found"))
                    }
                } else {
                    Err(anyhow::anyhow!("unable to determine current working directory"))
                }
            }
        }
    }
}
