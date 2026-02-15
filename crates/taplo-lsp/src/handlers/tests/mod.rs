use crate::query::Query;
use taplo::{
    dom::Node,
    parser::parse,
    rowan::TextSize,
    syntax::SyntaxKind::{STRING, STRING_LITERAL},
};

/// Parse a TOML string and build a [`Query`] at the given byte offset.
///
/// This is the shared setup step that every handler test needs:
/// parse source → build DOM → create cursor query.
fn parse_and_query(toml: &str, offset: u32) -> (Node, Query) {
    let parse_result = parse(toml);
    let dom = parse_result.into_dom();
    let query = Query::at(&dom, TextSize::from(offset));
    (dom, query)
}

/// Extract the string value at the cursor position from a query.
///
/// Returns `None` if the cursor is not on a `STRING` or `STRING_LITERAL` token.
/// Prefers the DOM node's parsed value; falls back to stripping quotes from the
/// raw syntax token text.
#[allow(dead_code)]
fn find_string_token_text(query: &Query) -> Option<String> {
    let position_info = query
        .before
        .as_ref()
        .filter(|p| matches!(p.syntax.kind(), STRING | STRING_LITERAL))
        .or_else(|| {
            query
                .after
                .as_ref()
                .filter(|p| matches!(p.syntax.kind(), STRING | STRING_LITERAL))
        })?;

    Some(
        position_info
            .dom_node
            .as_ref()
            .and_then(|(_, node)| node.as_str().map(|s| s.value().to_string()))
            .unwrap_or_else(|| {
                let text = position_info.syntax.text().to_string();
                text.trim_matches('"').trim_matches('\'').to_string()
            }),
    )
}

mod goto_definition;
