---
status: draft
item: L-260902-74677a
---

# Expanded input slots in the editor: goto-definition, hover, semantic tokens

The MTHDS standard gives a pipe's `inputs` value two equivalent forms (`mthds/docs/spec/mthds-format.md`, `{ #input-slot-declarations }`): the string form `notes = "Text"` and the expanded form `notes = { concept = "Text", hints = { intent = "prose" } }`. Since the schema sync on `chore/Sync-mthds-schema-and-corpus` (PR #83) the vendored `mthds_schema.json` accepts both, so `plxt lint` and the schema squiggles no longer reject the expanded form — but the editor's own features never learned it. Goto-definition and hover do not resolve the `concept` string, pipe hover renders the slot as `?`, and the semantic-token provider colours the keyword `concept` as if it were the input name and then closes the inputs block on the first `}` it meets. This plan fixes all three, with the corpus entry `test-data/mthds-corpus/entries/feature_intent_hints_reading_circle/bundle.mthds` as the canonical fixture.

The ledger item is L-260902-74677a. The work is on branch `fix/Expanded-input-slot`, cut from `chore/Sync-mthds-schema-and-corpus` so its PR stacks on #83 — the fixture only exists on that branch. Decisions are recorded in this document rather than in a separate `design.md`: the campaign is three small, independent fixes, and only the first needs real design.

## Scope

In scope, one site each:

1. `crates/taplo-lsp/src/handlers/mthds_resolution.rs` — the reference classifier: recognise the slot-table shape so the `concept` string in an expanded slot classifies as a concept reference and hint values do not.
2. `crates/taplo-lsp/src/handlers/hover.rs` — the pipe hover's inputs list: read the concept from a slot table instead of falling back to `?`.
3. `editors/vscode/src/pipelex/semanticTokenProvider.ts` — the inputs tokenizer: colour the slot name rather than the `concept` keyword, and track brace depth so a nested table does not end the block.

Out of scope, and deliberately so:

