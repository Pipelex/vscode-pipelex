# Semantic tokens for MTHDS

The TextMate grammar (`editors/vscode/src/syntax/mthds/`) colours `.mthds` files from patterns alone. The semantic-token provider adds the colouring that needs a little context — which identifier is a concept name, which is a data variable, which table header declares a pipe — by walking the document line by line and pushing tokens VS Code layers over the grammar's.

The provider lives in `editors/vscode/src/pipelex/semanticTokenProvider.ts` and is registered for the `mthds` language in `pipelexExtension.ts`, gated on the `pipelex.mthds.semanticTokens` setting (default on). It is a **text scanner, not a parser**: it never consults the LSP or taplo. That is a deliberate trade — it colours a document that is mid-edit and not yet valid TOML, where a parse-based approach would have nothing to say.

## The token types

The legend is seven types and one modifier, `declaration`:

| Type | What it marks |
|---|---|
| `mthdsConceptSection` / `mthdsPipeSection` | the `concept` / `pipe` keyword in a `[concept.X]` / `[pipe.x]` header (with `declaration`) |
| `mthdsConcept` | a concept name — in a header (with `declaration`), or referenced from `output`, `refines`, or an input slot |
| `mthdsPipeName` | a pipe name in a `[pipe.x]` header (with `declaration`) |
| `mthdsDataVariable` | an input slot name, and the value of `result`, `batch_as`, `batch_over` |
| `mthdsPipeType`, `mthdsModelRef` | in the legend, currently unused by the provider |

A concept **value** is coloured on its bare name only: the domain prefix and the multiplicity suffix in `legal.Contract[]` are the grammar's job. The one place that grammar is written is the `CONCEPT_VALUE` regex, shared by every position that reads a concept value.

## The inputs block scanner

Everything but `inputs` is a single-line regex pass. `inputs` needs state, because a slot can be written in either of two forms and either can span lines:

```toml
inputs = { title = "BookTitle", notes = { concept = "Text", hints = { intent = "prose" } } }
```

`title` is the **string form**, whose value is the concept. `notes` is the **expanded form**, whose concept sits under the slot table's `concept` key beside presentation hints. In both, the thing to colour as a data variable is the *slot name* — `concept` is a schema keyword, which the grammar already paints as a property name.

`scanInputsBlock` walks a line character by character carrying a **brace depth**, and the depth is what tells the forms apart:

| Depth | Where | What is emitted |
|---|---|---|
| 1 | directly inside `inputs = { … }` | `slot = "Concept"` → the slot name and the concept; `slot = {` → the slot name, and descend |
| 2 | inside a slot table | `concept = "Concept"` → the concept only; every other key is ignored |
| 3+ | inside `hints` | nothing — presentation intent is not a reference |

The block opens on a line matching `INPUTS_BLOCK_START` (`^\s*inputs\s*=\s*\{`), scanning from just after the `{` at depth 1, and closes when the depth returns to 0 — on whatever line that happens. While a block is open it owns the whole line, and the other passes are skipped for it.

Two details keep the depth honest. Braces are counted **outside strings only**, so a `}` in a quoted value cannot close the block; and a `#` outside a string ends the line, so a `}` in a trailing comment cannot either. A key is recognised only as a whole identifier followed by `=`, so a bare word elsewhere is skipped entire rather than having its letters re-read as the start of another key.

The single-line block, the multi-line block, the empty `inputs = {}` and the block with a trailing comment are not special cases: they all fall out of that one rule.

### Why a scanner rather than another regex

The previous implementation was two regexes and an `insideMultiLineInputs` boolean, and the expanded form broke both at once. The entry regex matched `key = "Concept"` anywhere in the content, so inside a slot table it coloured the keyword `concept` as if it were the slot name and left the real slot name bare. And the block ended on the first `}` on a line — which in the expanded form is the hints table's — so every slot written after an expanded one went uncoloured. The two bugs interact across lines (a slot table spanning lines, a hints table on its own line), which is why a third regex would not have settled it.

## Relationship to the LSP

The semantic provider and the LSP's reference classifier (`crates/taplo-lsp/src/handlers/mthds_resolution.rs`, see [goto-definition.md](goto-definition.md)) answer the same question — *is this string a concept reference?* — for different purposes, and they reach it by different means: the classifier reads taplo's syntax tree, the provider reads the text. They agree on the two slot forms and on excluding hint values.

They diverge in one place, and knowingly: an `inputs` inline table **spread over several lines** is invalid TOML, so taplo's recovery flattens it and the classifier cannot resolve anything inside it, in either slot form. The scanner has no such limit and colours it correctly. Colour without navigation is the visible consequence; the parser-side repair is tracked as its own item.

Neither surface yet recognises inputs declared as a standard table (`[pipe.x.inputs]`) or with dotted keys — also its own item.

## Tests

`editors/vscode/src/pipelex/__tests__/semanticTokenProvider.test.ts` mocks `vscode`'s `SemanticTokensBuilder` and asserts the exact `(line, char, length, tokenType, tokenModifiers)` of every pushed token. Offsets are pinned, not approximated: a token that moves by a character is a regression, so the tests spell the positions out. Run them with `make test-ext`.
