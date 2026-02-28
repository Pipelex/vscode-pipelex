use super::{offset_inside_string, offset_inside_string_after, parse_and_query};
use crate::handlers::{hover::build_mthds_hover_content, mthds_resolution::resolve_reference};

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!(
            "../../../../../test-data/mthds/hover/",
            $name
        ))
    };
}

#[test]
fn test_hover_pipe_with_full_properties() {
    let src = fixture!("pipe_hover.mthds");
    let offset = offset_inside_string(src, r#"main_pipe   = "run_analysis""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve pipe reference");
    let content = build_mthds_hover_content(&resolved);

    assert!(content.contains("**run_analysis** `PipeLLM`"), "header should show name and type, got: {content}");
    assert!(content.contains("Analyze input and produce a report"), "should contain description");
    assert!(content.contains("**Inputs:**"), "should show inputs");
    assert!(content.contains("`doc`: Document"), "should list doc input");
    assert!(content.contains("`query`: Text"), "should list query input");
    assert!(content.contains("**Output:** `Report`"), "should show output");
}

#[test]
fn test_hover_concept_with_description_and_structure() {
    let src = fixture!("concept_hover.mthds");
    let offset = offset_inside_string_after(src, "[pipe.analyze]", r#"output = "Analysis""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve concept reference");
    let content = build_mthds_hover_content(&resolved);

    assert!(content.contains("**Analysis**"), "header should show concept name, got: {content}");
    assert!(content.contains("Structured analysis output"), "should contain description");
    assert!(content.contains("**Refines:** `Base`"), "should show refines");
    assert!(content.contains("**Fields:**"), "should show fields");
    assert!(content.contains("`summary`"), "should list summary field");
    assert!(content.contains("`details`"), "should list details field");
    assert!(content.contains("`score`"), "should list score field");
}

#[test]
fn test_hover_concept_with_refines() {
    let src = fixture!("concept_hover.mthds");
    let offset = offset_inside_string(src, r#"refines = "Base""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve refines reference");
    let content = build_mthds_hover_content(&resolved);

    assert!(content.contains("**Base**"), "header should show concept name, got: {content}");
    assert!(content.contains("A base concept"), "should contain description");
    assert!(!content.contains("**Fields:**"), "Base has no fields");
    assert!(!content.contains("**Refines:**"), "Base does not refine anything");
}

#[test]
fn test_hover_non_reference_key_returns_none() {
    let src = fixture!("pipe_hover.mthds");
    let offset = offset_inside_string(src, r#"description = "Analyze input and produce a report""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query);
    assert!(resolved.is_none(), "description is not a reference field");
}

#[test]
fn test_hover_nonexistent_reference_returns_none() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
output = "NonexistentConcept"
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"output = "NonexistentConcept""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query);
    assert!(resolved.is_none(), "reference to nonexistent concept should return None");
}

#[test]
fn test_hover_concept_with_indefinite_multiplicity() {
    let src = r#"
domain = "test"

[concept.Slide]
description = "A single slide"

[concept.Slide.structure]
title   = { type = "text", required = true }
content = { type = "text" }

[pipe.extract]
type = "PipeLLM"
output = "Slide[]"
prompt = "Extract slides."
"#;
    let offset = offset_inside_string(src, r#"output = "Slide[]""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve Slide[] to concept.Slide");
    let content = build_mthds_hover_content(&resolved);

    assert!(content.contains("**Slide**"), "header should show concept name, got: {content}");
    assert!(content.contains("A single slide"), "should contain description");
    assert!(content.contains("`title`"), "should list title field");
    assert!(content.contains("`content`"), "should list content field");
}

#[test]
fn test_hover_concept_with_specific_multiplicity() {
    let src = r#"
domain = "test"

[concept.Page]
description = "A document page"

[pipe.extract_pages]
type = "PipeLLM"
output = "Page[5]"
prompt = "Extract 5 pages."
"#;
    let offset = offset_inside_string(src, r#"output = "Page[5]""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve Page[5] to concept.Page");
    let content = build_mthds_hover_content(&resolved);

    assert!(content.contains("**Page**"), "header should show concept name, got: {content}");
    assert!(content.contains("A document page"), "should contain description");
}

#[test]
fn test_hover_concept_with_multiplicity_in_inputs() {
    let src = r#"
domain = "test"

[concept.Item]
description = "An item"

[pipe.process]
type = "PipeLLM"
inputs = { items = "Item[]" }
output = "Item"
prompt = "Process items."
"#;
    let offset = offset_inside_string(src, r#"items = "Item[]""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve Item[] in inputs");
    let content = build_mthds_hover_content(&resolved);

    assert!(content.contains("**Item**"), "header should show concept name, got: {content}");
    assert!(content.contains("An item"), "should contain description");
}

#[test]
fn test_hover_concept_with_domain_prefix_and_multiplicity() {
    // Domain-prefixed concepts (e.g. "images.Photo") refer to external domains,
    // so they won't resolve to a local concept — should return None.
    let src = r#"
domain = "test"

[pipe.process]
type = "PipeLLM"
output = "images.Photo[]"
prompt = "Process."
"#;
    let offset = offset_inside_string(src, r#"output = "images.Photo[]""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query);
    assert!(resolved.is_none(), "domain-prefixed concept not in local file should return None");
}