- **A multi-line `inputs` inline table.** Found while testing, not anticipated here: taplo's error recovery flattens it, so goto-definition and hover fail on it in *both* slot forms. It is the parser's limit, it predates the expanded form, and repairing it means changing `crates/taplo/`'s recovery for every TOML document. Filed as L-260902-73ef53; Phase 2's scanner is textual and handles the shape regardless.
- **The standard-table form `[pipe.x.inputs]` and dotted keys `inputs.x = …`.** Neither is recognised today for the string form either — `classify_reference` reaches `ReferenceKind::Concept` only through the `output`/`refines` keys or an inline-table ancestry, and the semantic provider only enters an inputs block on an `inputs = {` line (the TextMate grammar's catch-all rule does colour the value there). That is a pre-existing gap of its own, on both forms, and it is filed as L-260902-e9268f rather than widened into this one.
- **Presence markers (`Text?`, `Text!`).** The `concept` string carries the same grammar as the string form, markers included, and neither `strip_concept_qualifiers` nor the semantic provider's value regex knows them today — in either form. That is L-260826-aad93c. This plan keeps the value grammar in one place per site so that fix touches one spot, and its tests use unmarked references.
- **The TextMate grammar.** Rule 11 in `editors/vscode/src/syntax/mthds/entry.ts` (`conceptValueEntry`) already colours `concept = "Text"` as a concept-valued entry and leaves `intent = "prose"` alone, since the value is not PascalCase. Nothing to change.
- **The graph renderer.** Dropping the slot from the built `GraphSpec` is `@pipelex/mthds-ui`'s half of the same gap, L-260902-954fb6, on that repo's `feature/Expanded-input-slot`. This repo picks it up when it bumps the package.

## Design

### Site 1 — the slot-table shape, not a wider ancestor search

`is_inside_inputs_inline_table` (`mthds_resolution.rs`) documents and implements exactly one level of nesting: `STRING → VALUE → ENTRY (slot) → INLINE_TABLE → VALUE → ENTRY (inputs)`. In the expanded form there is one more `ENTRY → INLINE_TABLE` pair between the string and `inputs`, so it returns `false`, and both consumers bail: `is_model_field` and the concept arm of `classify_reference`.

The tempting repair — walk up through any number of inline tables looking for an `inputs` entry — is wrong. From `hints = { intent = "prose" }` that walk also reaches `inputs`, so the hint value `"prose"` would classify as a concept reference and be offered goto-definition, and a future per-slot field such as a slot `description` would be classified the same way the day the standard adds it. The rule the spec gives is narrower than "somewhere under `inputs`": a string is a concept reference when it is **the value of a slot** (string form) or **the value of the `concept` key of a slot table** (expanded form), and a slot table is a table that is a direct value of `inputs`. Depth decides, not the key name alone: `inputs = { concept = "Text" }` is the string form of a slot that happens to be named `concept`, and it must keep resolving.

The predicate is therefore replaced by one that reads the chain of inline entries strictly. Walking up from the string token, collect the `ENTRY` nodes reached through `VALUE → INLINE_TABLE → VALUE → ENTRY` steps only — an `ARRAY` on the way breaks the chain, because `x = ["Foo"]` is not a slot form — and stop at the first entry that is not itself inside an inline table. Then accept exactly two chains, innermost first:

| chain of entry keys | verdict |
|---|---|
| `[<slot>, inputs]` | string form — concept reference |
| `[concept, <slot>, inputs]` | expanded form — concept reference |
| anything else | not a reference |

`[intent, hints, <slot>, inputs]` is "anything else", so hint values stay unclassified; so is `[description, <slot>, inputs]` should the standard grow that key; so is `[concept, options]` under some unrelated key. The new function replaces `is_inside_inputs_inline_table` at both call sites, with the doc comment rewritten to state the two shapes and the false positive it refuses. `is_model_field` keeps its guard through the same predicate, so `inputs = { model = { concept = "X" } }` is a slot named `model`, not a model field.

### Site 2 — pipe hover reads the slot table's `concept`

`build_mthds_hover_content` (`hover.rs`, the `Inputs` block) reads each slot with `v.as_str()` and falls back to a literal `?`. The fix adds one fallback before the `?`: if the value is a table, take its `concept` entry as a string. A slot table without a `concept` key is schema-invalid, and `?` stays the honest rendering for it.

Decision: the hover shows the concept only, not the hints — `` `notes`: Text `` — so a hint-free expanded slot renders byte-identical to the string form, which mirrors the runtime's own rule that such a slot collapses to its string at parse time (`InputSlotBlueprint`'s description in the vendored schema). Hints are presentation intent for forms, and a pipe hover is about what the pipe takes. Hovering *on* the `concept` string itself needs no hover change: once site 1 classifies it, `resolve_reference` and the native-concept path (`find_native_concept`) already produce the concept card.

### Site 3 — a small stateful scanner for the inputs block

`provideDocumentSemanticTokens` handles `inputs` with two regexes and a boolean: a single-line regex, a multi-line-start regex, and `insideMultiLineInputs`, which `analyzeInputEntries` runs under until a line contains `}`. Two things break on the expanded form. `analyzeInputEntries` matches `key = "Concept"` anywhere in the content, so inside a slot table it matches `concept = "Text"` and colours the schema keyword `concept` as `mthdsDataVariable`, while the real slot name gets no token. And the block ends on the first `}` — the hints table's, or the slot table's — so every slot after an expanded one on later lines is uncoloured; the single-line case that includes a `}` in `rest` never even enters the multi-line state.

Patching the regexes would leave the two bugs' interaction unaddressed (a slot table spanning lines, a hints table on its own line). The fix replaces the boolean and the entry regex with a small scanner that persists across lines while the block is open and tracks brace depth, ignoring braces inside double-quoted strings and after a `#` comment marker outside a string:

