# MTHDS Syntax Coloring Refactoring: Execution Plan

This is a self-contained guide for refactoring the MTHDS syntax coloring to best-practice quality. It can be executed by someone (or Claude Code) with no prior context — all file paths, current code issues, and target architecture are documented here.

Read the companion files before starting:
- `refactoring/syntax-coloring-review.md` — full code review with 21 findings
- `refactoring/syntax-coloring-web-portability.md` — web portability analysis

---

## Current File Inventory

| File | Lines | Role | Action |
|------|-------|------|--------|
| `editors/vscode/mthds.tmLanguage.json` | 1066 | Hand-edited TextMate grammar (MTHDS) | **DELETE** — replace with generated output |
| `editors/vscode/src/pipelex/semanticTokenProvider.ts` | 121 | VS Code semantic token provider | **REWRITE** |
| `editors/vscode/src/pipelex/pipelexExtension.ts` | 22 | Feature registration entry point | **MODIFY** |
| `editors/vscode/mthds.frontmatter.tmLanguage.json` | 22 | Frontmatter injection grammar | No change |
| `editors/vscode/mthds.markdown.tmLanguage.json` | 44 | Markdown code block injection grammar | No change |
| `editors/vscode/package.json` | 650 | Extension manifest | **MODIFY** (contributes section) |
| `docs/pipelex/syntax-color-palette.md` | 55 | Color palette documentation | **UPDATE** |
| `editors/vscode/src/syntax/index.ts` | 43 | TOML grammar generator entry point | Reference only |
| `editors/vscode/src/syntax/comment.ts` | 26 | TOML comment rules (shared) | **MODIFY** to extract shared rules |
| `editors/vscode/src/syntax/literal/string.ts` | 45 | TOML string rules (shared) | **MODIFY** to extract shared rules |
| `editors/vscode/src/syntax/literal/*.ts` | ~100 | TOML literal rules (shared) | **MODIFY** to extract shared rules |
| `editors/vscode/src/syntax/composite/*.ts` | ~100 | TOML composite rules | Reference only |
| `test-data/example.mthds` | 82 | MTHDS test fixture | Reference for test writing |
| `test-data/discord_newsletter.mthds` | 129 | MTHDS test fixture (complex) | Reference for test writing |

### Files to Create

| File | Role |
|------|------|
| `editors/vscode/src/syntax/mthds/index.ts` | MTHDS grammar generator entry point |
| `editors/vscode/src/syntax/mthds/table.ts` | MTHDS table rules (concept, pipe, generic) |
| `editors/vscode/src/syntax/mthds/entry.ts` | MTHDS entry rules (pipe, output, refines, model, jinja2, prompt_template) |
| `editors/vscode/src/syntax/mthds/value.ts` | MTHDS value rule (assembles strings + MTHDS-specific patterns) |
| `editors/vscode/src/syntax/mthds/jinja.ts` | Jinja2 template content rules (delimiters, statements, expressions) |
| `editors/vscode/src/syntax/mthds/html.ts` | HTML-in-template rules (tags, attributes, comments) |
| `editors/vscode/src/syntax/mthds/injection.ts` | Data injection (@var) and template variable ($var) rules |
| `editors/vscode/src/syntax/shared/comment.ts` | Shared comment rules (extracted from current comment.ts) |
| `editors/vscode/src/syntax/shared/escape.ts` | Shared string escape rules |
| `editors/vscode/src/syntax/shared/literals.ts` | Shared literal rules (numbers, booleans, datetime) |
| `editors/vscode/src/syntax/shared/strings.ts` | Shared base string rules (basic + literal, single + block) |
| `test-data/mthds/` | Directory for MTHDS grammar test fixtures |

---

## Canonical MTHDS Language Rules

Establish these as the source of truth. Both TextMate and semantic provider must agree:

