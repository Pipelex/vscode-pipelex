use super::parse_and_query;
use crate::handlers::{is_inside_inputs_inline_table, ReferenceKind};
use taplo::{
    dom::{KeyOrIndex, Keys},
    syntax::SyntaxKind::{IDENT, STRING, STRING_LITERAL},
};

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!(
            "../../../../../test-data/mthds/goto-definition/",
            $name
        ))
    };
}

/// Simulate the goto_definition handler logic for a given TOML source and cursor offset.
/// Returns the root_key ("pipe" or "concept") and the reference name if the handler
/// would produce a result, or None if it would bail.
fn simulate_handler(toml: &str, offset: u32) -> Option<(String, String)> {
    let (dom, query) = parse_and_query(toml, offset);

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

/// Helper: find the byte offset one character past the opening quote of `target`
/// within `source`. Panics if `target` is not found.
fn offset_inside_string(source: &str, target: &str) -> u32 {
    let line_start = source.find(target).unwrap();
    let quote_pos = line_start + target.find('"').unwrap();
    (quote_pos + 1) as u32
}

/// Like [`offset_inside_string`] but searches only after `section_header` first
/// appears in `source`. Useful when `target` occurs multiple times.
fn offset_inside_string_after(source: &str, section_header: &str, target: &str) -> u32 {
    let section = source.find(section_header).unwrap();
    let pos = source[section..].find(target).unwrap() + section;
    let quote_pos = pos + target.find('"').unwrap();
    (quote_pos + 1) as u32
}

#[test]
fn test_pipe_reference() {
    let mthds_code = fixture!("pipe_reference.mthds");
    let offset = offset_inside_string(mthds_code, r#"pipe = "my_pipe""#);

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(result, Some(("pipe".to_string(), "my_pipe".to_string())));
}

#[test]
fn test_concept_output_reference() {
    let mthds_code = fixture!("concept_output.mthds");
    let offset = offset_inside_string(mthds_code, r#"output = "DocumentAnalysis""#);

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(
        result,
        Some(("concept".to_string(), "DocumentAnalysis".to_string()))
    );
}

#[test]
fn test_concept_refines_reference() {
    let mthds_code = fixture!("concept_refines.mthds");
    let offset = offset_inside_string(mthds_code, r#"refines = "Base""#);

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(
        result,
        Some(("concept".to_string(), "Base".to_string()))
    );
}

#[test]
fn test_concept_inputs_inline_table() {
    let mthds_code = fixture!("concept_inputs_inline.mthds");
    let offset = offset_inside_string(mthds_code, r#"photo = "FeatureAnalysis""#);

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(
        result,
        Some(("concept".to_string(), "FeatureAnalysis".to_string()))
    );
}

#[test]
fn test_namespaced_concept_no_match() {
    let mthds_code = fixture!("namespaced_concept.mthds");
    let offset = offset_inside_string(mthds_code, r#"output = "images.Photo""#);

    let result = simulate_handler(mthds_code, offset);
    // No local concept.images.Photo exists, so should return None
    assert_eq!(result, None);
}

#[test]
fn test_unrelated_key_no_match() {
    let mthds_code = fixture!("unrelated_key.mthds");
    let offset = offset_inside_string(mthds_code, r#"description = "SomeString""#);

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(result, None);
}

#[test]
fn test_concept_output_in_full_mthds() {
    let mthds_code = fixture!("document_comparison.mthds");
    let offset = offset_inside_string_after(
        mthds_code,
        "[pipe.analyze_doc_a]",
        r#"output = "DocumentAnalysis""#,
    );

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(
        result,
        Some(("concept".to_string(), "DocumentAnalysis".to_string())),
        "Should resolve output = \"DocumentAnalysis\" to concept.DocumentAnalysis"
    );
}

#[test]
fn test_with_bare_table_headers() {
    let mthds_code = fixture!("extract_slides.mthds");

    // Test main_pipe = "extract_slides"
    {
        let offset = offset_inside_string(mthds_code, r#"main_pipe = "extract_slides""#);
        let result = simulate_handler(mthds_code, offset);
        assert_eq!(
            result,
            Some(("pipe".to_string(), "extract_slides".to_string())),
            "main_pipe reference should resolve"
        );
    }

    // Test pipe = "describe_slide" (inside inline table in array)
    {
        let offset = offset_inside_string(mthds_code, r#"pipe = "describe_slide""#);
        let result = simulate_handler(mthds_code, offset);
        assert_eq!(
            result,
            Some(("pipe".to_string(), "describe_slide".to_string())),
            "pipe reference in steps should resolve"
        );
    }

    // Test output = "Slide" (concept reference)
    {
        let offset = offset_inside_string_after(
            mthds_code,
            "[pipe.describe_slide]",
            r#"output = "Slide""#,
        );
        let result = simulate_handler(mthds_code, offset);
        assert_eq!(
            result,
            Some(("concept".to_string(), "Slide".to_string())),
            "output = \"Slide\" should resolve to concept.Slide"
        );
    }
}
