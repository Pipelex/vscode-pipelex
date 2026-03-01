use crate::{
    handlers::mthds_resolution::{
        classify_reference, extract_string_value, find_native_concept, find_string_position_info,
        is_model_field, resolve_reference, NativeConcept, ReferenceKind, ResolvedReference,
    },
    query::{lookup_keys, Query},
    world::World,
};
use itertools::Itertools;
use lsp_async_stub::{
    rpc::Error,
    util::{LspExt, Position},
    Context, Params,
};
use lsp_types::{Hover, HoverContents, HoverParams, MarkupContent, MarkupKind};
use serde_json::Value;
use taplo::{
    dom::{KeyOrIndex, Keys},
    syntax::SyntaxKind::{
        self, BOOL, DATE, DATE_TIME_LOCAL, DATE_TIME_OFFSET, IDENT, INTEGER, INTEGER_BIN,
        INTEGER_HEX, INTEGER_OCT, MULTI_LINE_STRING, MULTI_LINE_STRING_LITERAL, STRING,
        STRING_LITERAL, TIME,
    },
};
use taplo_common::{environment::Environment, schema::ext::schema_ext_of};

#[tracing::instrument(skip_all)]
pub(crate) async fn hover<E: Environment>(
    context: Context<World<E>>,
    params: Params<HoverParams>,
) -> Result<Option<Hover>, Error> {
    let p = params.required()?;

    let document_uri = p.text_document_position_params.text_document.uri;

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

    // MTHDS semantic hover: if the cursor is on a reference field (pipe, output,
    // refines, inputs value), resolve it and show rich hover content.
    let is_mthds_file =
        document_uri.as_str().ends_with(".mthds") || document_uri.as_str().ends_with(".plx");
    if is_mthds_file {
        let hover_range = || {
            find_string_position_info(&query)
                .and_then(|pi| doc.mapper.range(pi.syntax.text_range()))
                .map(|r| r.into_lsp())
        };

        if let Some(resolved) = resolve_reference(&doc.dom, &query) {
            let content = build_mthds_hover_content(&resolved);
            if !content.is_empty() {
                return Ok(Some(Hover {
                    contents: HoverContents::Markup(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: content,
                    }),
                    range: hover_range(),
                }));
            }
        } else if let Some(classified) = classify_reference(&query) {
            if matches!(classified.kind, ReferenceKind::Concept) {
                if let Some(native) = find_native_concept(&classified.ref_name) {
                    let content = build_native_concept_hover(native);
                    return Ok(Some(Hover {
                        contents: HoverContents::Markup(MarkupContent {
                            kind: MarkupKind::Markdown,
                            value: content,
                        }),
                        range: hover_range(),
                    }));
                }
            }
        }

        // TODO: Improve model hover with model deck data (preset descriptions,
        // resolved model names, etc.) once model deck access is available.
        if is_model_field(&query) {
            if let Some(pi) = find_string_position_info(&query) {
                let value = extract_string_value(pi);
                if !value.is_empty() {
                    // Look up the pipe type from the parent table's "type" field.
                    let pipe_type = pi.dom_node.as_ref().and_then(|(keys, _)| {
                        // keys points to e.g. pipe.xyz.model — skip last to get pipe.xyz
                        let parent_keys = keys.skip_right(1);
                        let parent = doc.dom.path(&parent_keys)?;
                        let table = parent.as_table()?;
                        table
                            .get("type")
                            .and_then(|n| n.as_str().map(|s| s.value().to_string()))
                    });
                    let content = build_model_hover(&value, pipe_type.as_deref());
                    return Ok(Some(Hover {
                        contents: HoverContents::Markup(MarkupContent {
                            kind: MarkupKind::Markdown,
                            value: content,
                        }),
                        range: hover_range(),
                    }));
                }
            }
        }
    }

    let position_info = match query.before.clone().and_then(|p| {
        if p.syntax.kind() == IDENT || is_primitive(p.syntax.kind()) {
            Some(p)
        } else {
            None
        }
    }) {
        Some(before) => before,
        None => match query.after.clone().and_then(|p| {
            if p.syntax.kind() == IDENT || is_primitive(p.syntax.kind()) {
                Some(p)
            } else {
                None
            }
        }) {
            Some(after) => after,
            None => return Ok(None),
        },
    };

    if let Some(schema_association) = ws.schemas.associations().association_for(&document_uri) {
        tracing::debug!(
            schema.url = %schema_association.url,
            schema.name = schema_association.meta["name"].as_str().unwrap_or(""),
            schema.source = schema_association.meta["source"].as_str().unwrap_or(""),
            "using schema"
        );

        let schema_url = if schema_association.fallback_urls.is_empty() {
            schema_association.url.clone()
        } else {
            match ws.schemas.resolve_association(&schema_association).await {
                Ok((url, _)) => url,
                Err(error) => {
                    tracing::warn!(%error, "schema waterfall resolution failed");
                    return Ok(None);
                }
            }
        };

        let value = match serde_json::to_value(&doc.dom) {
            Ok(v) => v,
            Err(error) => {
                tracing::warn!(%error, "cannot turn DOM into JSON");
                return Ok(None);
            }
        };

        let Some((keys, _)) = &position_info.dom_node else {
            return Ok(None);
        };

        let links_in_hover = !ws.config.schema.links;

        let mut keys = keys.clone();

        if let Some(header_key) = query.header_key() {
            let key_idx = header_key
                .descendants_with_tokens()
                .filter(|t| t.kind() == SyntaxKind::IDENT)
                .position(|t| t.as_token().unwrap() == &position_info.syntax)
                .unwrap();

            keys = lookup_keys(
                doc.dom.clone(),
                &Keys::new(keys.into_iter().take(key_idx + 1)),
            );
        }

        let Some(node) = doc.dom.path(&keys) else {
            return Ok(None);
        };

        if position_info.syntax.kind() == SyntaxKind::IDENT {
            keys = lookup_keys(doc.dom.clone(), &keys);

            // We're interested in the array itself, not its item type.
            if let Some(KeyOrIndex::Index(_)) = keys.iter().last() {
                keys = keys.skip_right(1);
            }

            let schemas = match ws.schemas.schemas_at_path(&schema_url, &value, &keys).await {
                Ok(s) => s,
                Err(error) => {
                    tracing::error!(?error, "schema resolution failed");
                    return Ok(None);
                }
            };

            let content = schemas
                .iter()
                .map(|(_, schema)| {
                    let ext = schema_ext_of(schema).unwrap_or_default();
                    let ext_docs = ext.docs.unwrap_or_default();
                    let ext_links = ext.links.unwrap_or_default();

                    let mut s = String::new();
                    if let Some(docs) = ext_docs.main {
                        s += &docs;
                    } else if let Some(desc) = schema["description"].as_str() {
                        s += desc;
                    }

                    let link_title = schema["title"].as_str().unwrap_or("...");

                    if links_in_hover {
                        if let Some(link) = &ext_links.key {
                            s = format!("[{link_title}]({link})\n\n{s}");
                        }
                    }

                    s
                })
                .filter(|s| !s.trim().is_empty())
                .unique()
                .join("\n\n");

            if content.is_empty() {
                return Ok(None);
            }

            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: content,
                }),
                range: Some(
                    doc.mapper
                        .range(position_info.syntax.text_range())
                        .unwrap()
                        .into_lsp(),
                ),
            }));
        } else if is_primitive(position_info.syntax.kind()) {
            let schemas = match ws.schemas.schemas_at_path(&schema_url, &value, &keys).await {
                Ok(s) => s,
                Err(error) => {
                    tracing::error!(?error, "schema resolution failed");
                    return Ok(None);
                }
            };

            let value = match serde_json::to_value(node) {
                Ok(v) => v,
                Err(error) => {
                    tracing::warn!(%error, "failed to turn DOM into JSON");
                    Value::Null
                }
            };

            let content = schemas
                .iter()
                .map(|(_, schema)| {
                    let ext = schema_ext_of(schema).unwrap_or_default();
                    let ext_docs = ext.docs.unwrap_or_default();
                    let enum_docs = ext_docs.enum_values.unwrap_or_default();

                    let ext_links = ext.links.unwrap_or_default();
                    let enum_links = ext_links.enum_values.unwrap_or_default();

                    if !enum_docs.is_empty() {
                        if let Some(enum_values) = schema["enum"].as_array() {
                            for (idx, val) in enum_values.iter().enumerate() {
                                if val == &value {
                                    if let Some(enum_docs) = enum_docs.get(idx).cloned().flatten() {
                                        if links_in_hover {
                                            let link_title =
                                                schema["title"].as_str().unwrap_or("...");

                                            if let Some(enum_link) =
                                                enum_links.get(idx).and_then(Option::as_ref)
                                            {
                                                return format!(
                                                    "[{link_title}]({enum_link})\n\n{enum_docs}"
                                                );
                                            }
                                        }

                                        return enum_docs;
                                    }
                                }
                            }
                        }
                    }

                    if let (Some(docs), Some(default_value)) =
                        (ext_docs.default_value, schema.get("default"))
                    {
                        if &value == default_value {
                            return docs;
                        }
                    }

                    if let (Some(docs), Some(const_value)) =
                        (ext_docs.const_value, schema.get("const"))
                    {
                        if &value == const_value {
                            return docs;
                        }
                    }

                    if let Some(docs) = ext_docs.main {
                        docs
                    } else if let Some(desc) = schema["description"].as_str() {
                        desc.to_string()
                    } else if let Some(title) = schema["title"].as_str() {
                        title.to_string()
                    } else {
                        String::new()
                    }
                })
                .filter(|s| !s.trim().is_empty())
                .unique()
                .join("\n");

            if content.is_empty() {
                return Ok(None);
            }

            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: content,
                }),
                range: Some(
                    doc.mapper
                        .range(position_info.syntax.text_range())
                        .unwrap()
                        .into_lsp(),
                ),
            }));
        }
    }

    Ok(None)
}

