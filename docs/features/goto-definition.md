# Go-to-Definition and Hover for MTHDS References

Go-to-definition (`textDocument/definition`) lets a user Ctrl+Click (Cmd+Click on macOS) a reference string and jump to what it names: a pipe's `[pipe.<name>]` table header or a concept's `[concept.<Name>]` header. Hover (`textDocument/hover`) reads the same reference and renders a card for it. Both are implemented entirely in the Rust LSP; no TypeScript or VS Code extension change is involved.

The two features share one classifier, `crates/taplo-lsp/src/handlers/mthds_resolution.rs`, so a reference either works in both or in neither — there is no second copy of the rules to drift.

## Scope

- **MTHDS files only** — both handlers return `None` for `.toml` files, so upstream taplo behaviour is untouched.
- **Pipe references resolve across the bundle**; concept references resolve within the current file only.

## What counts as a reference

The classifier (`classify_reference`) recognises a string value as a reference in these positions:

| Position | Kind |
|---|---|
| `pipe = "…"` — a step reference inside a `PipeSequence` steps array | pipe |
| `main_pipe = "…"` | pipe |
| `default_pipe_code = "…"` | pipe |
| `output = "…"` | concept |
| `refines = "…"` | concept |
| the concept of an input slot, in either slot form (below) | concept |

A concept reference may carry a domain prefix and a multiplicity suffix — `legal.Contract[]`, `Page[5]` — and `strip_concept_qualifiers` reduces it to the bare name before the lookup. A concept that resolves to no `[concept.<Name>]` in the file falls back to the native-concept registry in the same module, so `Text`, `Document`, `Page` and the rest still hover.

### The two input slot forms

MTHDS declares a pipe's input slot in either of two equivalent forms (`mthds/docs/spec/mthds-format.md`, "Input slot declarations"):

```toml
inputs = { title = "BookTitle", notes = { concept = "Text", hints = { intent = "prose" } } }
```

`title` is the **string form**: the slot's value *is* the concept. `notes` is the **expanded form**: the concept sits under the slot table's `concept` key, beside presentation hints. Both are references and both navigate.

`is_input_slot_concept` decides this by reading the **chain of inline-table entry keys** containing the token, innermost first — `inline_entry_chain` walks up through `VALUE → INLINE_TABLE → VALUE → ENTRY` steps and stops at the first entry that is not itself inside an inline table. Exactly two chains are accepted:

| chain | verdict |
|---|---|
| `[<slot>, inputs]` | string form — concept reference |
| `[concept, <slot>, inputs]` | expanded form — concept reference |
| anything else | not a reference |

**Reading the shape rather than searching for an `inputs` ancestor is the whole point.** A walk that simply looked upwards for an `inputs` entry would also reach it from `hints = { intent = "prose" }`, so `"prose"` would classify as a concept reference and be offered goto-definition; the same walk would misread whatever per-slot key the standard adds next. Under the chain rule `[intent, hints, <slot>, inputs]` is simply not one of the two shapes, so hints are left alone.

**Depth decides, not the key name.** `inputs = { concept = "Text" }` is the string form of a slot that happens to be called `concept`, and it resolves; a `concept` key one level deeper than a slot table never does. The walk is strict about node kinds too, so an array — `inputs = { many = ["BookTitle"] }` — breaks the chain, an array not being a slot declaration form.

`is_model_field` guards through the same predicate, so a slot named `model` is a concept reference rather than a model field, in both slot forms.

### What is not recognised

- **Inputs declared as a standard table** (`[pipe.x.inputs]`) or with dotted keys (`inputs.notes = "Text"`). Neither form is recognised, for either slot form; tracked as its own item.
- **An inputs inline table spread over several lines.** A newline inside an inline table is invalid TOML, and taplo's error recovery abandons the nesting — every following `key = value` becomes a sibling `ENTRY` of `ROOT`, leaving no `inputs` ancestor to walk to. This affects both slot forms equally and is pinned by `test_slot_spread_over_lines_does_not_resolve_in_either_form`. The semantic-token provider is unaffected, because its scanner is textual (see [semantic-tokens.md](semantic-tokens.md)).

## How goto-definition works

