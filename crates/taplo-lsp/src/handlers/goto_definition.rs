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

enum ReferenceKind {
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
    if !document_uri.as_str().ends_with(".mthds") {
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
fn is_inside_inputs_inline_table(token: &taplo::syntax::SyntaxToken) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::Query;
    use taplo::{parser::parse, rowan::TextSize};

    /// Simulate the goto_definition handler logic for a given TOML source and cursor offset.
    /// Returns the root_key ("pipe" or "concept") and the reference name if the handler
    /// would produce a result, or None if it would bail.
    fn simulate_handler(toml: &str, offset: u32) -> Option<(String, String)> {
        let parse_result = parse(toml);
        let dom = parse_result.into_dom();
        let query = Query::at(&dom, TextSize::from(offset));

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

        let position_info = position_info?;

        // entry_key
        let entry_key_node = query.entry_key()?;

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
            return None;
        };

        let ref_name = position_info
            .dom_node
            .as_ref()
            .and_then(|(_, node)| node.as_str().map(|s| s.value().to_string()))
            .unwrap_or_else(|| {
                let text = position_info.syntax.text().to_string();
                text.trim_matches('"').trim_matches('\'').to_string()
            });

        if ref_name.is_empty() {
            return None;
        }

        let root_key = match kind {
            ReferenceKind::Pipe => "pipe",
            ReferenceKind::Concept => "concept",
        };

        // Check DOM path exists
        let target_keys = Keys::new(
            [
                KeyOrIndex::Key(taplo::dom::node::Key::new(root_key)),
                KeyOrIndex::Key(taplo::dom::node::Key::new(&ref_name)),
            ]
            .into_iter(),
        );

        dom.path(&target_keys)?;

        Some((root_key.to_string(), ref_name))
    }

    #[test]
    fn test_pipe_reference() {
        let toml = r#"[pipe.my_pipe]
description = "A pipe"

[pipe.other]
pipe = "my_pipe"
"#;
        // Find the offset of "my_pipe" in `pipe = "my_pipe"`
        let target = r#"pipe = "my_pipe""#;
        let line_start = toml.find(target).unwrap();
        let quote_pos = line_start + target.find('"').unwrap();
        // Place cursor inside the string (after the opening quote)
        let offset = (quote_pos + 1) as u32;

        let result = simulate_handler(toml, offset);
        assert_eq!(result, Some(("pipe".to_string(), "my_pipe".to_string())));
    }

    #[test]
    fn test_concept_output_reference() {
        let toml = r#"[concept.DocumentAnalysis]
description = "Analysis"

[pipe.analyze]
output = "DocumentAnalysis"
"#;
        let target = r#"output = "DocumentAnalysis""#;
        let line_start = toml.find(target).unwrap();
        let quote_pos = line_start + target.find('"').unwrap();
        let offset = (quote_pos + 1) as u32;

        let result = simulate_handler(toml, offset);
        assert_eq!(
            result,
            Some(("concept".to_string(), "DocumentAnalysis".to_string()))
        );
    }

    #[test]
    fn test_concept_refines_reference() {
        let toml = r#"[concept.Base]
description = "Base concept"

[concept.Child]
refines = "Base"
"#;
        let target = r#"refines = "Base""#;
        let line_start = toml.find(target).unwrap();
        let quote_pos = line_start + target.find('"').unwrap();
        let offset = (quote_pos + 1) as u32;

        let result = simulate_handler(toml, offset);
        assert_eq!(
            result,
            Some(("concept".to_string(), "Base".to_string()))
        );
    }

    #[test]
    fn test_concept_inputs_inline_table() {
        let toml = r#"[concept.FeatureAnalysis]
description = "Feature analysis"

[pipe.my_pipe]
inputs = { photo = "FeatureAnalysis" }
"#;
        let target = r#"photo = "FeatureAnalysis""#;
        let line_start = toml.find(target).unwrap();
        let quote_pos = line_start + target.find('"').unwrap();
        let offset = (quote_pos + 1) as u32;

        let result = simulate_handler(toml, offset);
        assert_eq!(
            result,
            Some(("concept".to_string(), "FeatureAnalysis".to_string()))
        );
    }

    #[test]
    fn test_namespaced_concept_no_match() {
        let toml = r#"[pipe.my_pipe]
output = "images.Photo"
"#;
        let target = r#"output = "images.Photo""#;
        let line_start = toml.find(target).unwrap();
        let quote_pos = line_start + target.find('"').unwrap();
        let offset = (quote_pos + 1) as u32;

        let result = simulate_handler(toml, offset);
        // No local concept.images.Photo exists, so should return None
        assert_eq!(result, None);
    }

    #[test]
    fn test_unrelated_key_no_match() {
        let toml = r#"[pipe.my_pipe]
description = "SomeString"
"#;
        let target = r#"description = "SomeString""#;
        let line_start = toml.find(target).unwrap();
        let quote_pos = line_start + target.find('"').unwrap();
        let offset = (quote_pos + 1) as u32;

        let result = simulate_handler(toml, offset);
        assert_eq!(result, None);
    }

