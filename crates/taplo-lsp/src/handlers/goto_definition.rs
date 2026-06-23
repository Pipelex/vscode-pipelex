use crate::{
    handlers::mthds_resolution::{classify_reference, resolve_reference, ReferenceKind},
    query::Query,
    world::{DocumentState, World},
};
use lsp_async_stub::{
    rpc::Error,
    util::{LspExt, Mapper, Position},
    Context, Params,
};
use lsp_types::{GotoDefinitionParams, GotoDefinitionResponse, Location, Url};
use std::{
    collections::{HashMap, HashSet},
    fmt::Write,
    path::{Path, PathBuf},
};
use taplo::dom::node::DomNode;
use taplo::{
    dom::{KeyOrIndex, Keys, Node},
    parser,
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

    tracing::debug!(%document_uri, "goto_definition: handling MTHDS file");

    let (doc, open_mthds_documents) = {
        let workspaces = context.workspaces.read().await;
        let ws = workspaces.by_document(&document_uri);
        let doc = match ws.document(&document_uri) {
            Ok(d) => d.clone(),
            Err(error) => {
                tracing::debug!(%error, "goto_definition: failed to get document");
                return Ok(None);
            }
        };
        let open_mthds_documents = ws
            .documents
            .iter()
            .filter(|(uri, _)| uri.as_str().ends_with(".mthds"))
            .map(|(uri, doc)| (uri.clone(), doc.clone()))
            .collect::<Vec<_>>();
        (doc, open_mthds_documents)
    };

    let position = p.text_document_position_params.position;
    let Some(offset) = doc.mapper.offset(Position::from_lsp(position)) else {
        tracing::error!(?position, "document position not found");
        return Ok(None);
    };

    let query = Query::at(&doc.dom, offset);

    let Some(classified) = classify_reference(&query) else {
        tracing::debug!("goto_definition: no reference classified at cursor");
        return Ok(None);
    };

    if matches!(&classified.kind, ReferenceKind::Pipe) {
        let current_domain = document_domain(&doc.dom);
        if let Some(location) = resolve_pipe_definition_across_bundle(
            &context.env,
            &document_uri,
            &open_mthds_documents,
            &classified.ref_name,
            current_domain.as_deref(),
        )
        .await
        {
            tracing::debug!(
                ref_name = %classified.ref_name,
                uri = %location.uri,
                ?location.range,
                "goto_definition: resolved pipe across MTHDS bundle"
            );
            return Ok(Some(GotoDefinitionResponse::Scalar(location)));
        }
    }

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

struct PipeDefinition {
    uri: Url,
    node: Node,
    mapper: Mapper,
    domain: Option<String>,
    is_signature: bool,
}

async fn resolve_pipe_definition_across_bundle<E: Environment>(
    env: &E,
    document_uri: &Url,
    open_mthds_documents: &[(Url, DocumentState)],
    pipe_name: &str,
    preferred_domain: Option<&str>,
) -> Option<Location> {
    let current_path = env.to_file_path_normalized(document_uri)?;
    let current_dir = current_path.parent()?.to_path_buf();

    let mut open_by_path = HashMap::<PathBuf, (Url, DocumentState)>::new();
    for (uri, doc) in open_mthds_documents {
        let Some(path) = env.to_file_path_normalized(uri) else {
            continue;
        };
        if path.parent() == Some(current_dir.as_path()) {
            open_by_path.insert(path, (uri.clone(), doc.clone()));
        }
    }

    let mut paths = bundle_mthds_paths(env, &current_dir);
    if !paths.iter().any(|path| path == &current_path) {
        paths.push(current_path.clone());
    }
    paths.sort();
    paths.sort_by(|a, b| match (a == &current_path, b == &current_path) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.cmp(b),
    });

    let mut seen = HashSet::<PathBuf>::new();
    let mut definitions = Vec::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }

        if let Some((uri, doc)) = open_by_path.remove(&path) {
            if let Some(definition) =
                pipe_definition_from_document(uri, doc.dom, doc.mapper, pipe_name)
            {
                definitions.push(definition);
            }
            continue;
        }

        let Some(uri) = file_url_from_path(&path) else {
            continue;
        };
        let Ok(bytes) = env.read_file(&path).await else {
            continue;
        };
        let Ok(source) = String::from_utf8(bytes) else {
            continue;
        };
        let parse = parser::parse(&source);
        let dom = parse.into_dom();
        let mapper = Mapper::new_utf16(&source, false);
        if let Some(definition) = pipe_definition_from_document(uri, dom, mapper, pipe_name) {
            definitions.push(definition);
        }
    }

    select_preferred_pipe_definition(definitions, preferred_domain)?.into_location()
}

fn bundle_mthds_paths<E: Environment>(env: &E, current_dir: &Path) -> Vec<PathBuf> {
    let mut pattern = current_dir.to_path_buf();
    pattern.push("*.mthds");
    env.glob_files_normalized(&pattern.to_string_lossy())
        .unwrap_or_default()
}

fn file_url_from_path(path: &Path) -> Option<Url> {
    let path = path.to_string_lossy().replace('\\', "/");
    let mut url = String::from("file://");
    if !path.starts_with('/') {
        url.push('/');
    }
    url.push_str(&percent_encode_file_path(&path));
    Url::parse(&url).ok()
}

