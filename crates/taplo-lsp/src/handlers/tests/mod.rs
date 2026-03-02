use crate::query::Query;
use taplo::{dom::Node, parser::parse, rowan::TextSize};

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

mod goto_definition;
mod hover;
