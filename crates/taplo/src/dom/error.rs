use super::node::Key;
use crate::syntax::SyntaxElement;
use thiserror::Error;

#[derive(Debug, Clone, Error)]
pub enum Error {
    #[error("the syntax was not expected here: {syntax:#?}")]
    UnexpectedSyntax { syntax: SyntaxElement },
    #[error("the string contains invalid escape sequence(s): {string:?}")]
    InvalidEscapeSequence { string: SyntaxElement },
    #[error("conflicting keys: '{key}' and '{other}'")]
    ConflictingKeys { key: Key, other: Key },
    #[error("expected table for '{not_table}', required by '{required_by}'")]
    ExpectedTable { not_table: Key, required_by: Key },
    #[error("expected array of tables for '{not_array_of_tables}', required by '{required_by}'")]
    ExpectedArrayOfTables {
        not_array_of_tables: Key,
        required_by: Key,
    },
    #[error("{0}")]
    Query(#[from] QueryError),
}

#[derive(Debug, Clone, Error)]
pub enum QueryError {
    #[error("the key or index was not found")]
    NotFound,
    #[error("invalid glob pattern: {0}")]
    InvalidGlob(#[from] globset::Error),
    #[error("the given key is invalid: {0}")]
    InvalidKey(crate::parser::Error),
}