/// Build rich Markdown hover content for a resolved MTHDS reference.
pub(crate) fn build_mthds_hover_content(resolved: &ResolvedReference) -> String {
    let table = match resolved.target_node.as_table() {
        Some(t) => t,
        None => return String::new(),
    };

    let mut parts: Vec<String> = Vec::new();

    match resolved.kind {
        ReferenceKind::Pipe => {
            // Header: **pipe_name** `PipeType`
            let type_str = table
                .get("type")
                .and_then(|n| n.as_str().map(|s| s.value().to_string()));
            let header = match &type_str {
                Some(t) => format!("**{}** `{}`", resolved.ref_name, t),
                None => format!("**{}**", resolved.ref_name),
            };
            parts.push(header);

            // Description
            if let Some(desc) = table
                .get("description")
                .and_then(|n| n.as_str().map(|s| s.value().to_string()))
            {
                if !desc.is_empty() {
                    parts.push(desc);
                }
            }

            // Inputs
            if let Some(inputs_node) = table.get("inputs") {
                if let Some(inputs_table) = inputs_node.as_table() {
                    let entries = inputs_table.entries().read();
                    let input_strs: Vec<String> = entries
                        .iter()
                        .map(|(k, v)| {
                            let concept = v
                                .as_str()
                                .map(|s| s.value().to_string())
                                .unwrap_or_else(|| "?".to_string());
                            format!("`{}`: {}", k.value(), concept)
                        })
                        .collect();
                    if !input_strs.is_empty() {
                        parts.push(format!("**Inputs:** {}", input_strs.join(", ")));
                    }
                }
            }

            // Output
            if let Some(output) = table
                .get("output")
                .and_then(|n| n.as_str().map(|s| s.value().to_string()))
            {
                if !output.is_empty() {
                    parts.push(format!("**Output:** `{}`", output));
                }
            }
        }
        ReferenceKind::Concept => {
            // Header: **ConceptName**
            parts.push(format!("**{}**", resolved.ref_name));

            // Description
            if let Some(desc) = table
                .get("description")
                .and_then(|n| n.as_str().map(|s| s.value().to_string()))
            {
                if !desc.is_empty() {
                    parts.push(desc);
                }
            }

            // Refines
            if let Some(refines) = table
                .get("refines")
                .and_then(|n| n.as_str().map(|s| s.value().to_string()))
            {
                if !refines.is_empty() {
                    parts.push(format!("**Refines:** `{}`", refines));
                }
            }

            // Structure fields
            if let Some(structure_node) = table.get("structure") {
                if let Some(structure_table) = structure_node.as_table() {
                    let entries = structure_table.entries().read();
                    let field_names: Vec<String> = entries
                        .iter()
                        .map(|(k, _)| format!("`{}`", k.value()))
                        .collect();
                    if !field_names.is_empty() {
                        parts.push(format!("**Fields:** {}", field_names.join(", ")));
                    }
                }
            }
        }
    }

    parts.join("\n\n")
}

