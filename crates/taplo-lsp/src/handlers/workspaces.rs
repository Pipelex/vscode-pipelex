use super::update_configuration;
use crate::world::{WorkspaceState, World};
use lsp_async_stub::{Context, Params};
use lsp_types::{DidChangeWatchedFilesParams, DidChangeWorkspaceFoldersParams};
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

    // First pass: detect config file changes and reinitialize affected workspaces.
    let mut reinitialized_ws: Vec<lsp_types::Url> = Vec::new();

    for change in &p.changes {
        if let Some(path) = context.env.to_file_path_normalized(&change.uri) {
            if context.env.is_config_file(&path) {
                tracing::info!(?path, "config file changed, reloading workspace");

                let mut workspaces = context.workspaces.write().await;

                // Find workspaces whose root is a prefix of the config file URI.
                let ws_urls: Vec<_> = workspaces
                    .iter()
                    .filter(|(url, _)| {
                        change.uri.as_str().starts_with(url.as_str())
                            && !reinitialized_ws.contains(url)
                    })
                    .map(|(url, _)| url.clone())
                    .collect();

                for ws_url in ws_urls {
                    if let Some(ws) = workspaces.get_mut(&ws_url) {
                        if let Err(error) = ws.initialize(context.clone(), &context.env).await {
                            tracing::error!(
                                ?error,
                                "failed to reinitialize workspace after config change"
                            );
                        }
                        reinitialized_ws.push(ws_url);
                    }
                }
            }
        }
    }

    // Re-publish diagnostics for all open documents in reinitialized workspaces.
    if !reinitialized_ws.is_empty() {
        let workspaces = context.workspaces.read().await;
        let doc_urls: Vec<_> = reinitialized_ws
            .iter()
            .filter_map(|ws_url| workspaces.get(ws_url))
            .flat_map(|ws| ws.documents.keys().cloned())
            .collect();
        drop(workspaces);

        for (ws_url, doc_url) in reinitialized_ws.iter().flat_map(|ws_url| {
            doc_urls
                .iter()
                .filter(|d| d.as_str().starts_with(ws_url.as_str()))
                .map(move |d| (ws_url.clone(), d.clone()))
        }) {
            crate::diagnostics::publish_diagnostics(context.clone(), ws_url, doc_url).await;
        }
    }

    // Second pass: handle regular document changes (skip config files).
    for change in p.changes {
        if let Some(path) = context.env.to_file_path_normalized(&change.uri) {
            if context.env.is_config_file(&path) {
                continue;
            }

            let workspaces = context.workspaces.read().await;
            let ws = workspaces.by_document(&change.uri);

            // Check if this file is included in our configuration
            if ws.taplo_config.is_included(&path) {
                let workspace_uri = ws.root.clone();
                drop(workspaces);
                // Re-trigger diagnostics for this file if it's currently open
                let workspaces = context.workspaces.read().await;
                if workspaces
                    .by_document(&change.uri)
                    .documents
                    .contains_key(&change.uri)
                {
                    drop(workspaces);
                    crate::diagnostics::publish_diagnostics(
                        context.clone(),
                        workspace_uri,
                        change.uri,
                    )
                    .await;
                }
            }
        }
    }
}
