use std::{io, sync::Arc};

use futures::Sink;
use lsp_async_stub::{rpc, Server};
use pipelex_common::environment::MthdsEnvironment;
use taplo_common::environment::Environment;
use taplo_lsp::world::{World, WorldState};

/// A Pipelex LSP server that wraps the taplo-lsp at the message level.
///
/// This wrapper uses [`MthdsEnvironment`] to ensure `.pipelex.toml` config
/// files are discovered before `.taplo.toml`. It also provides a future
/// extension point for MTHDS-specific LSP features (diagnostics, completions,
/// code actions).
pub struct PipelexLsp<E: Environment> {
    server: Server<World<MthdsEnvironment<E>>>,
    world: World<MthdsEnvironment<E>>,
}

impl<E: Environment> PipelexLsp<E> {
    pub fn new(env: E) -> Self {
        let mthds_env = MthdsEnvironment::new(env);
        Self {
            server: taplo_lsp::create_server(),
            world: taplo_lsp::create_world(mthds_env),
        }
    }

    pub fn server(&self) -> &Server<World<MthdsEnvironment<E>>> {
        &self.server
    }

    pub fn world(&self) -> &World<MthdsEnvironment<E>> {
        &self.world
    }

    /// Handle an incoming LSP message.
    ///
    /// Currently delegates directly to taplo-lsp. In the future, this is where
    /// MTHDS-specific request/notification handlers would be added.
    pub async fn handle_message<W>(&self, message: rpc::Message, writer: W) -> Result<(), io::Error>
    where
        W: Sink<rpc::Message, Error = io::Error> + Unpin + Clone + 'static,
    {
        self.server
            .handle_message(self.world.clone(), message, writer)
            .await
    }
}

/// Create a Pipelex LSP server for use with existing taplo-lsp infrastructure.
///
/// Returns the underlying taplo server and world separately, useful when
/// integrating with `listen_tcp` / `listen_stdio` which expect these types.
pub fn create_server<E: Environment>() -> Server<World<MthdsEnvironment<E>>> {
    taplo_lsp::create_server()
}

pub fn create_world<E: Environment>(env: E) -> World<MthdsEnvironment<E>> {
    let mthds_env = MthdsEnvironment::new(env);
    Arc::new(WorldState::new(mthds_env))
}
