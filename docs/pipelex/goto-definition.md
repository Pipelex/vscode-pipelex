# Go-to-Definition for Pipe References

Go-to-definition (`textDocument/definition`) lets users Ctrl+Click (Cmd+Click on macOS) a pipe name string inside a step to jump to that pipe's `[pipe.<name>]` table header. Implemented entirely in the Rust LSP; no TypeScript or VS Code extension changes required.

## Scope

- **MTHDS files only** — the handler returns `None` for `.toml` files (zero impact on upstream taplo behavior).
- **Same-file pipe references only** — cross-file resolution is not supported.
- **Pipe refs only** — concept references are not handled.

## Supported Keys

The handler activates when the cursor is on a string value whose entry key is one of:

| Key | Context |
|-----|---------|
| `pipe` | Step reference inside a `PipeSequence` steps array |
| `main_pipe` | Top-level main pipe reference |
| `default_pipe_code` | Default pipe code reference |

## How It Works

1. **MTHDS guard** — `document_uri` must end with `.mthds`; otherwise bail early.
2. **Token check** — cursor must be on a `STRING` or `STRING_LITERAL` syntax token.
3. **Entry key check** — walk up from cursor to the enclosing `ENTRY`, extract its `KEY` ident(s), match against the supported key names.
4. **Extract pipe name** — read the string value from the DOM node (`Str::value()`), with a fallback to stripping quotes from the raw syntax token text.
5. **Resolve target** — build `Keys` for path `pipe.<name>` and call `Node::path()` on the document DOM.
6. **Return location** — map the target node's `syntax().text_range()` to an LSP `Range` via the document `Mapper`, return as `GotoDefinitionResponse::Scalar`.

## Files

| File | Role |
|------|------|
| `crates/taplo-lsp/src/handlers/goto_definition.rs` | Handler implementation |
| `crates/taplo-lsp/src/handlers.rs` | Module registration (`mod goto_definition`) |
| `crates/taplo-lsp/src/lib.rs` | Request handler registration (`request::GotoDefinition`) |
| `crates/taplo-lsp/src/handlers/initialize.rs` | Server capability (`definition_provider`) |

## Example

Given this MTHDS file:

```toml
[pipe.summarize_by_steps]
type = "PipeSequence"
steps = [
    { pipe = "extract_topics", result = "topics" },
    { pipe = "summarize_topic", result = "summary" },
]

[pipe.extract_topics]
type = "PipeLLM"
# ...
```

Ctrl+Click on `"extract_topics"` in the steps array jumps to the `[pipe.extract_topics]` table header.

## Adding New Reference Keys

To support additional key names (e.g. a future `fallback_pipe`), add the key string to the match in `goto_definition.rs`:

```rust
if !matches!(key_text.as_str(), "pipe" | "main_pipe" | "default_pipe_code" | "fallback_pipe") {
    return Ok(None);
}
```

## Adding Cross-File Resolution

Cross-file resolution would require:

1. Iterating over all `.mthds` documents in the workspace (available via `workspaces.by_document()` and the workspace document store).
2. For each document, checking `dom.path(&target_keys)`.
3. Returning the first match with the correct `document_uri`.

The current single-file approach keeps the handler simple and fast.

## Verification

```bash
cargo check -p taplo-lsp          # compilation
cargo test -p taplo-lsp            # unit tests (no regressions)
make ext-install                   # end-to-end in IDE
```