| Element | Format | Examples |
|---------|--------|----------|
| **Pipe name** | `[a-z][a-z0-9_]*` (lowercase, underscores only) | `analyze_features`, `write_newsletter` |
| **Concept name** | `[A-Z][A-Za-z0-9]*` (PascalCase) | `FeatureAnalysis`, `Text` |
| **Namespaced concept** | `namespace.ConceptName` where namespace is `[a-z][a-z0-9_]*` | `images.Photo`, `native.Image` |
| **Pipe type** | `Pipe[A-Z][A-Za-z0-9]*` (PascalCase, Pipe prefix) | `PipeLLM`, `PipeSequence`, `PipeImgGen` |
| **Data injection** | `@variable_name` (only in basic strings) | `@photo`, `@feature_analysis` |
| **Template variable** | `$variable_name` (only in basic strings) | `$weekly_summary` |
| **Model sigil** | `[$@~]identifier` (only in `model = "..."`) | `$gpt-4`, `@my-alias`, `~waterfall` |
| **Concept table** | `[concept.Name]` or `[concept]` (single level) | `[concept.FeatureAnalysis]` |
| **Pipe table** | `[pipe.name]` or `[pipe]` | `[pipe.analyze_features]` |

---

## Phase 0: Preparation

**Goal:** Set up the workspace and verify you can build.

### Steps

1. **Read the review documents** in `refactoring/` to understand all issues.

2. **Verify current build works:**
   ```bash
   cd editors/vscode && yarn install && yarn build:syntax
   ```
   This runs `ts-node src/syntax/index.ts` which generates `toml.tmLanguage.json`.

3. **Take a snapshot** of the current `mthds.tmLanguage.json` for diff comparison later:
   ```bash
   cp editors/vscode/mthds.tmLanguage.json refactoring/mthds.tmLanguage.BEFORE.json
   ```

4. **Create the directory structure:**
   ```bash
   mkdir -p editors/vscode/src/syntax/mthds
   mkdir -p editors/vscode/src/syntax/shared
   mkdir -p test-data/mthds
   ```

### Verification
- `yarn build:syntax` succeeds
- Directory structure is in place

---

## Phase 1: Extract Shared Rules

**Goal:** Factor out rules that are identical between TOML and MTHDS grammars so both generators can reuse them.

### What to Extract

The TOML generator in `editors/vscode/src/syntax/` currently defines these rules inline. They need to become parameterized (taking a scope suffix like `"toml"` or `"mthds"`):

#### 1a. `editors/vscode/src/syntax/shared/comment.ts`

Extract from `editors/vscode/src/syntax/comment.ts`. The comment rules are identical between TOML and MTHDS — only the scope suffix differs (`.toml` vs `.mthds`).

```typescript
// shared/comment.ts
export function makeComment(lang: string) {
  return {
    captures: {
      1: { name: `comment.line.number-sign.${lang}` },
      2: { name: `punctuation.definition.comment.${lang}` },
    },
    comment: "Comments",
    match: "\\s*((#).*)$",
  };
}

export function makeCommentDirective(lang: string) {
  return {
    captures: {
      1: { name: `meta.preprocessor.${lang}` },
      2: { name: `punctuation.definition.meta.preprocessor.${lang}` },
    },
    comment: "Comments",
    match: "\\s*((#):.*)$",
  };
}
```

#### 1b. `editors/vscode/src/syntax/shared/escape.ts`

Extract from `editors/vscode/src/syntax/literal/string.ts` lines 1-10:

```typescript
export function makeEscape(lang: string) {
  return [
    {
      match: '\\\\([btnfr"\\\\\\n/ ]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})',
      name: `constant.character.escape.${lang}`,
    },
    {
      match: '\\\\[^btnfr/"\\\\\\n]',
      name: `invalid.illegal.escape.${lang}`,
    },
  ];
}
```

#### 1c. `editors/vscode/src/syntax/shared/strings.ts`

Extract from `editors/vscode/src/syntax/literal/string.ts`. The base string patterns (without MTHDS-specific content) are:

```typescript
export function makeStrings(lang: string, basicStringPatterns?: any[]) {
  const escape = makeEscape(lang);
  const basicPatterns = basicStringPatterns
    ? [...escape, ...basicStringPatterns]
    : escape;

  return [
    { name: `string.quoted.triple.basic.block.${lang}`, begin: '"""', end: '"""', patterns: basicPatterns },
    { name: `string.quoted.single.basic.line.${lang}`, begin: '"', end: '"', patterns: basicPatterns },
    { name: `string.quoted.triple.literal.block.${lang}`, begin: "'''", end: "'''" },
    { name: `string.quoted.single.literal.line.${lang}`, begin: "'", end: "'" },
  ];
}
```

The MTHDS generator will pass additional patterns (`dataInjection`, `templateVariable`, `jinjaTemplateContent`, `htmlContent`) as `basicStringPatterns`.