1. **MTHDS guard** — `document_uri` must end with `.mthds`; otherwise bail early.
2. **Classify** — `classify_reference` reads the cursor's `STRING`/`STRING_LITERAL` token and returns the kind plus the bare reference name, or `None`.
3. **Pipe references try the bundle first** — `resolve_pipe_definition_across_bundle` globs the sibling `*.mthds` files in the document's directory, preferring documents already open in the workspace and re-parsing the rest from disk. Among the candidates it prefers the current document, then a definition whose `domain` matches the current file's, then a **concrete** definition over a `PipeSignature` (a pipe with no `type` counts as a signature).
4. **Otherwise resolve in this document** — `resolve_reference` builds `Keys` for `pipe.<name>` or `concept.<Name>` and calls `Node::path()` on the document DOM.
5. **Return the location** — the target node's `syntax().text_range()` is mapped to an LSP `Range` through the document `Mapper`, returned as `GotoDefinitionResponse::Scalar`.

## How hover works

Hover runs the same classification, then branches on what it found:

- **A resolved reference** renders through `build_mthds_hover_content` — for a pipe, its name, type, description, inputs and output; for a concept, its name, description, `refines` and structure fields.
- **A concept that resolves to nothing in the file** falls back to `find_native_concept` and `build_native_concept_hover`.
- **A model field** (`model`, `model_to_structure`) renders through `build_model_hover`.
- **Anything else** falls through to taplo's ordinary schema-based hover.

A pipe hover lists each input slot as `` `name`: Concept ``, reading the concept out of a slot table when it meets the expanded form. It shows the concept only and never the hints — a hint-free expanded slot therefore renders byte-identical to the string form, mirroring the runtime, which collapses such a slot to its string at parse time. Hints are presentation intent for forms; a pipe hover is about what the pipe takes. A slot table with no `concept` is schema-invalid, and `?` stays the honest rendering for it.

## Files

| File | Role |
|------|------|
| `crates/taplo-lsp/src/handlers/mthds_resolution.rs` | The shared classifier: `classify_reference`, `resolve_reference`, `is_input_slot_concept`, `is_model_field`, the native-concept registry |
| `crates/taplo-lsp/src/handlers/goto_definition.rs` | Goto-definition handler, including cross-file pipe resolution |
| `crates/taplo-lsp/src/handlers/hover.rs` | Hover handler and the `build_*_hover*` renderers |
| `crates/taplo-lsp/src/handlers.rs` | Module registration |
| `crates/taplo-lsp/src/lib.rs` | Request handler registration |
| `crates/taplo-lsp/src/handlers/initialize.rs` | Server capabilities (`definition_provider`, `hover_provider`) |

## Adding a new reference key

To support an additional key name, add it to the match in `classify_reference` (`mthds_resolution.rs`) — not to the handlers, which read the classifier's verdict:

```rust
let kind = if matches!(
    key_text.as_str(),
    "pipe" | "main_pipe" | "default_pipe_code" | "fallback_pipe"
) {
    ReferenceKind::Pipe
```

Both goto-definition and hover pick the new key up at once.

## Tests

`crates/taplo-lsp/src/handlers/tests/` calls the resolution functions directly rather than round-tripping through the LSP. `goto_definition.rs` drives `classify_reference` through `simulate_handler` (which also performs the DOM lookup) and through `classify_at` (which does not — the precise assertion for a negative, where a `None` from `simulate_handler` could also mean "classified, but absent from the DOM"). Fixtures live in `test-data/mthds/<feature>/`, and both modules also read the MTHDS Test Corpus entry `test-data/mthds-corpus/entries/feature_intent_hints_reading_circle/bundle.mthds`, which is the standard's own example of the expanded form.

A fixture added under `test-data/mthds/` is swept automatically by two other suites: `crates/pipelex-cli/tests/parity.rs`, and `js/tools-wasm/tests/toolsWasm.test.ts`, which snapshot-pins lint and format output per fixture. Run `make test-tools-wasm-js` after adding one and commit the new snapshot entries, or CI's vitest refuses the unknown snapshot. Note that the wasm formatter's defaults align entries whereas `plxt fmt --no-auto-config` does not, so a fixture that should format to itself must match the wasm output.

## Verification

```bash
cargo check -p taplo-lsp          # compilation
make test-taplo-lsp               # unit tests
make test-tools-wasm-js           # fixture lint/format snapshots
make ext-install                  # end-to-end in the IDE
```