fn percent_encode_file_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                encoded.push(byte as char)
            }
            _ => {
                write!(&mut encoded, "%{byte:02X}").expect("writing to string cannot fail");
            }
        }
    }
    encoded
}

fn pipe_definition_from_document(
    uri: Url,
    dom: Node,
    mapper: Mapper,
    pipe_name: &str,
) -> Option<PipeDefinition> {
    let domain = document_domain(&dom);
    let node = pipe_node(&dom, pipe_name)?;
    let is_signature = pipe_definition_is_signature(&node);
    Some(PipeDefinition {
        uri,
        node,
        mapper,
        domain,
        is_signature,
    })
}

fn select_preferred_pipe_definition(
    definitions: Vec<PipeDefinition>,
    preferred_domain: Option<&str>,
) -> Option<PipeDefinition> {
    let mut definitions = if let Some(preferred_domain) = preferred_domain {
        let (same_domain, other_domain): (Vec<_>, Vec<_>) = definitions
            .into_iter()
            .partition(|definition| definition.domain.as_deref() == Some(preferred_domain));
        if same_domain.is_empty() {
            other_domain
        } else {
            same_domain
        }
    } else {
        definitions
    };

    definitions.sort_by_key(|definition| definition.is_signature);

    let mut definitions = definitions.into_iter();
    definitions.next()
}

fn pipe_node(dom: &Node, pipe_name: &str) -> Option<Node> {
    let target_keys = Keys::new(
        [
            KeyOrIndex::Key(taplo::dom::node::Key::new("pipe")),
            KeyOrIndex::Key(taplo::dom::node::Key::new(pipe_name)),
        ]
        .into_iter(),
    );
    dom.path(&target_keys)
}

fn pipe_definition_is_signature(node: &Node) -> bool {
    node.get("type")
        .as_str()
        .map(|s| s.value() == "PipeSignature")
        .unwrap_or(false)
}

fn document_domain(dom: &Node) -> Option<String> {
    dom.get("domain")
        .as_str()
        .map(|s| s.value().to_string())
        .filter(|domain| !domain.is_empty())
}

impl PipeDefinition {
    fn into_location(self) -> Option<Location> {
        let syntax = self.node.syntax()?;
        let range = self.mapper.range(syntax.text_range())?;
        Some(Location {
            uri: self.uri,
            range: range.into_lsp(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pipe_definition(uri: &str, source: &str, pipe_name: &str) -> PipeDefinition {
        let parse = parser::parse(source);
        let dom = parse.into_dom();
        let mapper = Mapper::new_utf16(source, false);
        pipe_definition_from_document(Url::parse(uri).unwrap(), dom, mapper, pipe_name).unwrap()
    }

    #[test]
    fn prefers_concrete_definition_over_signature() {
        let signature = pipe_definition(
            "file:///project/bundle.mthds",
            "domain = \"rec\"\n[pipe.screen]\ntype = \"PipeSignature\"\n",
            "screen",
        );
        let concrete = pipe_definition(
            "file:///project/screen.mthds",
            "domain = \"rec\"\n[pipe.screen]\ntype = \"PipeSequence\"\n",
            "screen",
        );

        let selected =
            select_preferred_pipe_definition(vec![signature, concrete], Some("rec")).unwrap();

        assert_eq!(selected.uri.as_str(), "file:///project/screen.mthds");
    }

    #[test]
    fn falls_back_to_first_signature_when_no_concrete_exists() {
        let signature = pipe_definition(
            "file:///project/bundle.mthds",
            "domain = \"rec\"\n[pipe.screen]\ntype = \"PipeSignature\"\n",
            "screen",
        );

        let selected = select_preferred_pipe_definition(vec![signature], Some("rec")).unwrap();

        assert_eq!(selected.uri.as_str(), "file:///project/bundle.mthds");
    }

    #[test]
    fn prefers_concrete_definition_in_matching_domain() {
        let alpha_concrete = pipe_definition(
            "file:///project/alpha.mthds",
            "domain = \"alpha\"\n[pipe.screen]\ntype = \"PipeSequence\"\n",
            "screen",
        );
        let beta_signature = pipe_definition(
            "file:///project/beta_sig.mthds",
            "domain = \"beta\"\n[pipe.screen]\ntype = \"PipeSignature\"\n",
            "screen",
        );
        let beta_concrete = pipe_definition(
            "file:///project/beta_impl.mthds",
            "domain = \"beta\"\n[pipe.screen]\ntype = \"PipeLLM\"\n",
            "screen",
        );

        let selected = select_preferred_pipe_definition(
            vec![alpha_concrete, beta_signature, beta_concrete],
            Some("beta"),
        )
        .unwrap();

        assert_eq!(selected.uri.as_str(), "file:///project/beta_impl.mthds");
    }

    #[test]
    fn builds_file_url_from_unix_path_with_spaces() {
        let url = file_url_from_path(Path::new("/project/my methods/screen.mthds")).unwrap();

        assert_eq!(url.as_str(), "file:///project/my%20methods/screen.mthds");
    }

    #[test]
    fn builds_file_url_from_windows_path() {
        let url = file_url_from_path(Path::new("C:\\project\\screen.mthds")).unwrap();

        assert_eq!(url.as_str(), "file:///C:/project/screen.mthds");
    }
}