/// Build a simple hover for a model field value.
///
/// Recognizes the prefix convention (`$` preset, `@` alias, `~` waterfall,
/// `#` handle) and shows a short, readable label.
///
/// When `pipe_type` is provided (e.g. `"PipeLLM"`), strips the `"Pipe"` prefix
/// and prepends it to give context: `**gpt-4o** — LLM model preset`.
pub(crate) fn build_model_hover(value: &str, pipe_type: Option<&str>) -> String {
    let (kind, name) = match value.chars().next() {
        Some('$') => ("preset", &value[1..]),
        Some('@') => ("alias", &value[1..]),
        Some('~') => ("waterfall", &value[1..]),
        Some('#') => ("handle", &value[1..]),
        _ => ("", value),
    };
    let type_prefix = pipe_type
        .and_then(|t| t.strip_prefix("Pipe"))
        .filter(|s| !s.is_empty());
    match (type_prefix, kind) {
        (Some(prefix), "") => format!("**{}** — {} model", name, prefix),
        (Some(prefix), _) => format!("**{}** — {} model {}", name, prefix, kind),
        (_, "") => format!("**{}** — model", name),
        (_, _) => format!("**{}** — model {}", name, kind),
    }
}

/// Build Markdown hover content for a native (built-in) concept.
pub(crate) fn build_native_concept_hover(concept: &NativeConcept) -> String {
    let mut parts: Vec<String> = Vec::new();

    parts.push(format!("**{}** *(native)*", concept.name));
    parts.push(concept.description.to_string());

    if !concept.fields.is_empty() {
        let field_strs: Vec<String> = concept
            .fields
            .iter()
            .map(|(name, ty)| format!("`{}`: {}", name, ty))
            .collect();
        parts.push(format!("**Fields:** {}", field_strs.join(", ")));
    }

    parts.join("\n\n")
}

fn is_primitive(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        BOOL | DATE
            | DATE_TIME_LOCAL
            | DATE_TIME_OFFSET
            | TIME
            | STRING
            | MULTI_LINE_STRING
            | STRING_LITERAL
            | MULTI_LINE_STRING_LITERAL
            | INTEGER
            | INTEGER_HEX
            | INTEGER_OCT
            | INTEGER_BIN
    )
}
