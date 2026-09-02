use super::{offset_inside_string, offset_inside_string_after, parse_and_query};
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

// ---------------------------------------------------------------------------
// Expanded input slots: `notes = { concept = "Text", hints = { … } }`
// ---------------------------------------------------------------------------

macro_rules! corpus {
    ($name:literal) => {
        include_str!(concat!(
            "../../../../../test-data/mthds-corpus/entries/",
            $name
        ))
    };
}

/// Classify without the DOM lookup that [`simulate_handler`] performs.
///
/// The negative cases need this: a `None` from `simulate_handler` could also mean
/// "classified as a reference, but no such node in the DOM", which is not what they
/// are asserting.
fn classify_at(toml: &str, offset: u32) -> Option<(String, String)> {
    let (_dom, query) = parse_and_query(toml, offset);
    classify_reference(&query).map(|c| (c.kind.root_key().to_string(), c.ref_name))
}

#[test]
fn test_concept_in_expanded_input_slot() {
    let mthds_code = fixture!("concept_inputs_expanded.mthds");
    let offset = offset_inside_string(mthds_code, r#"concept = "HostNotes""#);

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(
        result,
        Some(("concept".to_string(), "HostNotes".to_string())),
        "the concept key of an expanded slot should resolve"
    );
}

#[test]
fn test_string_form_slot_beside_an_expanded_one() {
    let mthds_code = fixture!("concept_inputs_expanded.mthds");
    let offset = offset_inside_string(mthds_code, r#"title = "BookTitle""#);

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(
        result,
        Some(("concept".to_string(), "BookTitle".to_string())),
        "a string-form slot next to an expanded one should still resolve"
    );
}

#[test]
fn test_slot_named_concept_still_resolves() {
    let mthds_code = fixture!("concept_inputs_expanded.mthds");
    let offset = offset_inside_string_after(
        mthds_code,
        "[pipe.slot_named_concept]",
        r#"concept = "HostNotes""#,
    );

    let result = simulate_handler(mthds_code, offset);
    assert_eq!(
        result,
        Some(("concept".to_string(), "HostNotes".to_string())),
        "depth decides, not the key name: a string-form slot called `concept` is a slot"
    );
}

#[test]
fn test_hint_value_is_not_a_reference() {
    let mthds_code = fixture!("concept_inputs_expanded.mthds");
    let offset = offset_inside_string(mthds_code, r#"intent = "prose""#);

    assert_eq!(
        classify_at(mthds_code, offset),
        None,
        "a presentation hint is not a concept reference"
    );
}

#[test]
fn test_slot_spread_over_lines_does_not_resolve_in_either_form() {
    // A newline inside an inline table is invalid TOML, and taplo's recovery does not
    // keep the nesting: every `key = value` becomes a sibling ENTRY of ROOT, so there is
    // no `inputs` ancestor left to read. That limit is the parser's and it predates the
    // expanded form — the string form below is flattened exactly the same way — so both
    // are pinned here to show the expanded form is no worse, not to bless the behaviour.
    let src = r#"
domain = "test"

[concept.HostNotes]
description = "Notes"

[pipe.expanded]
type = "PipeLLM"
description = "Multi-line expanded slot"
inputs = {
    notes = {
        concept = "HostNotes",
        hints = { intent = "prose" }
    }
}
output = "HostNotes"

[pipe.string_form]
type = "PipeLLM"
description = "Multi-line string-form slot"
inputs = {
    notes = "HostNotes"
}
output = "HostNotes"
"#;

    let expanded = offset_inside_string(src, r#"concept = "HostNotes""#);
    assert_eq!(
        classify_at(src, expanded),
        None,
        "a multi-line inline table is flattened by the parser, so the expanded form cannot resolve"
    );

    let string_form =
        offset_inside_string_after(src, "[pipe.string_form]", r#"notes = "HostNotes""#);
    assert_eq!(
        classify_at(src, string_form),
        None,
        "the string form is flattened the same way — this is the parser's limit, not the classifier's"
    );
}

#[test]
fn test_non_concept_key_in_slot_table_is_not_a_reference() {
    let src = r#"
domain = "test"

[concept.HostNotes]
description = "Notes"

[pipe.write_card]
type = "PipeLLM"
description = "A slot table with a key that is not `concept`"
inputs = { notes = { concept = "HostNotes", description = "HostNotes" } }
output = "HostNotes"
"#;
    let offset = offset_inside_string(src, r#"description = "HostNotes""#);

    assert_eq!(
        classify_at(src, offset),
        None,
        "only the `concept` key of a slot table carries a concept reference"
    );
}

#[test]
fn test_inline_table_under_another_key_is_not_a_reference() {
    let src = r#"
domain = "test"

[concept.Foo]
description = "Foo"

[pipe.write_card]
type = "PipeLLM"
description = "An inline table under a key that is not `inputs`"
options = { concept = "Foo" }
output = "Foo"
"#;
    let offset = offset_inside_string(src, r#"concept = "Foo""#);

    assert_eq!(
        classify_at(src, offset),
        None,
        "a `concept` key outside `inputs` is not a slot"
    );
}

#[test]
fn test_array_value_inside_inputs_is_not_a_reference() {
    let src = r#"
domain = "test"

[concept.BookTitle]
description = "Title"

[pipe.write_card]
type = "PipeLLM"
description = "An array is not a slot declaration form"
inputs = { many = ["BookTitle"] }
output = "BookTitle"
"#;
    let offset = offset_inside_string(src, r#"["BookTitle"]"#);

    assert_eq!(
        classify_at(src, offset),
        None,
        "an array breaks the slot chain"
    );
}

#[test]
fn test_corpus_expanded_slot_classifies_as_concept() {
    let mthds_code = corpus!("feature_intent_hints_reading_circle/bundle.mthds");
    let offset = offset_inside_string(mthds_code, r#"concept = "Text""#);

    assert_eq!(
        classify_at(mthds_code, offset),
        Some(("concept".to_string(), "Text".to_string())),
        "the corpus entry's expanded slot should classify as a concept reference"
    );
}

#[test]
fn test_corpus_hint_value_is_not_a_reference() {
    let mthds_code = corpus!("feature_intent_hints_reading_circle/bundle.mthds");
    // The first `intent = "prose"` is a structure-field hint; the one inside the pipe's
    // `inputs` is the slot hint this fix must leave alone.
    let offset = offset_inside_string_after(mthds_code, "[pipe.write_card]", r#"intent = "prose""#);

    assert_eq!(
        classify_at(mthds_code, offset),
        None,
        "the corpus entry's slot hint should not classify as a reference"
    );
}