#### 1d. `editors/vscode/src/syntax/shared/literals.ts`

Extract from `editors/vscode/src/syntax/literal/boolean.ts`, `number.ts`, `datetime.ts`. These are identical between TOML and MTHDS — only the scope suffix changes.

#### 1e. Update TOML generator to use shared rules

Modify `editors/vscode/src/syntax/comment.ts` and `literal/string.ts` etc. to import from `shared/` and call with `"toml"`. This must be a pure refactor — the generated `toml.tmLanguage.json` must be byte-identical before and after.

### Verification

```bash
# Save old output
cp editors/vscode/toml.tmLanguage.json /tmp/toml.BEFORE.json
# Rebuild
cd editors/vscode && yarn build:syntax
# Verify identical
diff /tmp/toml.BEFORE.json editors/vscode/toml.tmLanguage.json
```

Must show no differences.

---

## Phase 2: Build the MTHDS Grammar Generator

**Goal:** Create a TypeScript generator that produces a correct, deduplicated `mthds.tmLanguage.json`.

### Architecture

```
editors/vscode/src/syntax/mthds/
  index.ts          # Entry point: assembles and writes mthds.tmLanguage.json
  table.ts          # [concept.X], [pipe.X], generic tables, inline tables
  entry.ts          # MTHDS-specific entries (pipe, output, refines, model, jinja2, prompt_template, generic)
  value.ts          # Value rule: strings (with MTHDS patterns), numbers, booleans, etc.
  jinja.ts          # jinjaTemplateContent, jinjaStatements, jinjaExpressions
  html.ts           # htmlContent, htmlAttributes
  injection.ts      # dataInjection, templateVariable (single definition each)
```

### Key Design Decisions

#### Top-level patterns — ONLY structural TOML

```typescript
// mthds/index.ts
patterns: [
  { include: "#commentDirective" },
  { include: "#comment" },
  { include: "#table" },
  { include: "#entryBegin" },
  { include: "#value" },
]
```

**No** `#dataInjection`, `#templateVariable`, `#jinjaDelimiters`, `#jinjaKeywords`, `#jinjaVariable`, `#htmlTag`, `#htmlComment` at top level. This fixes review issues 1.2 and 1.3.

#### Single definition of each pattern — use `#include` references

Each pattern is defined once in the repository and referenced via `#include`:

```typescript
// injection.ts — ONE definition of dataInjection
export function makeDataInjection(lang: string) {
  return {
    match: "(@)([a-z][a-zA-Z0-9_]*(?:\\.[a-z][a-zA-Z0-9_]*)*)",
    captures: {
      1: { name: `punctuation.definition.data-injection.${lang}` },
      2: { name: `variable.name.data.${lang}` },
    },
  };
}
```

Both `jinja2`/`prompt_template` entry patterns and basic string patterns include `#dataInjection` — no duplication.

#### Jinja variables only inside delimiters

The `variable.other.jinja.mthds` scope is only produced inside `jinjaStatements` and `jinjaExpressions` (inside `{% %}` and `{{ }}`), never at top level or in the `value` rule. This fixes the overly broad identifier match (review issue 1.2).

#### Strings: MTHDS patterns only in basic (double-quoted) strings

Basic strings (`"..."` and `"""..."""`) include `#jinjaTemplateContent`, `#htmlContent`, `#stringEscapes`, `#dataInjection`, `#templateVariable`.

Literal strings (`'...'` and `'''...'''`) include nothing — they are raw text per TOML spec.

#### MTHDS-specific entry rules

The `entryBegin` module defines these patterns **in priority order**:

1. `pipe.name =` (pipe entry)
2. `output = "ConceptType"` (with concept coloring inside the string)
3. `refines = "ConceptType"` (same)
4. `type = "PipeType"` (with pipe type coloring)
5. `model = "$sigil-ref"` (with sigil + model ref coloring)
6. `jinja2 = """..."""` (begin/end, includes jinja/html/injection content)
7. `jinja2 = "..."` (single-line variant)
8. `prompt_template = """..."""` (begin/end, includes jinja/injection content, no html)
9. `prompt_template = "..."` (single-line variant)
10. `pipe = "pipe_name"` (pipe name inside step inline table — add coloring for the value)
11. Generic entry (fallback: `key = `)