    #[test]
    fn test_concept_output_in_full_mthds() {
        let toml = r#"domain      = "document_comparison"
description = "Extract and compare two PDF documents, producing a structured comparison report"
main_pipe   = "compare_documents"

[concept.DocumentAnalysis]
description = "Structured analysis of a document's key content"

[concept.DocumentAnalysis.structure]
title      = { type = "text", description = "Document title or identifier", required = true }
key_points = { type = "text", description = "Main points and arguments", required = true }
structure  = { type = "text", description = "Document structure and organization", required = true }
tone       = { type = "text", description = "Writing tone and style" }

[concept.ComparisonReport]
description = "Detailed comparison between two documents"

[concept.ComparisonReport.structure]
similarities     = { type = "text", description = "Key similarities between the documents", required = true }
differences      = { type = "text", description = "Key differences between the documents", required = true }
unique_to_first  = { type = "text", description = "Points unique to the first document", required = true }
unique_to_second = { type = "text", description = "Points unique to the second document", required = true }
recommendation   = { type = "text", description = "Overall assessment and recommendation", required = true }

[pipe.compare_documents]
type = "PipeSequence"
description = "Main pipeline: extract both documents in parallel, analyze them, compare, and produce a report"
inputs = { doc_a = "Document", doc_b = "Document" }
output = "Html"
steps = [
  { pipe = "extract_both", result = "extracted" },
  { pipe = "analyze_both", result = "analyzed" },
  { pipe = "compare_analyses", result = "comparison" },
  { pipe = "render_comparison_report", result = "report_html" },
]

[pipe.analyze_doc_a]
type = "PipeLLM"
description = "Analyze the first document's content"
inputs = { pages_a = "Page" }
output = "DocumentAnalysis"
model = "$retrieval"
system_prompt = "You are a document analysis expert. Extract structured information from documents."
prompt = """
Analyze the following document and extract its key information:

@pages_a
"""
"#;
        // Find the output = "DocumentAnalysis" in the pipe.analyze_doc_a section
        let target = r#"output = "DocumentAnalysis""#;
        // There might be multiple "output" entries; find the one after analyze_doc_a
        let analyze_section = toml.find("[pipe.analyze_doc_a]").unwrap();
        let output_in_section = toml[analyze_section..].find(target).unwrap() + analyze_section;
        let quote_pos = output_in_section + target.find('"').unwrap();
        let offset = (quote_pos + 1) as u32;

        eprintln!("offset: {}", offset);
        eprintln!(
            "char at offset: {:?}",
            toml.chars().nth(offset as usize)
        );

        let result = simulate_handler(toml, offset);
        assert_eq!(
            result,
            Some(("concept".to_string(), "DocumentAnalysis".to_string())),
            "Should resolve output = \"DocumentAnalysis\" to concept.DocumentAnalysis"
        );
    }

    #[test]
    fn test_with_bare_table_headers() {
        // This file has bare [concept] and [pipe] headers before the named entries
        let toml = r#"domain = "extract_slides"
description = "The domain of extracting slides from documents"
main_pipe = "extract_slides"

[concept]
[concept.Slide]
description = "A slide from a presentation"
[concept.Slide.structure]
title = { type = "text", description = "The title of the slide" }

[pipe]

[pipe.extract_slides]
type = "PipeSequence"
description = "Extract markdown from a document"
inputs = { document = "Document" }
output = "Text"
steps = [
    { pipe = "describe_slide", result = "slides" },
]

[pipe.describe_slide]
type = "PipeLLM"
description = "Describe a slide"
inputs = { page = "Page" }
output = "Slide"
"#;
        // Test main_pipe = "extract_slides"
        {
            let target = r#"main_pipe = "extract_slides""#;
            let pos = toml.find(target).unwrap();
            let quote_pos = pos + target.find('"').unwrap();
            let offset = (quote_pos + 1) as u32;
            let result = simulate_handler(toml, offset);
            assert_eq!(
                result,
                Some(("pipe".to_string(), "extract_slides".to_string())),
                "main_pipe reference should resolve"
            );
        }

        // Test pipe = "describe_slide" (inside inline table in array)
        {
            let target = r#"pipe = "describe_slide""#;
            let pos = toml.find(target).unwrap();
            let quote_pos = pos + target.find('"').unwrap();
            let offset = (quote_pos + 1) as u32;
            let result = simulate_handler(toml, offset);
            assert_eq!(
                result,
                Some(("pipe".to_string(), "describe_slide".to_string())),
                "pipe reference in steps should resolve"
            );
        }

        // Test output = "Slide" (concept reference)
        {
            let target = r#"output = "Slide""#;
            // Find the one in pipe.describe_slide (not pipe.extract_slides)
            let describe_section = toml.find("[pipe.describe_slide]").unwrap();
            let pos = toml[describe_section..].find(target).unwrap() + describe_section;
            let quote_pos = pos + target.find('"').unwrap();
            let offset = (quote_pos + 1) as u32;
            let result = simulate_handler(toml, offset);
            assert_eq!(
                result,
                Some(("concept".to_string(), "Slide".to_string())),
                "output = \"Slide\" should resolve to concept.Slide"
            );
        }
    }
}
