use crate::query::{PositionInfo, Query};
use taplo::{
    dom::{KeyOrIndex, Keys, Node},
    syntax::SyntaxKind::{self, IDENT, STRING, STRING_LITERAL},
};

pub(crate) enum ReferenceKind {
    Pipe,
    Concept,
}

pub(crate) struct ResolvedReference {
    pub(crate) kind: ReferenceKind,
    pub(crate) ref_name: String,
    pub(crate) target_node: Node,
}

/// A reference that has been classified (kind + stripped name) but not yet
/// resolved against the DOM. Useful for the native-concept fallback path
/// where there is no DOM node to resolve to.
pub(crate) struct ClassifiedReference {
    pub(crate) kind: ReferenceKind,
    pub(crate) ref_name: String,
}

impl ReferenceKind {
    pub(crate) fn root_key(&self) -> &'static str {
        match self {
            ReferenceKind::Pipe => "pipe",
            ReferenceKind::Concept => "concept",
        }
    }
}

// ---------------------------------------------------------------------------
// Native concept registry
// ---------------------------------------------------------------------------

pub(crate) struct NativeConcept {
    pub name: &'static str,
    pub description: &'static str,
    pub fields: &'static [(&'static str, &'static str)],
}

static NATIVE_CONCEPTS: &[NativeConcept] = &[
    NativeConcept {
        name: "Text",
        description: "Plain text content.",
        fields: &[("text", "str")],
    },
    NativeConcept {
        name: "Number",
        description: "A numeric value (integer or float).",
        fields: &[("number", "int | float")],
    },
    NativeConcept {
        name: "YesNo",
        description: "The answer to a yes/no question.",
        fields: &[("yes_no", "bool")],
    },
    NativeConcept {
        name: "Date",
        description: "A calendar date, optionally with a time of day.",
        fields: &[("date", "date"), ("time", "time?")],
    },
    NativeConcept {
        name: "Time",
        description: "A time of day, optionally with a UTC offset.",
        fields: &[("time", "time")],
    },
    NativeConcept {
        name: "Image",
        description: "An image with URL and optional metadata.",
        fields: &[
            ("url", "str"),
            ("filename", "str?"),
            ("caption", "str?"),
            ("mime_type", "str?"),
        ],
    },
    NativeConcept {
        name: "Document",
        description: "A document file (e.g. PDF) with URL and metadata.",
        fields: &[("url", "str"), ("filename", "str?"), ("mime_type", "str?")],
    },
    NativeConcept {
        name: "Html",
        description: "HTML content with an inner HTML string and CSS class.",
        fields: &[("inner_html", "str"), ("css_class", "str")],
    },
    NativeConcept {
        name: "TextAndImages",
        description: "Composite content holding text and associated images.",
        fields: &[("text", "TextContent?"), ("images", "list[ImageContent]?")],
    },
    NativeConcept {
        name: "Page",
        description: "A single page extracted from a document.",
        fields: &[
            ("text_and_images", "TextAndImagesContent"),
            ("page_view", "ImageContent?"),
        ],
    },
    NativeConcept {
        name: "JSON",
        description: "A JSON object.",
        fields: &[("json_obj", "dict")],
    },
    NativeConcept {
        name: "SearchResult",
        description: "A web search result with answer and sources.",
        fields: &[("answer", "str"), ("sources", "list[DocumentContent]")],
    },
    NativeConcept {
        name: "Anything",
        description: "Accepts any content type.",
        fields: &[],
    },
    NativeConcept {
        name: "Dynamic",
        description: "Dynamic content with user-defined fields.",
        fields: &[],
    },
    NativeConcept {
        name: "Composite",
        description: "A named composition of contents.",
        fields: &[],
    },
];

pub(crate) fn find_native_concept(name: &str) -> Option<&'static NativeConcept> {
    NATIVE_CONCEPTS.iter().find(|c| c.name == name)
}

/// Find a STRING or STRING_LITERAL `PositionInfo` from the query's before/after.
pub(crate) fn find_string_position_info(query: &Query) -> Option<&PositionInfo> {
    query
        .before
        .as_ref()
        .filter(|p| matches!(p.syntax.kind(), STRING | STRING_LITERAL))
        .or_else(|| {
            query
                .after
                .as_ref()
                .filter(|p| matches!(p.syntax.kind(), STRING | STRING_LITERAL))
        })
}

/// Extract the string value from a `PositionInfo`, preferring the DOM node's
/// parsed value and falling back to stripping quotes from the syntax token.
pub(crate) fn extract_string_value(position_info: &PositionInfo) -> String {
    position_info
        .dom_node
        .as_ref()
        .and_then(|(_, node)| node.as_str().map(|s| s.value().to_string()))
        .unwrap_or_else(|| {
            let text = position_info.syntax.text().to_string();
            text.trim_matches('"').trim_matches('\'').to_string()
        })
}

