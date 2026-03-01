use super::parse_and_query;
use crate::handlers::mthds_resolution::classify_reference;
use taplo::dom::{KeyOrIndex, Keys};

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
///
/// Delegates to `classify_reference` so this test exercises the same code path as production,
/// including `strip_concept_qualifiers` (domain prefix and multiplicity suffix stripping).
fn simulate_handler(toml: &str, offset: u32) -> Option<(String, String)> {
    let (dom, query) = parse_and_query(toml, offset);

    let classified = classify_reference(&query)?;
    let root_key = classified.kind.root_key();

    let target_keys = Keys::new(
        [
            KeyOrIndex::Key(taplo::dom::node::Key::new(root_key)),
            KeyOrIndex::Key(taplo::dom::node::Key::new(&classified.ref_name)),
        ]
        .into_iter(),
    );

    dom.path(&target_keys)?;

    Some((root_key.to_string(), classified.ref_name))
}

use super::{offset_inside_string, offset_inside_string_after};

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
    assert_eq!(result, Some(("concept".to_string(), "Base".to_string())));
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
        let offset = offset_inside_string(mthds_code, r#"main_pipe   = "extract_slides""#);
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
            r#"output      = "Slide""#,
        );
        let result = simulate_handler(mthds_code, offset);
        assert_eq!(
            result,
            Some(("concept".to_string(), "Slide".to_string())),
            "output = \"Slide\" should resolve to concept.Slide"
        );
    }
}

#[test]
fn test_concept_with_multiplicity_suffix() {
    let mthds_code = fixture!("concept_with_multiplicity.mthds");
    let offset = offset_inside_string(mthds_code, r#"output = "Slide[]""#);
    let result = simulate_handler(mthds_code, offset);
    assert_eq!(result, Some(("concept".to_string(), "Slide".to_string())));
}