- **depth 1** — directly inside `inputs = { … }`: `ident = "…Concept…"` emits the slot name as `mthdsDataVariable` and the concept name as `mthdsConcept`, exactly as today; `ident = {` emits the slot name as `mthdsDataVariable` and opens depth 2.
- **depth 2** — inside a slot table: `concept = "…Concept…"` emits the concept name only, no token on the `concept` keyword (the grammar already colours it as a property name); `hints = {` opens depth 3; any other key is ignored.
- **depth 3 and deeper** — inside hints: nothing is emitted.
- The block ends when depth returns to 0, on whatever line that happens, which subsumes the trailing-comment and `inputs = {}` special cases the current code handles by hand.

The value regex (domain prefix, PascalCase name, multiplicity) stays the single expression it is today, shared by both depths, so L-260826-aad93c's presence-marker change lands in one place. Token offsets are exact: the existing tests pin `char` positions and the new ones do too.

## Tests

Every site gets unit tests against hand-written fixtures and a test against the corpus entry, which is the fixture the standard's own suite authored — the corpus is read, never edited here. New `.mthds` fixtures under `test-data/mthds/` are swept by two other suites automatically: `crates/pipelex-cli/tests/parity.rs`, which stores no expectation, and `js/tools-wasm/tests/toolsWasm.test.ts`, which snapshot-pins lint and format output per fixture — so `make test-tools-wasm-js` must run locally after adding a fixture and the new snapshot entries committed with it, or CI's vitest refuses the unknown snapshot.

**Resolution** (`crates/taplo-lsp/src/handlers/tests/goto_definition.rs`, new fixture `test-data/mthds/goto-definition/concept_inputs_expanded.mthds`), driven through `simulate_handler` so the production `classify_reference` is what runs:

- the `concept` string of an expanded slot resolves to the DOM concept, single-line and multi-line;
- the hint value (`intent = "prose"`) yields `None`;
- a slot *named* `concept` in the string form still resolves (depth decides);
- a depth-2 key other than `concept` yields `None`;
- an inline table under a key other than `inputs` (`options = { concept = "Foo" }`) yields `None`;
- an array value inside `inputs` yields `None`.

**Hover** (`crates/taplo-lsp/src/handlers/tests/hover.rs`, new fixture `test-data/mthds/hover/pipe_hover_expanded.mthds`):

- the pipe hover lists the expanded slot as `` `notes`: Text `` beside a string-form slot;
- a slot table without `concept` still renders `?`;
- hovering on the `concept` string resolves to a DOM concept and, separately, to a native concept through `find_native_concept`;
- `is_model_field` is false for `inputs = { model = { concept = "X" } }`, beside the existing inline-table test.

**Corpus** (both Rust test modules, reading `test-data/mthds-corpus/entries/feature_intent_hints_reading_circle/bundle.mthds` by relative path): classify on `concept = "Text"` gives a concept reference named `Text`, classify on `intent = "prose"` gives `None`, and the hover for `main_pipe = "write_card"` lists `` `title`: BookTitle, `notes`: Text ``.

**Semantic tokens** (`editors/vscode/src/pipelex/__tests__/semanticTokenProvider.test.ts`, a new `describe` for expanded slots): the corpus `inputs` line with exact offsets for `title`, `BookTitle`, `notes`, `Text` and no token on `concept`, `hints`, `intent` or `prose`; the multi-line shape from the ledger item where `extra = "Other"` follows the expanded slot and must be coloured; a slot table spanning several lines; a hints table on its own line; a `}` inside a quoted string or a trailing comment that must not close the block. The existing single-line, multi-line, trailing-comment and empty-block tests must pass unchanged, offsets included.

**End to end**, by hand in the Extension Host after `make ext-install`, on the corpus bundle: Cmd+click and hover on `"Text"` inside the expanded slot, hover on `"write_card"` in `main_pipe`, and the colouring of the `inputs` line. There is no LSP end-to-end harness in CI here; this manual pass is the checkpoint gate before the PR opens.

## Phases

### Phase 1 — resolution and hover (Rust)