/// Check whether the cursor is on a `model` or `model_to_structure` string value.
///
/// Returns `false` if the token is the concept of an input slot, since an input slot
/// named `model` is a concept reference, not a model field — in either slot form,
/// `inputs = { model = "X" }` and `inputs = { model = { concept = "X" } }`.
pub(crate) fn is_model_field(query: &Query) -> bool {
    let Some(position_info) = find_string_position_info(query) else {
        return false;
    };
    if is_input_slot_concept(&position_info.syntax) {
        return false;
    }
    let Some(entry_key_node) = query.entry_key() else {
        return false;
    };
    let key_text: String = entry_key_node
        .descendants_with_tokens()
        .filter_map(|t| t.into_token())
        .filter(|t| t.kind() == IDENT)
        .map(|t| t.text().to_string())
        .collect::<Vec<_>>()
        .join(".");
    matches!(key_text.as_str(), "model" | "model_to_structure")
}

/// Classify a reference at the cursor position without resolving it in the DOM.
///
/// Determines the reference kind (pipe or concept) and extracts the bare
/// reference name (stripping domain prefix and multiplicity for concepts).
/// Returns `None` if the cursor is not on a reference field.
#[allow(clippy::if_same_then_else)] // branches are semantically distinct (key match vs. AST walk)
pub(crate) fn classify_reference(query: &Query) -> Option<ClassifiedReference> {
    let position_info = find_string_position_info(query)?;

    let entry_key_node = query.entry_key()?;

    let key_text: String = entry_key_node
        .descendants_with_tokens()
        .filter_map(|t| t.into_token())
        .filter(|t| t.kind() == IDENT)
        .map(|t| t.text().to_string())
        .collect::<Vec<_>>()
        .join(".");

    let kind = if matches!(
        key_text.as_str(),
        "pipe" | "main_pipe" | "default_pipe_code"
    ) {
        ReferenceKind::Pipe
    } else if matches!(key_text.as_str(), "output" | "refines") {
        ReferenceKind::Concept
    } else if is_input_slot_concept(&position_info.syntax) {
        ReferenceKind::Concept
    } else {
        return None;
    };

    let raw_ref_name = extract_string_value(position_info);

    if raw_ref_name.is_empty() {
        return None;
    }

    // For concept references, strip multiplicity suffix (e.g. "Slide[]" → "Slide",
    // "Page[5]" → "Page") and optional domain prefix (e.g. "images.Photo" → "Photo").
    let ref_name = match kind {
        ReferenceKind::Concept => strip_concept_qualifiers(&raw_ref_name),
        ReferenceKind::Pipe => raw_ref_name,
    };

    if ref_name.is_empty() {
        return None;
    }

    Some(ClassifiedReference { kind, ref_name })
}

/// Resolve a reference at the cursor position in the DOM.
///
/// Checks if the cursor is on a STRING token inside a reference field
/// (`pipe`, `main_pipe`, `default_pipe_code`, `output`, `refines`, or the concept
/// of an `inputs = { ... }` slot in either form — see [`is_input_slot_concept`]),
/// extracts the reference name, and looks up the corresponding `pipe.<name>` or
/// `concept.<name>` in the DOM.
pub(crate) fn resolve_reference(dom: &Node, query: &Query) -> Option<ResolvedReference> {
    let classified = classify_reference(query)?;

    let root_key = classified.kind.root_key();

    let target_keys = Keys::new(
        [
            KeyOrIndex::Key(taplo::dom::node::Key::new(root_key)),
            KeyOrIndex::Key(taplo::dom::node::Key::new(&classified.ref_name)),
        ]
        .into_iter(),
    );

    let target_node = dom.path(&target_keys)?;

    Some(ResolvedReference {
        kind: classified.kind,
        ref_name: classified.ref_name,
        target_node,
    })
}

/// Strip domain prefix and multiplicity suffix from a concept reference string.
///
/// Examples:
/// - `"Slide[]"` → `"Slide"`
/// - `"Page[5]"` → `"Page"`
/// - `"images.Photo"` → `"Photo"`
/// - `"legal.Contract[]"` → `"Contract"`
/// - `"Analysis"` → `"Analysis"` (unchanged)
fn strip_concept_qualifiers(name: &str) -> String {
    // Strip multiplicity suffix: everything from '[' onwards
    let without_mult = match name.find('[') {
        Some(pos) => &name[..pos],
        None => name,
    };
    // Strip domain prefix: everything up to and including the last '.'
    let without_domain = match without_mult.rfind('.') {
        Some(pos) => &without_mult[pos + 1..],
        None => without_mult,
    };
    without_domain.to_string()
}

