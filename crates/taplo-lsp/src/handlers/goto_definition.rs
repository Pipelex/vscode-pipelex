use crate::{query::Query, world::World};
use lsp_async_stub::{
    rpc::Error,
    util::{LspExt, Position},
    Context, Params,
};
use lsp_types::{GotoDefinitionParams, GotoDefinitionResponse, Location};
use taplo::{
    dom::{node::DomNode, KeyOrIndex, Keys},
    syntax::SyntaxKind::{self, IDENT, STRING, STRING_LITERAL},
};
use taplo_common::environment::Environment;

pub(crate) enum ReferenceKind {
    Pipe,
    Concept,
}

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
        tracing::debug!("goto_definition: no STRING token at cursor");
        return Ok(None);
    };

    // Check the cursor is inside an entry whose key is a reference field.
    let Some(entry_key_node) = query.entry_key() else {
        tracing::debug!("goto_definition: no entry key found");
        return Ok(None);
    };

    let key_text: String = entry_key_node
        .descendants_with_tokens()
        .filter_map(|t| t.into_token())
        .filter(|t| t.kind() == IDENT)
        .map(|t| t.text().to_string())
        .collect::<Vec<_>>()
        .join(".");

    let kind = if matches!(key_text.as_str(), "pipe" | "main_pipe" | "default_pipe_code") {
        ReferenceKind::Pipe
    } else if matches!(key_text.as_str(), "output" | "refines") {
        ReferenceKind::Concept
    } else if is_inside_inputs_inline_table(&position_info.syntax) {
        ReferenceKind::Concept
    } else {
        tracing::debug!(%key_text, "goto_definition: key is not a reference field");
        return Ok(None);
    };

    // Extract the reference name from the DOM node's string value,
    // falling back to stripping quotes from the syntax token text.
    let ref_name = position_info
        .dom_node
        .as_ref()
        .and_then(|(_, node)| node.as_str().map(|s| s.value().to_string()))
        .unwrap_or_else(|| {
            let text = position_info.syntax.text().to_string();
            text.trim_matches('"').trim_matches('\'').to_string()
        });

    if ref_name.is_empty() {
        tracing::debug!("goto_definition: empty reference name");
        return Ok(None);
    }

    // Look up `<root_key>.<name>` in the DOM.
    let root_key = match kind {
        ReferenceKind::Pipe => "pipe",
        ReferenceKind::Concept => "concept",
    };

    tracing::debug!(%root_key, %ref_name, "goto_definition: looking up reference");

    let target_keys = Keys::new(
        [
            KeyOrIndex::Key(taplo::dom::node::Key::new(root_key)),
            KeyOrIndex::Key(taplo::dom::node::Key::new(&ref_name)),
        ]
        .into_iter(),
    );

    let Some(target_node) = doc.dom.path(&target_keys) else {
        tracing::debug!(%root_key, %ref_name, "goto_definition: target not found in DOM");
        return Ok(None);
    };

    let Some(syntax) = target_node.syntax() else {
        tracing::debug!("goto_definition: target node has no syntax");
        return Ok(None);
    };

    let Some(range) = doc.mapper.range(syntax.text_range()) else {
        tracing::debug!("goto_definition: failed to map syntax range");
        return Ok(None);
    };

    tracing::debug!(%root_key, %ref_name, ?range, "goto_definition: resolved");

    Ok(Some(GotoDefinitionResponse::Scalar(Location {
        uri: document_uri,
        range: range.into_lsp(),
    })))
}

/// Check whether a syntax token sits inside an `inputs = { … }` inline table.
///
/// Expected ancestry: STRING → VALUE → ENTRY (inner) → INLINE_TABLE → VALUE → ENTRY (outer)
/// where the outer ENTRY's KEY is `inputs`.
pub(crate) fn is_inside_inputs_inline_table(token: &taplo::syntax::SyntaxToken) -> bool {
    let inner_entry = token
        .parent_ancestors()
        .find(|n| n.kind() == SyntaxKind::ENTRY);
    let Some(inner_entry) = inner_entry else {
        return false;
    };

    let inline_table = inner_entry
        .ancestors()
        .find(|n| n.kind() == SyntaxKind::INLINE_TABLE);
    let Some(inline_table) = inline_table else {
        return false;
    };

    let outer_entry = inline_table
        .ancestors()
        .find(|n| n.kind() == SyntaxKind::ENTRY);
    let Some(outer_entry) = outer_entry else {
        return false;
    };

    outer_entry
        .children()
        .find(|n| n.kind() == SyntaxKind::KEY)
        .into_iter()
        .flat_map(|key| key.descendants_with_tokens())
        .filter_map(|t| t.into_token())
        .any(|t| t.kind() == SyntaxKind::IDENT && t.text() == "inputs")
}