For item 10, add a new pattern to colorize the pipe name value in step objects like `{ pipe = "analyze_features" }`. Currently the TextMate grammar doesn't distinguish this from any other string value — it relies on the semantic provider. The new grammar should add:

```typescript
{
  name: "meta.entry.pipe-ref.mthds",
  match: '\\s*(pipe)\\s*(=)\\s*(")((?:[a-z][a-z0-9_]*))(")' ,
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "support.function.pipe-name.mthds" },
    5: { name: "punctuation.definition.string.end.mthds" },
  }
}
```

Similarly, add a pattern for `type = "PipeType"`:

```typescript
{
  name: "meta.entry.pipe-type.mthds",
  match: '\\s*(type)\\s*(=)\\s*(")(Pipe[A-Z][A-Za-z0-9]*)(")\\s*$',
  captures: {
    1: { name: "support.type.property-name.mthds" },
    2: { name: "punctuation.eq.mthds" },
    3: { name: "punctuation.definition.string.begin.mthds" },
    4: { name: "support.type.pipe-type.mthds" },
    5: { name: "punctuation.definition.string.end.mthds" },
  }
}
```

#### Table rules: aligned regexes

Use the canonical format from the rules table above:

```typescript
// Concept table: [concept.PascalName]
match: '^\\s*(\\[)\\s*(concept(?:\\.[A-Z][A-Za-z0-9]*)?)\\s*(\\])'

// Pipe table: [pipe.snake_name]
match: '^\\s*(\\[)\\s*(pipe(?:\\.[a-z][a-z0-9_]*)?)\\s*(\\])'
```

### Generator Entry Point

```typescript
// editors/vscode/src/syntax/mthds/index.ts
import * as path from "path";
import { writeFileSync } from "fs";
import { makeComment, makeCommentDirective } from "../shared/comment";
import { table } from "./table";
import { entryBegin } from "./entry";
import { value } from "./value";
import { jinjaTemplateContent, jinjaStatements, jinjaExpressions } from "./jinja";
import { htmlContent, htmlAttributes } from "./html";
import { makeDataInjection, makeTemplateVariable } from "./injection";
import { makeEscape } from "../shared/escape";

const lang = "mthds";

const syntax = {
  version: "1.0.0",
  scopeName: "source.mthds",
  uuid: "8b4e5008-c50d-11ea-a91b-54ee75aeeb97",
  information_for_contributors: [
    "Generated file — do not edit directly.",
    "Source: editors/vscode/src/syntax/mthds/",
    "Build: yarn build:syntax",
  ],
  patterns: [
    { include: "#commentDirective" },
    { include: "#comment" },
    { include: "#table" },
    { include: "#entryBegin" },
    { include: "#value" },
  ],
  repository: {
    comment: makeComment(lang),
    commentDirective: makeCommentDirective(lang),
    table,
    entryBegin,
    value,
    jinjaTemplateContent,
    jinjaStatements,
    jinjaExpressions,
    htmlContent,
    htmlAttributes,
    dataInjection: makeDataInjection(lang),
    templateVariable: makeTemplateVariable(lang),
    stringEscapes: { patterns: makeEscape(lang) },
  },
};

writeFileSync(
  path.resolve(__dirname, path.join("..", "..", "..", "mthds.tmLanguage.json")),
  JSON.stringify(syntax, null, 2)
);
```

### Build Script Update

Modify `editors/vscode/package.json` `scripts.build:syntax`:

```json
"build:syntax": "ts-node --project node.tsconfig.json src/syntax/index.ts && ts-node --project node.tsconfig.json src/syntax/mthds/index.ts"
```

### Verification

1. Run `yarn build:syntax` — both `toml.tmLanguage.json` and `mthds.tmLanguage.json` are generated.
2. Diff the generated `mthds.tmLanguage.json` against `refactoring/mthds.tmLanguage.BEFORE.json`:
   - It should be **smaller** (no duplication).
   - The top-level `patterns` should only contain 5 entries (comment, commentDirective, table, entryBegin, value).
   - The repository should contain single definitions of `dataInjection`, `templateVariable` (not `dataInjectionInString`/`templateVariableInString` duplicates).
   - No `jinjaVariable` rule at the repository top level.
