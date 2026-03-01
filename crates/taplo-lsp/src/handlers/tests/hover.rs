use super::{offset_inside_string, offset_inside_string_after, parse_and_query};
use crate::handlers::{
    hover::{build_model_hover, build_mthds_hover_content, build_native_concept_hover},
    mthds_resolution::{
        classify_reference, find_native_concept, is_model_field, resolve_reference, ReferenceKind,
    },
};

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../../../../test-data/mthds/hover/", $name))
    };
}

#[test]
fn test_hover_pipe_with_full_properties() {
    let src = fixture!("pipe_hover.mthds");
    let offset = offset_inside_string(src, r#"main_pipe   = "run_analysis""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve pipe reference");
    let content = build_mthds_hover_content(&resolved);

    assert!(
        content.contains("**run_analysis** `PipeLLM`"),
        "header should show name and type, got: {content}"
    );
    assert!(
        content.contains("Analyze input and produce a report"),
        "should contain description"
    );
    assert!(content.contains("**Inputs:**"), "should show inputs");
    assert!(content.contains("`doc`: Document"), "should list doc input");
    assert!(content.contains("`query`: Text"), "should list query input");
    assert!(
        content.contains("**Output:** `Report`"),
        "should show output"
    );
}

#[test]
fn test_hover_concept_with_description_and_structure() {
    let src = fixture!("concept_hover.mthds");
    let offset = offset_inside_string_after(src, "[pipe.analyze]", r#"output      = "Analysis""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve concept reference");
    let content = build_mthds_hover_content(&resolved);

    assert!(
        content.contains("**Analysis**"),
        "header should show concept name, got: {content}"
    );
    assert!(
        content.contains("Structured analysis output"),
        "should contain description"
    );
    assert!(
        content.contains("**Refines:** `Base`"),
        "should show refines"
    );
    assert!(content.contains("**Fields:**"), "should show fields");
    assert!(content.contains("`summary`"), "should list summary field");
    assert!(content.contains("`details`"), "should list details field");
    assert!(content.contains("`score`"), "should list score field");
}

#[test]
fn test_hover_concept_with_refines() {
    let src = fixture!("concept_hover.mthds");
    let offset = offset_inside_string(src, r#"refines     = "Base""#);

    let (dom, query) = parse_and_query(src, offset);
    let resolved = resolve_reference(&dom, &query).expect("should resolve refines reference");
    let content = build_mthds_hover_content(&resolved);

    assert!(
        content.contains("**Base**"),
        "header should show concept name, got: {content}"
    );
    assert!(
        content.contains("A base concept"),
        "should contain description"
    );
    assert!(!content.contains("**Fields:**"), "Base has no fields");
    assert!(
        !content.contains("**Refines:**"),
        "Base does not refine anything"
    );
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
    assert!(
        resolved.is_none(),
        "reference to nonexistent concept should return None"
    );
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
    let resolved =
        resolve_reference(&dom, &query).expect("should resolve Slide[] to concept.Slide");
    let content = build_mthds_hover_content(&resolved);

    assert!(
        content.contains("**Slide**"),
        "header should show concept name, got: {content}"
    );
    assert!(
        content.contains("A single slide"),
        "should contain description"
    );
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

    assert!(
        content.contains("**Page**"),
        "header should show concept name, got: {content}"
    );
    assert!(
        content.contains("A document page"),
        "should contain description"
    );
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

    assert!(
        content.contains("**Item**"),
        "header should show concept name, got: {content}"
    );
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
    assert!(
        resolved.is_none(),
        "domain-prefixed concept not in local file should return None"
    );
}

// ---------------------------------------------------------------------------
// Native concept hover tests
// ---------------------------------------------------------------------------

#[test]
fn test_hover_native_concept_text() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
output = "Text"
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"output = "Text""#);

    let (dom, query) = parse_and_query(src, offset);
    // Should NOT resolve in DOM (no concept.Text defined)
    assert!(resolve_reference(&dom, &query).is_none());

    // Should classify and find native concept
    let classified = classify_reference(&query).expect("should classify as concept reference");
    assert!(matches!(classified.kind, ReferenceKind::Concept));
    assert_eq!(classified.ref_name, "Text");

    let native = find_native_concept(&classified.ref_name).expect("Text is a native concept");
    let content = build_native_concept_hover(native);

    assert!(
        content.contains("**Text** *(native)*"),
        "header should show name with native tag, got: {content}"
    );
    assert!(
        content.contains("Plain text content"),
        "should contain description"
    );
    assert!(content.contains("**Fields:**"), "should show fields");
    assert!(content.contains("`text`: str"), "should list text field");
}

#[test]
fn test_hover_native_concept_with_multiplicity() {
    let src = r#"
domain = "test"

[pipe.extract]
type = "PipeExtract"
inputs = { document = "Document" }
output = "Page[]"
"#;
    let offset = offset_inside_string(src, r#"output = "Page[]""#);

    let (_dom, query) = parse_and_query(src, offset);
    let classified = classify_reference(&query).expect("should classify");
    assert_eq!(classified.ref_name, "Page");

    let native = find_native_concept(&classified.ref_name).expect("Page is native");
    let content = build_native_concept_hover(native);

    assert!(content.contains("**Page** *(native)*"), "got: {content}");
    assert!(
        content.contains("single page extracted from a document"),
        "should contain description"
    );
    assert!(
        content.contains("`text_and_images`"),
        "should list text_and_images field"
    );
    assert!(
        content.contains("`page_view`"),
        "should list page_view field"
    );
}

#[test]
fn test_hover_native_concept_in_inputs() {
    let src = r#"
domain = "test"

[pipe.analyze]
type = "PipeLLM"
inputs = { doc = "Document" }
output = "Text"
prompt = "Analyze."
"#;
    let offset = offset_inside_string(src, r#"doc = "Document""#);

    let (dom, query) = parse_and_query(src, offset);
    assert!(resolve_reference(&dom, &query).is_none());

    let classified = classify_reference(&query).expect("should classify");
    assert!(matches!(classified.kind, ReferenceKind::Concept));
    assert_eq!(classified.ref_name, "Document");

    let native = find_native_concept(&classified.ref_name).expect("Document is native");
    let content = build_native_concept_hover(native);

    assert!(
        content.contains("**Document** *(native)*"),
        "got: {content}"
    );
    assert!(content.contains("`url`: str"), "should list url field");
    assert!(content.contains("`filename`"), "should list filename field");
}

#[test]
fn test_hover_native_concept_with_domain_prefix() {
    let src = r#"
domain = "test"

[pipe.process]
type = "PipeLLM"
output = "native.Image"
prompt = "Process."
"#;
    let offset = offset_inside_string(src, r#"output = "native.Image""#);

    let (dom, query) = parse_and_query(src, offset);
    assert!(resolve_reference(&dom, &query).is_none());

    let classified = classify_reference(&query).expect("should classify");
    assert_eq!(
        classified.ref_name, "Image",
        "domain prefix should be stripped"
    );

    let native = find_native_concept(&classified.ref_name).expect("Image is native");
    let content = build_native_concept_hover(native);

    assert!(content.contains("**Image** *(native)*"), "got: {content}");
    assert!(
        content.contains("image with URL"),
        "should contain description"
    );
    assert!(content.contains("`url`: str"), "should list url field");
    assert!(content.contains("`caption`"), "should list caption field");
}

#[test]
fn test_hover_native_concept_anything() {
    let src = r#"
domain = "test"

[pipe.passthrough]
type = "PipeLLM"
output = "Anything"
prompt = "Pass."
"#;
    let offset = offset_inside_string(src, r#"output = "Anything""#);

    let (_dom, query) = parse_and_query(src, offset);
    let classified = classify_reference(&query).expect("should classify");
    let native = find_native_concept(&classified.ref_name).expect("Anything is native");
    let content = build_native_concept_hover(native);

    assert!(
        content.contains("**Anything** *(native)*"),
        "got: {content}"
    );
    assert!(
        content.contains("Accepts any content type"),
        "should contain description"
    );
    assert!(!content.contains("**Fields:**"), "Anything has no fields");
}

// ---------------------------------------------------------------------------
// Model field hover tests
// ---------------------------------------------------------------------------

#[test]
fn test_hover_model_field_detected() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
model = "$gpt-4o"
output = "Text"
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"model = "$gpt-4o""#);

    let (_dom, query) = parse_and_query(src, offset);
    assert!(is_model_field(&query), "model field should be detected");
}

#[test]
fn test_hover_model_field_not_on_other_fields() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
model = "$gpt-4o"
output = "Text"
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"output = "Text""#);

    let (_dom, query) = parse_and_query(src, offset);
    assert!(
        !is_model_field(&query),
        "output field should not be detected as model"
    );
}

#[test]
fn test_hover_model_field_not_inside_inputs_inline_table() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
model = "$gpt-4o"
output = "Text"
inputs = { model = "CustomConcept" }
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"model = "CustomConcept""#);

    let (_dom, query) = parse_and_query(src, offset);
    assert!(
        !is_model_field(&query),
        "model inside inputs inline table should not be detected as model field"
    );
}

#[test]
fn test_build_model_hover_with_pipe_type() {
    let content = build_model_hover("$gpt-4o", Some("PipeLLM"));
    assert_eq!(content, "**gpt-4o** — LLM model preset", "got: {content}");
}

#[test]
fn test_build_model_hover_without_pipe_type() {
    let content = build_model_hover("$gpt-4o", None);
    assert_eq!(content, "**gpt-4o** — model preset", "got: {content}");
}

#[test]
fn test_build_model_hover_alias() {
    let content = build_model_hover("@my-alias", Some("PipeExtract"));
    assert_eq!(
        content, "**my-alias** — Extract model alias",
        "got: {content}"
    );
}

#[test]
fn test_build_model_hover_bare_model() {
    let content = build_model_hover("claude-3-opus", Some("PipeLLM"));
    assert_eq!(content, "**claude-3-opus** — LLM model", "got: {content}");
}

#[test]
fn test_build_model_hover_pipe_type_without_prefix() {
    // If type doesn't start with "Pipe", no prefix is shown
    let content = build_model_hover("$gpt-4o", Some("SomethingElse"));
    assert_eq!(content, "**gpt-4o** — model preset", "got: {content}");
}

// ---------------------------------------------------------------------------
// classify_reference edge cases: degenerate concept qualifiers
// ---------------------------------------------------------------------------

#[test]
fn test_classify_reference_bare_brackets_returns_none() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
output = "[]"
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"output = "[]""#);

    let (_dom, query) = parse_and_query(src, offset);
    assert!(
        classify_reference(&query).is_none(),
        "bare brackets should not classify as a valid reference"
    );
}

#[test]
fn test_classify_reference_lone_dot_returns_none() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
output = "."
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"output = ".""#);

    let (_dom, query) = parse_and_query(src, offset);
    assert!(
        classify_reference(&query).is_none(),
        "lone dot should not classify as a valid reference"
    );
}

#[test]
fn test_classify_reference_specific_count_only_returns_none() {
    let src = r#"
domain = "test"

[pipe.my_pipe]
type = "PipeLLM"
output = "[5]"
prompt = "hello"
"#;
    let offset = offset_inside_string(src, r#"output = "[5]""#);

    let (_dom, query) = parse_and_query(src, offset);
    assert!(
        classify_reference(&query).is_none(),
        "specific count only should not classify as a valid reference"
    );
}
