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

impl ReferenceKind {
    pub(crate) fn root_key(&self) -> &'static str {
        match self {
            ReferenceKind::Pipe => "pipe",
            ReferenceKind::Concept => "concept",
        }
    }
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

/// Resolve a reference at the cursor position in the DOM.
///
/// Checks if the cursor is on a STRING token inside a reference field
/// (`pipe`, `main_pipe`, `default_pipe_code`, `output`, `refines`, or an
/// `inputs = { ... }` inline table value), extracts the reference name,
/// and looks up the corresponding `pipe.<name>` or `concept.<name>` in the DOM.
pub(crate) fn resolve_reference(dom: &Node, query: &Query) -> Option<ResolvedReference> {
    let position_info = find_string_position_info(query)?;

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

    let root_key = kind.root_key();

    let target_keys = Keys::new(
        [
            KeyOrIndex::Key(taplo::dom::node::Key::new(root_key)),
            KeyOrIndex::Key(taplo::dom::node::Key::new(&ref_name)),
        ]
        .into_iter(),
    );

    let target_node = dom.path(&target_keys)?;

    Some(ResolvedReference {
        kind,
        ref_name,
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
