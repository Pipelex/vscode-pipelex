use pipelex_common::environment::MthdsEnvironment;
use taplo_common::environment::{native::NativeEnvironment, Environment};

use crate::{
    args::{LspCommand, LspCommandIo},
    PlxtCli,
};

impl<E: Environment> PlxtCli<E> {
    pub async fn execute_lsp(&mut self, cmd: LspCommand) -> Result<(), anyhow::Error> {
        // Unlike taplo-cli's execute_lsp which hard-codes NativeEnvironment::new(),
        // we wrap NativeEnvironment with MthdsEnvironment for pipelex config discovery.
        let mthds_env = MthdsEnvironment::new(NativeEnvironment::new());

        let server = taplo_lsp::create_server();
        let world = taplo_lsp::create_world(mthds_env);

        // The LSP world handles its own config discovery via the environment.
        // MthdsEnvironment ensures it finds .pipelex.toml before .taplo.toml.

        match cmd.io {
            LspCommandIo::Tcp { address } => {
                server
                    .listen_tcp(world, &address, async_ctrlc::CtrlC::new().unwrap())
                    .await
            }
            LspCommandIo::Stdio {} => {
                server
                    .listen_stdio(world, async_ctrlc::CtrlC::new().unwrap())
                    .await
            }
        }
    }
}
