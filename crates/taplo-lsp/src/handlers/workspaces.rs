use super::update_configuration;
use crate::world::{WorkspaceState, World};
use lsp_async_stub::{Context, Params};
use lsp_types::{DidChangeWorkspaceFoldersParams, DidChangeWatchedFilesParams};
use taplo_common::environment::Environment;

pub async fn workspace_change<E: Environment>(
    context: Context<World<E>>,
    params: Params<DidChangeWorkspaceFoldersParams>,
) {
    let p = match params.optional() {
        None => return,
        Some(p) => p,
    };

    let mut workspaces = context.workspaces.write().await;
    let init_config = context.init_config.load();

    for removed in p.event.removed {
        workspaces.shift_remove(&removed.uri);
    }

    for added in p.event.added {
        let ws = workspaces
            .entry(added.uri.clone())
            .or_insert(WorkspaceState::new(context.env.clone(), added.uri));

        ws.schemas
            .cache()
            .set_cache_path(init_config.cache_path.clone());

        if let Err(error) = ws.initialize(context.clone(), &context.env).await {
            tracing::error!(?error, "failed to initialize workspace");
        }
    }

    drop(workspaces);
    update_configuration(context).await;
}

pub async fn watched_files_change<E: Environment>(
    context: Context<World<E>>,
    params: Params<DidChangeWatchedFilesParams>,
) {
    let p = match params.optional() {
        None => return,
        Some(p) => p,
    };

    // For each changed file, trigger diagnostics update
    for change in p.changes {
        if let Some(path) = context.env.to_file_path_normalized(&change.uri) {
            let workspaces = context.workspaces.read().await;
            let ws = workspaces.by_document(&change.uri);
            
            // Check if this file is included in our configuration
            if ws.taplo_config.is_included(&path) {
                let workspace_uri = ws.root.clone();
                drop(workspaces);
                // Re-trigger diagnostics for this file if it's currently open
                let workspaces = context.workspaces.read().await;
                if workspaces.by_document(&change.uri).documents.contains_key(&change.uri) {
                    drop(workspaces);
                    crate::diagnostics::publish_diagnostics(context.clone(), workspace_uri, change.uri).await;
                }
            }
        }
    }
}
