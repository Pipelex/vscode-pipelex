use crate::{query::Query, world::World};
use lsp_async_stub::{
    rpc::Error,
    util::{LspExt, Position},
    Context, Params,
};
use lsp_types::{GotoDefinitionParams, GotoDefinitionResponse, Location};
use taplo::{
    dom::{node::DomNode, KeyOrIndex, Keys},
    syntax::SyntaxKind::{STRING, STRING_LITERAL},
};
use taplo_common::environment::Environment;

#[tracing::instrument(skip_all)]
pub(crate) async fn goto_definition<E: Environment>(
    context: Context<World<E>>,
    params: Params<GotoDefinitionParams>,
) -> Result<Option<GotoDefinitionResponse>, Error> {
    let p = params.required()?;

    let document_uri = p.text_document_position_params.text_document.uri;

    // Only handle MTHDS files — no behavior change for TOML files.
    if !document_uri.as_str().ends_with(".mthds") {
        return Ok(None);
    }

    let workspaces = context.workspaces.read().await;
    let ws = workspaces.by_document(&document_uri);
    let doc = match ws.document(&document_uri) {
        Ok(d) => d,
        Err(error) => {
            tracing::debug!(%error, "failed to get document from workspace");
            return Ok(None);
        }
    };

    let position = p.text_document_position_params.position;
    let Some(offset) = doc.mapper.offset(Position::from_lsp(position)) else {
        tracing::error!(?position, "document position not found");
        return Ok(None);
    };

    let query = Query::at(&doc.dom, offset);

    // Check cursor is on a string token.
    let position_info = query
        .before
        .as_ref()
        .filter(|p| matches!(p.syntax.kind(), STRING | STRING_LITERAL))
        .or_else(|| {
            query
                .after
                .as_ref()
                .filter(|p| matches!(p.syntax.kind(), STRING | STRING_LITERAL))
        });

    let Some(position_info) = position_info else {
        return Ok(None);
    };

    // Check the cursor is inside an entry whose key is a pipe reference field.
    let Some(entry_key_node) = query.entry_key() else {
        return Ok(None);
    };

    let key_text: String = entry_key_node
        .descendants_with_tokens()
        .filter_map(|t| t.into_token())
        .filter(|t| t.kind() == taplo::syntax::SyntaxKind::IDENT)
        .map(|t| t.text().to_string())
        .collect::<Vec<_>>()
        .join(".");

    if !matches!(key_text.as_str(), "pipe" | "main_pipe" | "default_pipe_code") {
        return Ok(None);
    }

    // Extract the pipe name from the DOM node's string value,
    // falling back to stripping quotes from the syntax token text.
    let pipe_name = position_info
        .dom_node
        .as_ref()
        .and_then(|(_, node)| node.as_str().map(|s| s.value().to_string()))
        .unwrap_or_else(|| {
            let text = position_info.syntax.text().to_string();
            text.trim_matches('"').trim_matches('\'').to_string()
        });

    if pipe_name.is_empty() {
        return Ok(None);
    }

    // Look up `pipe.<name>` in the DOM.
    let target_keys = Keys::new(
        [
            KeyOrIndex::Key(taplo::dom::node::Key::new("pipe")),
            KeyOrIndex::Key(taplo::dom::node::Key::new(&pipe_name)),
        ]
        .into_iter(),
    );

    let Some(target_node) = doc.dom.path(&target_keys) else {
        return Ok(None);
    };

    let Some(syntax) = target_node.syntax() else {
        return Ok(None);
    };

    let Some(range) = doc.mapper.range(syntax.text_range()) else {
        return Ok(None);
    };

    Ok(Some(GotoDefinitionResponse::Scalar(Location {
        uri: document_uri,
        range: range.into_lsp(),
    })))
}
