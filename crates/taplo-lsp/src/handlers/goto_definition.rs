use crate::{
    handlers::mthds_resolution::resolve_reference,
    query::Query,
    world::World,
};
use lsp_async_stub::{
    rpc::Error,
    util::{LspExt, Position},
    Context, Params,
};
use lsp_types::{GotoDefinitionParams, GotoDefinitionResponse, Location};
use taplo::dom::node::DomNode;
use taplo_common::environment::Environment;

#[tracing::instrument(skip_all)]
pub(crate) async fn goto_definition<E: Environment>(
    context: Context<World<E>>,
    params: Params<GotoDefinitionParams>,
) -> Result<Option<GotoDefinitionResponse>, Error> {
    let p = params.required()?;

    let document_uri = p.text_document_position_params.text_document.uri;

    // Only handle MTHDS files — no behavior change for TOML files.
    if !document_uri.as_str().ends_with(".mthds") && !document_uri.as_str().ends_with(".plx") {
        return Ok(None);
    }

    tracing::debug!(%document_uri, "goto_definition: handling MTHDS file");

    let workspaces = context.workspaces.read().await;
    let ws = workspaces.by_document(&document_uri);
    let doc = match ws.document(&document_uri) {
        Ok(d) => d,
        Err(error) => {
            tracing::debug!(%error, "goto_definition: failed to get document");
            return Ok(None);
        }
    };

    let position = p.text_document_position_params.position;
    let Some(offset) = doc.mapper.offset(Position::from_lsp(position)) else {
        tracing::error!(?position, "document position not found");
        return Ok(None);
    };

    let query = Query::at(&doc.dom, offset);

    let Some(resolved) = resolve_reference(&doc.dom, &query) else {
        tracing::debug!("goto_definition: no reference resolved at cursor");
        return Ok(None);
    };

    tracing::debug!(
        root_key = resolved.kind.root_key(),
        ref_name = %resolved.ref_name,
        "goto_definition: resolved reference"
    );

    let Some(syntax) = resolved.target_node.syntax() else {
        tracing::debug!("goto_definition: target node has no syntax");
        return Ok(None);
    };

    let Some(range) = doc.mapper.range(syntax.text_range()) else {
        tracing::debug!("goto_definition: failed to map syntax range");
        return Ok(None);
    };

    tracing::debug!(
        root_key = resolved.kind.root_key(),
        ref_name = %resolved.ref_name,
        ?range,
        "goto_definition: resolved"
    );

    Ok(Some(GotoDefinitionResponse::Scalar(Location {
        uri: document_uri,
        range: range.into_lsp(),
    })))
}