/// Check whether a syntax token is the concept of a pipe input slot.
///
/// MTHDS gives a slot declaration two equivalent forms (`mthds-format.md`,
/// "Input slot declarations"):
///
/// - the string form, `notes = "Text"`, where the slot's value *is* the concept;
/// - the expanded form, `notes = { concept = "Text", hints = { intent = "prose" } }`,
///   where the concept sits under the slot table's `concept` key.
///
/// A string is a concept reference in exactly those two positions, so this reads the
/// chain of inline-table entry keys containing the token — innermost first, via
/// [`inline_entry_chain`] — and accepts only two shapes:
///
/// - `[<slot>, inputs]` — the string form;
/// - `[concept, <slot>, inputs]` — the expanded form.
///
/// Depth decides, not the key name. `inputs = { concept = "Text" }` is the string form
/// of a slot that happens to be called `concept`, and still resolves; a `concept` key
/// one level deeper never does. The narrowness is deliberate: a walk that merely looked
/// for an `inputs` ancestor would also reach `inputs` from `hints = { intent = "prose" }`
/// and offer goto-definition on a presentation hint, and it would misread whatever
/// per-slot key the standard adds next the same way.
pub(crate) fn is_input_slot_concept(token: &taplo::syntax::SyntaxToken) -> bool {
    match inline_entry_chain(token).as_slice() {
        [_slot, inputs] => inputs == "inputs",
        [concept, _slot, inputs] => concept == "concept" && inputs == "inputs",
        _ => false,
    }
}

/// Collect the keys of the `ENTRY` nodes containing `token`, innermost first,
/// following only `VALUE → INLINE_TABLE → VALUE → ENTRY` steps.
///
/// The walk is strict on purpose: an `ARRAY` between the token and its entry, as in
/// `xs = ["Foo"]`, breaks the chain, because an array is not a slot declaration form.
/// The chain ends at the first entry that is not itself inside an inline table.
fn inline_entry_chain(token: &taplo::syntax::SyntaxToken) -> Vec<String> {
    let mut chain = Vec::new();

    let mut entry = token
        .parent()
        .filter(|n| n.kind() == SyntaxKind::VALUE)
        .and_then(|value| value.parent())
        .filter(|n| n.kind() == SyntaxKind::ENTRY);

    while let Some(node) = entry {
        chain.push(entry_key_text(&node));
        entry = node
            .parent()
            .filter(|n| n.kind() == SyntaxKind::INLINE_TABLE)
            .and_then(|table| table.parent())
            .filter(|n| n.kind() == SyntaxKind::VALUE)
            .and_then(|value| value.parent())
            .filter(|n| n.kind() == SyntaxKind::ENTRY);
    }

    chain
}

/// The dotted key text of an `ENTRY` node, e.g. `"inputs"` or `"a.b"`.
///
/// Only `IDENT` tokens are read, so a quoted key yields an empty string.
fn entry_key_text(entry: &taplo::syntax::SyntaxNode) -> String {
    entry
        .children()
        .find(|n| n.kind() == SyntaxKind::KEY)
        .into_iter()
        .flat_map(|key| key.descendants_with_tokens())
        .filter_map(|t| t.into_token())
        .filter(|t| t.kind() == IDENT)
        .map(|t| t.text().to_string())
        .collect::<Vec<_>>()
        .join(".")
}

#[cfg(test)]
mod tests {
    use super::strip_concept_qualifiers;

    #[test]
    fn strip_bare_brackets() {
        assert_eq!(strip_concept_qualifiers("[]"), "");
    }

    #[test]
    fn strip_lone_dot() {
        assert_eq!(strip_concept_qualifiers("."), "");
    }

    #[test]
    fn strip_specific_count_only() {
        assert_eq!(strip_concept_qualifiers("[5]"), "");
    }

    #[test]
    fn strip_domain_and_brackets() {
        assert_eq!(strip_concept_qualifiers("domain.[]"), "");
    }

    #[test]
    fn strip_normal_concept_unchanged() {
        assert_eq!(strip_concept_qualifiers("Analysis"), "Analysis");
    }

    #[test]
    fn strip_indefinite_multiplicity() {
        assert_eq!(strip_concept_qualifiers("Slide[]"), "Slide");
    }

    #[test]
    fn strip_specific_multiplicity() {
        assert_eq!(strip_concept_qualifiers("Page[5]"), "Page");
    }

    #[test]
    fn strip_domain_prefix() {
        assert_eq!(strip_concept_qualifiers("images.Photo"), "Photo");
    }

    #[test]
    fn strip_domain_prefix_and_multiplicity() {
        assert_eq!(strip_concept_qualifiers("legal.Contract[]"), "Contract");
    }
}