3. Open `test-data/example.mthds` and `test-data/discord_newsletter.mthds` in VS Code with the rebuilt extension. Verify:
   - `[concept.FeatureAnalysis]` — "concept" in teal, "FeatureAnalysis" in teal
   - `[pipe.analyze_features]` — "pipe" in red, "analyze_features" in red
   - `type = "PipeLLM"` — "PipeLLM" colored as pipe type
   - `output = "FeatureAnalysis"` — "FeatureAnalysis" colored as concept
   - `@photo` inside `prompt_template = """..."""` — sigil pink, variable green
   - `$weekly_summary` inside `jinja2 = """..."""` — sigil pink, variable green
   - `{{ channel }}` — delimiters pink, "channel" green
   - `{% for ... %}` — delimiters pink, "for" cyan keyword
   - `<h2>` — tag name orange
   - Plain string values like `definition = "..."` — NOT colored as Jinja variables
   - Bare identifiers outside strings — NOT colored

---

## Phase 3: Rewrite the Semantic Token Provider

**Goal:** Slim the provider down to only provide truly semantic information that TextMate cannot, fix all bugs.

### What the Semantic Provider Should Do (Post-Refactor)

After Phase 2, the TextMate grammar handles all lexical coloring. The semantic provider should ONLY add:

1. **Token modifiers** — distinguish declarations from references:
   - `[concept.Name]` → `mthdsConcept` with modifier `declaration`
   - `output = "Name"` → `mthdsConcept` with modifier `reference` (no modifier = default)
   - `[pipe.name]` → `mthdsPipeName` with modifier `declaration`
   - `pipe = "name"` → `mthdsPipeName` (reference)

2. **Multi-line input parameter coloring** — the TextMate grammar can only match single-line patterns for `inputs = { ... }`. The semantic provider can track state across lines for multi-line input blocks.

3. **Concept type validation in inputs** — colorize concept type names in input values like `inputs = { photo = "native.Image" }`.

### Implementation

Replace `editors/vscode/src/pipelex/semanticTokenProvider.ts` entirely:

**Key fixes:**
- Define `TOKEN_TYPES` and `TOKEN_MODIFIERS` as named constants
- Use `match.index` + cumulative capture group lengths for position calculation (never `indexOf`)
- Remove the `{ type = "text" }` heuristic — make regexes precise instead
- Anchor ALL regexes to `^` for line-start context
- Use `[a-z][a-z0-9_]*` for pipe names (canonical format)
- Track multi-line `inputs = { ... }` blocks with a simple state machine
- Register `declaration` and `reference` modifiers in the legend

```typescript
// Token type constants — indices match the legend array order
const TOKEN_TYPES = {
  mthdsConcept: 0,
  mthdsPipeType: 1,
  mthdsDataVariable: 2,
  mthdsPipeName: 3,
  mthdsPipeSection: 4,
  mthdsConceptSection: 5,
  mthdsModelRef: 6,
} as const;

const TOKEN_MODIFIERS = {
  declaration: 0,
  // reference is the default (no modifier)
} as const;
```

**Position calculation pattern:**
```typescript
// Instead of: match.index + match[0].indexOf(match[N])
// Use: match.index + match[0].indexOf('=') + 'the fixed prefix'.length
// Or better: accumulate known lengths

// For a regex like: /^(\s*)(output|refines)\s*=\s*"(ConceptType)"\s*$/
// match.index is always 0 (anchored to ^)
// match[1].length = leading whitespace
// match[2] starts at match[1].length
// The concept type starts after the `= "` portion
// Use a second regex on the same line for precise offset, or compute from group positions
```

### Registration Update

In `editors/vscode/src/pipelex/pipelexExtension.ts`, add a setting check:

```typescript
export function registerPipelexFeatures(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('pipelex');
    const semanticTokensEnabled = config.get<boolean>('mthds.semanticTokens', true);

    if (semanticTokensEnabled) {
        const provider = new PipelexSemanticTokensProvider();
        context.subscriptions.push(
            vscode.languages.registerDocumentSemanticTokensProvider(
                { language: 'mthds' },
                provider,
                provider.getSemanticTokensLegend()
            )
        );
    }
}
```

### Package.json Changes

Add the new setting:
```json
"pipelex.mthds.semanticTokens": {
    "description": "Enable semantic tokens for MTHDS files (adds declaration/reference distinction).",
    "type": "boolean",
    "scope": "resource",
    "default": true
}
```

Add modifier to semantic token types:
```json
"semanticTokenModifiers": [
    {
        "id": "mthdsDeclaration",
        "description": "A declaration of a concept or pipe"
    }
]
```

### Verification

1. Open `test-data/example.mthds` — all coloring should work identically to before.
2. Disable `pipelex.mthds.semanticTokens` — coloring should still work (TextMate handles it).
3. Verify multi-line `inputs = { ... }` blocks get concept type coloring.
4. Verify no `indexOf` calls remain in the provider.

---

## Phase 4: Fix Color Configuration

**Goal:** Unified, correct, non-aggressive color setup.

### 4a. Unify the Two Reds

In `package.json` `configurationDefaults.textMateRules`, change `#FF6666` to `#FF6B6B` for `support.type.property-name.pipe.mthds`. This makes all pipe-related colors consistent with the palette doc.