- [x] Replace `is_inside_inputs_inline_table` with the chain-reading predicate; update both call sites and the doc comments.
- [x] Add the `concept`-table fallback in `build_mthds_hover_content`.
- [x] Add the goto-definition and hover fixtures and tests, including the corpus-driven ones.
- [x] `make test-taplo-lsp`; `make test-pipelex-cli` for parity over the new fixtures; `make test-tools-wasm-js` and commit the new snapshot entries.

One commit per site, each carrying its own tests.

**Checkpoint 1 — done.** The Rust half landed in two commits, `081a6a2` (resolution) and `2374d88` (hover), each carrying its own tests and a regenerated `js/tools-wasm` snapshot so either stands alone. `make test-taplo-lsp`, `make test-pipelex-cli` and `make test-tools-wasm-js` are green; `cargo fmt --check` and `cargo clippy -p taplo-lsp --all-targets -- -D warnings` are clean.

*The node nesting was exactly as designed.* Dumping the tree for `inputs = { title = "BookTitle", notes = { concept = "Text", hints = { intent = "prose" } } }` gives `STRING → VALUE → ENTRY → INLINE_TABLE → VALUE → ENTRY → …`, repeating one pair per level, with the outermost `ENTRY`'s parent a `TABLE` rather than an `INLINE_TABLE` — so `inline_entry_chain` steps `VALUE → INLINE_TABLE → VALUE → ENTRY` strictly and stops on its own when the chain breaks. The array case falls out of the same strictness: in `xs = ["Foo"]` the string's `VALUE` has an `ARRAY` parent, not an `ENTRY`, so the chain is empty before the first step. The predicate is `is_input_slot_concept`, with `inline_entry_chain` and `entry_key_text` as private helpers beside it.

*One test had to change shape, and it found a real limit.* The plan asked goto-definition to resolve an expanded slot "single-line and multi-line". It cannot, and not because of the classifier: a newline inside an inline table is invalid TOML, and taplo's recovery abandons the nesting at the newline, emitting every following `key = value` as a sibling `ENTRY` of `ROOT`. There is no `inputs` ancestor left to walk to — in the **string form** just as much as in the expanded form, so this is a pre-existing parser limit rather than anything this change introduced. `test_slot_spread_over_lines_does_not_resolve_in_either_form` pins both forms to say so, and the gap is filed as L-260902-73ef53 (owner `vscode-pipelex`, discovered from this item), which proposes keeping an unterminated `INLINE_TABLE` open across newlines in `crates/taplo/`'s recovery — an upstream-crate change, deliberately not taken here. Phase 2 is unaffected: the semantic-token scanner is textual and never consults the parser, so it will colour a multi-line block correctly. That divergence — colouring works, navigation does not — is the reason the item is worth keeping open.

*The negative shapes live in the test module, not in the fixture.* `options = { concept = "Foo" }`, a `description` key inside a slot table, and an array inside `inputs` are all schema-invalid, and the `js/tools-wasm` suite snapshot-pins a lint result for every `.mthds` file under `test-data/mthds/`. Putting them in the committed fixture would have pinned a pile of schema diagnostics unrelated to what is being tested, so the fixtures hold only the canonical valid shapes and the negatives are inline sources, as several existing hover tests already are. Both new fixtures lint clean and format to themselves (`"changed": false`) — note that the wasm formatter's defaults align entries whereas `plxt fmt --no-auto-config` does not, so the fixture text must match the *wasm* output, not what a local `plxt fmt` produces.

### Phase 2 — semantic tokens (TypeScript)

- [x] Replace `insideMultiLineInputs` and `analyzeInputEntries` with the depth-tracking scanner.
- [x] Add the expanded-slot tests; keep every existing test green with its offsets.
- [x] `make test-ext`.

Two commits, not one: `96da712` is the scanner, and `1568778` adds the recovery the scanner turned out to need. Depth alone regressed the unclosed-block case — with one brace missing the depth never returns to 0, so every line below loses its colouring, where the code being replaced recovered at the next `}` anywhere. A line starting with `[` while a block is open now abandons the block, a table header being impossible inside an inline table.

### Phase 3 — docs, changelog, PR