### 4b. Remove Phantom Scope

Remove the `support.type.concept.native.mthds` rule from `configurationDefaults.textMateRules` (lines 288-293 in current package.json). It has no corresponding grammar rule.

### 4c. Reduce Hardcoded Overrides

The current 15 textMateRules override user themes aggressively. Reduce to only MTHDS-custom scopes that no standard theme would color:

**Keep** (MTHDS-specific scopes):
- `support.type.property-name.pipe.mthds`
- `support.type.pipe-type.mthds`
- `support.type.property-name.concept.mthds`
- `support.type.concept.mthds`
- `support.function.pipe-name.mthds`
- `punctuation.definition.data-injection.mthds`
- `punctuation.definition.template-variable.mthds`
- `punctuation.definition.model-sigil.mthds`
- `entity.name.model-ref.mthds`

**Remove** (standard scopes that themes already handle):
- `punctuation.definition.jinja.mthds` → falls back to theme's punctuation color
- `keyword.control.jinja.mthds` → falls back to theme's keyword color
- `variable.other.jinja.mthds` → falls back to theme's variable color
- `entity.name.tag.html.mthds` → falls back to theme's HTML tag color
- `entity.other.attribute-name.html.mthds` → falls back to theme's attribute color
- `comment.block.html.mthds` → falls back to theme's comment color

### 4d. Update Palette Doc

Update `docs/pipelex/syntax-color-palette.md` to reflect the actual colors after unification. Remove the `#FF6666` reference. Note that Jinja/HTML colors now inherit from the user's theme.

### Verification

1. Install in VS Code with Dracula theme — MTHDS-specific elements have the palette colors, Jinja/HTML use Dracula's native colors.
2. Switch to a light theme — Jinja/HTML keywords are readable (they use the theme's colors), MTHDS-specific elements use the hardcoded dark-optimized colors (acceptable for now).
3. Verify no scope in `textMateRules` references a scope that doesn't exist in the grammar.

---

## Phase 5: Add Tests

**Goal:** Prevent regressions.

### 5a. TextMate Grammar Snapshot Tests

Create test fixtures in `test-data/mthds/` that cover edge cases. Use `vscode-tmgrammar-test` (or a similar tool) to generate scope snapshots.

**Test fixtures to create:**

`test-data/mthds/concept-tables.mthds`:
```toml
[concept]
Name = "Description"

[concept.FeatureAnalysis]
definition = "Analysis of features"

[concept.FeatureAnalysis.structure]
field = { type = "text", required = true }
```

`test-data/mthds/pipe-definitions.mthds`:
```toml
[pipe]

[pipe.analyze_features]
type = "PipeLLM"
definition = "Analyze features"
inputs = { photo = "native.Image" }
output = "FeatureAnalysis"
model = "$gpt-4o"
```

`test-data/mthds/jinja-templates.mthds`:
```toml
[pipe.format]
type = "PipeJinja2"
jinja2 = """
{% for item in items %}
  <h2>{{ item.title }}</h2>
  <p>{{ item.body | truncate(200) }}</p>
{% endfor %}
<!-- end -->
"""
```

`test-data/mthds/prompt-templates.mthds`:
```toml
[pipe.ask]
type = "PipeLLM"
prompt_template = """
Analyze this:
@input_data

Using template: $template_name

Be concise.
"""
```

`test-data/mthds/false-positives.mthds`:
```toml
# This file tests that plain strings are NOT colored as Jinja/HTML/injections
[concept.PlainText]
definition = "A simple text concept with words that could false-match"
description = "The variable foo should not be colored"
note = 'Literal string: @not_injection $not_template {{ not_jinja }}'
```

`test-data/mthds/steps.mthds`:
```toml
[pipe.sequence]
type = "PipeSequence"
steps = [
    { pipe = "step_one", result = "first_result" },
    { pipe = "step_two", batch_over = "items", batch_as = "item", result = "second_result" },
]
```

### 5b. Semantic Token Provider Unit Tests

Create `editors/vscode/src/pipelex/__tests__/semanticTokenProvider.test.ts`:

- Mock `vscode.TextDocument` with fixed line content
- Call `analyzeLine` on various inputs
- Assert token positions, lengths, types, and modifiers
- Test edge cases: multi-line inputs, lines with duplicate substrings, model sigils

### Verification

- All tests pass.
- Run the TextMate grammar tests against the generated grammar.
- Run the semantic provider tests.

---

## Phase 6: Final Cleanup

### 6a. Delete Dead Files

- Remove `refactoring/mthds.tmLanguage.BEFORE.json` (snapshot from Phase 0)

### 6b. Update CLAUDE.md

The CLAUDE.md `Don't Edit` section should now include:
```
- `mthds.tmLanguage.json` — Generated by `src/syntax/mthds/`; run `yarn build:syntax`
```

(This was already listed as `*.tmLanguage.json` in the existing CLAUDE.md, but now it's actually true for MTHDS too.)

### 6c. Verify Full Build

```bash
cd editors/vscode
yarn build
```

The full build runs `build:syntax` (both TOML and MTHDS generators), then bundles the extension.

### 6d. Manual Visual Verification

Open both test fixtures in VS Code:
1. `test-data/example.mthds` — photo opposite pipeline
2. `test-data/discord_newsletter.mthds` — newsletter with Jinja2, HTML, batch operations

Verify every element is colored correctly per the palette:
- Concept names: teal (`#4ECDC4`)
- Pipe names/types/sections: coral red (`#FF6B6B`)
- Data variables: pale green (`#98FB98`)
- Sigils (`@`, `$`): magenta (`#FF79C6`)
- Jinja keywords: inherit from theme
- HTML tags: inherit from theme
- Plain strings: default string color, no false-positive Jinja coloring
- Comments: inherit from theme

---

## Summary: Files Changed Per Phase

| Phase | Files Created | Files Modified | Files Deleted |
|-------|---------------|----------------|---------------|
| 0 | `refactoring/mthds.tmLanguage.BEFORE.json`, directories | — | — |
| 1 | `shared/comment.ts`, `shared/escape.ts`, `shared/strings.ts`, `shared/literals.ts` | `src/syntax/comment.ts`, `src/syntax/literal/string.ts`, `src/syntax/literal/number.ts`, `src/syntax/literal/boolean.ts`, `src/syntax/literal/datetime.ts`, `src/syntax/index.ts` | — |
| 2 | `mthds/index.ts`, `mthds/table.ts`, `mthds/entry.ts`, `mthds/value.ts`, `mthds/jinja.ts`, `mthds/html.ts`, `mthds/injection.ts` | `package.json` (build:syntax script) | `mthds.tmLanguage.json` (replaced by generated) |
| 3 | — | `semanticTokenProvider.ts` (rewrite), `pipelexExtension.ts`, `package.json` (new setting) | — |
| 4 | — | `package.json` (textMateRules), `docs/pipelex/syntax-color-palette.md` | — |
| 5 | `test-data/mthds/*.mthds` (6 fixtures), `semanticTokenProvider.test.ts` | — | — |
| 6 | — | `CLAUDE.md` (optional) | `refactoring/mthds.tmLanguage.BEFORE.json` |

## Dependencies Between Phases

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3
                                  ↘
                              Phase 4 ──→ Phase 5 ──→ Phase 6
```

- Phase 1 must complete before Phase 2 (shared rules needed)
- Phase 2 must complete before Phase 3 (semantic provider slimmed based on what TextMate covers)
- Phase 4 can start after Phase 2 (color changes are independent of semantic provider)
- Phase 5 after both Phase 3 and Phase 4 (tests verify the final state)
- Phase 6 after Phase 5 (cleanup)