- [x] `docs/features/goto-definition.md` is already stale — it says "pipe refs only, concept references are not handled" — so refresh it to describe concept references, both slot forms, the chain rule and the hint false positive it refuses, and hover's reuse of the same classifier.
- [x] Add a short `docs/features/semantic-tokens.md` describing the provider and the scanner's depth semantics; there is no document for the semantic-token provider today.
- [x] One line in this repo's `CLAUDE.md` under "LSP Handler Architecture" naming the two slot shapes.
- [x] `CHANGELOG.md` under `## [Unreleased]`, a `### Fixed` entry, next to #83's `### Changed` paragraph that this completes.
- [x] `make check` — green. **Manual Extension Host pass: outstanding, and it is a human's to run.** The extension is built and installed into Cursor (`editors/vscode/pipelex.vsix`, installed 2026-09-02). The packaging step had to be run as `npx --yes @vscode/vsce package`, because `make vsix` called the `vsce` binary directly and it was not a devDependency. That gap has since been closed on this branch: `@vscode/vsce` is a devDependency and the target runs `yarn vsce package`.
- [ ] Open the PR against `chore/Sync-mthds-schema-and-corpus` with `Closes L-260902-74677a` in the body; once #83 merges into `dev`, retarget it to `dev`. The PR description must name the upstream-crate edits — `taplo-lsp`'s `mthds_resolution.rs` and `hover.rs` are MTHDS additions living inside an upstream crate, and this repo's rule is to say so whenever an upstream crate changes.

**Checkpoint 2.** At PR open: record the PR number, what the review rounds changed, and any deferral with where it was recorded.

PR **Pipelex/vscode-pipelex#84**, opened against `dev` rather than the stacked base `chore/Sync-mthds-schema-and-corpus` (#83) — the founder's call at PR time; until #83 merges the diff also carries its schema sync, which GitHub recomputes on that merge. The PR body names the upstream `taplo-lsp` files edited, as the fork's rule requires.

It carries one commit outside the campaign, `chore(build): package the vsix with the repo's own vsce`. The gap was found while packaging for the manual pass: `make vsix` invoked the `vsce` binary directly and it was not a devDependency. Repairing it meant a second decision, since vsce pulls the native module `keytar` and both required gates run `yarn install --immutable` in `editors/vscode` — its build is disabled through `dependenciesMeta`, vsce reaching keytar only on the stored-credential path neither `vsce package` nor our token-based publish takes.

**The manual Extension Host pass is still a human's to run**, and the plan made it the gate before the PR; the PR was opened ahead of it on the founder's instruction. The extension is installed into Cursor. What to look at, on `test-data/mthds-corpus/entries/feature_intent_hints_reading_circle/bundle.mthds`: Cmd+click and hover on `"Text"` inside the expanded slot (should reach the native-concept card), hover on `"write_card"` in `main_pipe` (should list `` `title`: BookTitle, `notes`: Text `` with no hints), the colouring of the `inputs` line (`title`, `BookTitle`, `notes`, `Text` coloured; `concept`, `hints`, `intent`, `prose` not), and that hovering `"prose"` offers nothing.

Review rounds and any deferral: to be recorded here as they happen.

## Decisions

- **Recognise the slot shape; do not widen the ancestor search.** The false positive on hint values is the reason; see Design, site 1.
- **Depth decides, not the key name.** A slot named `concept` in the string form keeps resolving; a `concept` key at depth 3 never does.
- **Pipe hover shows the concept, not the hints.** A hint-free expanded slot renders identically to the string form, as the runtime collapses it.
- **A slot table without `concept` keeps rendering `?`.** It is schema-invalid, and `?` is the honest reading.
- **The inputs tokenizer becomes a scanner with brace depth, not a third regex.** The two bugs interact across lines, and a scanner handles the single-line, multi-line, comment and empty cases through one rule.
- **The standard-table form and presence markers stay out**, each tracked by its own item.

## Open questions

None that block the work. Two judgement calls are recorded above as decisions rather than left open — hover without hints, and `?` for a `concept`-less slot table — and either can be reversed cheaply if review prefers otherwise.
