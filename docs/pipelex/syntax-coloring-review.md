# MTHDS Syntax Coloring: Code & Architecture Review

This document provides a thorough review of the MTHDS syntax coloring implementation across TextMate grammars, semantic token providers, color configuration, and overall architecture.

## Files Reviewed

| File | Lines | Role |
|------|-------|------|
| `editors/vscode/mthds.tmLanguage.json` | 1066 | Main TextMate grammar |
| `editors/vscode/src/pipelex/semanticTokenProvider.ts` | 121 | Semantic token provider |
| `editors/vscode/src/pipelex/pipelexExtension.ts` | 22 | Feature registration |
| `editors/vscode/mthds.frontmatter.tmLanguage.json` | 22 | Frontmatter injection grammar |
| `editors/vscode/mthds.markdown.tmLanguage.json` | 44 | Markdown code block injection grammar |
| `editors/vscode/package.json` | 650 | Extension manifest (contributes section) |
| `docs/pipelex/syntax-color-palette.md` | 55 | Color palette documentation |

---

## 1. TextMate Grammar Issues

### 1.1 Massive Pattern Duplication (Critical)

Several patterns are defined **three times** with identical regexes and scope names:

**`dataInjection` / `dataInjectionInString`:**
- Top-level `value` rule, lines 466-474 (inline pattern in `value.patterns`)
- Repository rule `dataInjection`, lines 746-756
- Repository rule `dataInjectionInString`, lines 1043-1053

All three use the same regex `(@)([a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)` and produce the same scopes. The `dataInjection` and `dataInjectionInString` rules are byte-for-byte identical.

**`templateVariable` / `templateVariableInString`:**
- Top-level `value` rule, lines 477-485
- Repository rule `templateVariable`, lines 757-767
- Repository rule `templateVariableInString`, lines 1054-1064

Same situation: identical regex, identical scopes, triple definition.

**`jinjaDelimiters`, `jinjaKeywords`, `jinjaVariable`:**
- Top-level `value` rule, lines 488-498
- Repository rules `jinjaDelimiters`/`jinjaKeywords`/`jinjaVariable`, lines 768-779
- Refined versions inside `jinjaTemplateContent` > `jinjaStatements`/`jinjaExpressions`, lines 885-947

The top-level and repository rules are duplicates. The `jinjaTemplateContent` versions are more refined (they add `support.function.jinja.mthds` for built-in functions, `keyword.operator.jinja.mthds` for operators, etc.), making the simpler duplicates redundant.

**`htmlTag` / `htmlComment`:**
- Top-level `value` rule, lines 500-543 (inline patterns)
- Repository rules `htmlTag`/`htmlComment`, lines 780-825
- Repository rule `htmlContent`, lines 949-1007 (more structured begin/end version)

The inline `value` versions and the `htmlTag`/`htmlComment` repository rules are duplicates. The `htmlContent` repository rule is a better implementation (uses begin/end for tags, supports closing tags separately, includes `htmlAttributes`).

**Recommendation:** Remove all inline duplicates from the `value` rule. Use `#include` references to the repository rules. Consolidate `dataInjection`/`dataInjectionInString` into one rule (they are identical). Same for `templateVariable`/`templateVariableInString`.

### 1.2 Overly Broad Jinja Variable Pattern (High)

In the `value` rule, line 496:
```json
{
  "match": "\\b([a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)*)\\b",
  "name": "variable.other.jinja.mthds"
}
```

This matches **every identifier** in the document, including plain TOML string values, key names, boolean-adjacent text, etc. Since it's in the top-level `value` rule (not scoped to Jinja delimiters), it will color any bare word as a Jinja variable. For example, in:
```toml
description = "A simple text parser"
```
The words `A`, `simple`, `text`, and `parser` would all match as Jinja variables.

The same pattern also exists as the repository rule `jinjaVariable` (line 776-779) and is included at the document's top-level `patterns` (line 28).

**Recommendation:** Remove the broad `jinjaVariable` pattern from both the top-level `patterns` array and the `value` rule. Jinja variables should only be matched inside `jinjaTemplateContent` (inside `{{ }}` and `{% %}` delimiters), where the refined `jinjaExpressions`/`jinjaStatements` rules already handle them.

### 1.3 Top-Level Scope Leakage (High)

The top-level `patterns` array (lines 8-44) includes:
- `#dataInjection`
- `#templateVariable`
- `#jinjaDelimiters`
- `#jinjaKeywords`
- `#jinjaVariable`
- `#htmlTag`
- `#htmlComment`

These patterns should **only apply inside string values** (specifically inside `jinja2` and `prompt_template` fields), not at the document's top-level scope. At the top level, a MTHDS file contains TOML structure: tables, entries, comments. Jinja/HTML syntax appearing outside of string values is a syntax error, not something to colorize.

Including these at the top level means:
- A bare `@foo` on a line by itself gets colored as a data injection (should be a syntax error)
- A bare `{{ }}` outside a string gets colored as Jinja delimiters
- Any `<div>` text outside strings gets colored as HTML

**Recommendation:** Remove `#dataInjection`, `#templateVariable`, `#jinjaDelimiters`, `#jinjaKeywords`, `#jinjaVariable`, `#htmlTag`, `#htmlComment` from the top-level patterns. They are already correctly included inside the `jinja2`/`prompt_template` entry patterns and inside double-quoted strings in the `value` rule.

### 1.4 No Grammar Generator (Medium)

The TOML grammar has a TypeScript generator system in `editors/vscode/src/syntax/` that produces `toml.tmLanguage.json`. The build script `build:syntax` runs `ts-node src/syntax/index.ts` to regenerate it.

The MTHDS grammar (`mthds.tmLanguage.json`) is a hand-edited 1066-line JSON file with no generator. This:
- Makes the grammar fragile and hard to maintain
- Led to the duplication issues described above (copy-paste without abstraction)
- Violates the CLAUDE.md instruction: "Don't Edit `*.tmLanguage.json` - Generated TextMate grammars (edit source generators instead)"
- Makes it harder to share patterns between TOML and MTHDS grammars

**Recommendation:** Create a generator in `editors/vscode/src/syntax/mthds/` following the same pattern as the TOML generator. Extract shared rules (comments, strings, values, escapes) from the TOML generator and share them.

### 1.5 Concept Table Pattern Only Allows Single-Dot Paths (Low)

The concept table regex (line 75):
```regex
concept(?:\.(?:[A-Za-z][A-Za-z0-9]*|"[^"]+"|'[^']+'))?
```

The `?` quantifier makes the dot segment optional (matching `[concept]`) but non-repeating. It matches `[concept.Name]` but NOT `[concept.Namespace.Name]`.

**Recommendation:** If nested concept paths are needed, change `?` to `*` or `+` to allow multiple dot segments: `concept(?:\.(?:[A-Za-z][A-Za-z0-9]*|"[^"]+"|'[^']+'))+`.

### 1.6 Pipe Name Regex Allows Uppercase (Low)

The pipe entry regex (line 213):
```regex
pipe(?:\.(?:[A-Za-z0-9_+-]+|"[^"]+"|'[^']+'))?
```

This allows `[A-Za-z0-9_+-]+`, which includes uppercase letters. However, the semantic token provider's `pipeNameRegex` (semanticTokenProvider.ts:69) only matches `[a-z][a-z0-9_]*`, which is lowercase only. This inconsistency means the TextMate grammar will color uppercase pipe names, but the semantic provider won't recognize them.

Additionally, the semantic provider doesn't allow `-` or `+` in pipe names, while the TextMate grammar does.

**Recommendation:** Align the regexes. Decide on the canonical pipe name format and use it consistently.

### 1.7 Data Injection / Template Variables in Literal Strings (Low)

The `dataInjectionInString` and `templateVariableInString` rules are included in double-quoted strings via the `value` rule (lines 560-564, 580-586). However, in TOML, literal strings (single-quoted `'...'` and triple-single-quoted `'''...'''`) do not process any escape sequences or special characters. The `@` and `$` characters have no special meaning in literal strings.

Currently, literal strings (lines 590-598) have no child patterns, so this is not actively a bug. But the naming convention `InString` implies they were intended for use in all strings, which would be incorrect.

**Recommendation:** Add a clarifying comment or rename to `dataInjectionInBasicString` / `templateVariableInBasicString`.

---

## 2. Semantic Token Provider Issues

### 2.1 Fragile Position Calculation via `indexOf` (High)

Throughout `semanticTokenProvider.ts`, token positions are calculated using `match[0].indexOf(match[N])`:

```typescript
// Line 45
const conceptStart = match.index + match[0].indexOf(match[3]);
// Line 53
const varStart = match.index + match[0].indexOf(match[2]);
// Line 57
const conceptStart = match.index + match[0].indexOf(match[3]);
```

`String.indexOf()` returns the position of the **first occurrence** of the substring. If a capture group's text appears earlier in the match, this will return the wrong offset. For example:

```toml
inputs = { text = "Text" }
```

Here `match[2]` is `text` and `match[3]` is `Text`. But `indexOf("Text")` would work correctly because it's case-sensitive. However, consider:

```toml
inputs = { name = "Name" }
```

If the full match contains the word "name" in the key and "Name" as the concept, `indexOf("name")` would match the key portion first, giving incorrect character offset.

More problematic for the model sigil reference (line 78):
```typescript
const sigilStart = match.index + match[0].indexOf(match[1], match[0].indexOf('"') + 1);
```

This tries to skip past the opening quote to find the sigil, but it's brittle—if the line contains earlier quotes, the offset is wrong.

**Recommendation:** Calculate positions from the regex capture groups directly. Use the approach of summing lengths of known preceding segments, or use a regex library that provides capture group offsets (like `matchAll` with named groups and manual offset tracking).

### 2.2 Brittle `{ type = "text" }` Skip Heuristic (Medium)

Line 37:
```typescript
if (line.includes('{ type = "text"') || line.includes('{type="text"')) {
    return;
}
```

This content-sniffs the line to skip concept structure definitions, but:
- It skips the **entire line**, not just the concept match. Other tokens on the same line are also skipped.
- It's whitespace-sensitive: `{ type = "text" }` matches but `{ type  =  "text" }` doesn't.
- It matches anywhere in the line, including inside string values.
- It doesn't account for other type values that might also need skipping.

**Recommendation:** Instead of skipping entire lines based on content heuristics, make the regex patterns more precise so they don't match false positives in the first place.

### 2.3 Input Params Regex Only Matches Single-Line (Medium)

Line 50:
```typescript
const inputParamRegex = /^(\s*)inputs\s*=\s*\{[^}]*\b([a-z][a-z0-9_]*...)\s*=\s*"(...)"/g;
```

The `[^}]*` class and the overall single-line approach means this only matches when the entire `inputs = { key = "Value" }` is on one line. Multi-line input blocks like:
```toml
inputs = {
    name = "Text",
    count = "Integer"
}
```
are not matched at all.

**Recommendation:** Either parse multi-line blocks by tracking state across lines, or document this as a known limitation and rely on TextMate grammar for these cases.

### 2.4 Hardcoded Numeric Token Type Indices (Medium)

Token types are referenced by magic numbers:
```typescript
tokensBuilder.push(lineIndex, conceptStart, match[3].length, 0); // mthdsConcept
tokensBuilder.push(lineIndex, pipeTypeStart, match[2].length, 1); // mthdsPipeType
tokensBuilder.push(lineIndex, varStart, match[2].length, 2);      // mthdsDataVariable
tokensBuilder.push(lineIndex, pipeNameStart, match[1].length, 3); // mthdsPipeName
tokensBuilder.push(lineIndex, sectionStart + 1, 4, 4);            // mthdsPipeSection
tokensBuilder.push(lineIndex, sectionStart + 1, 7, 5);            // mthdsConceptSection
tokensBuilder.push(lineIndex, sigilStart, 1, 6);                  // mthdsModelRef
```

These indices must exactly correspond to the order of the legend array in the constructor (lines 8-16). If someone reorders the legend, all token pushes break silently with wrong colors.

**Recommendation:** Define named constants:
```typescript
const TOKEN_TYPES = {
    mthdsConcept: 0,
    mthdsPipeType: 1,
    mthdsDataVariable: 2,
    mthdsPipeName: 3,
    mthdsPipeSection: 4,
    mthdsConceptSection: 5,
    mthdsModelRef: 6,
} as const;
```

### 2.5 No Token Modifiers (Low)

The semantic token provider defines token **types** but no **modifiers** (e.g., `declaration`, `definition`, `reference`, `readonly`). Token modifiers provide additional semantic information that themes can use:

- A concept in `[concept.Name]` is a **declaration**
- A concept in `output = "Name"` is a **reference**
- A pipe in `[pipe.name]` is a **declaration**
- A pipe in `pipe = "name"` is a **reference**

**Recommendation:** Add modifiers to distinguish declarations from references. This helps themes and also enables future IDE features (go-to-definition, find-references).

### 2.6 Section Header `indexOf` Can Match Wrong Substring (Medium)

Lines 96-101:
```typescript
const sectionStart = line.indexOf('[pipe');
// ...
const nameStart = line.indexOf(pipeMatch[1]);
```

`line.indexOf(pipeMatch[1])` finds the first occurrence of the pipe name anywhere in the line, not necessarily inside the brackets. If the line has a comment containing the same name, or if the name appears in preceding whitespace artifacts, the offset is wrong.

**Recommendation:** Use the regex match's index and offsets instead of `indexOf`.

### 2.7 Pipe Name Regex Too Restrictive (Low)

Line 69:
```typescript
const pipeNameRegex = /\bpipe\s*=\s*"([a-z][a-z0-9_]*)"/g;
```

This only allows lowercase letters, digits, and underscores. But the TextMate grammar's pipe name pattern allows `[A-Za-z0-9_+-]+`, which includes uppercase letters, hyphens, and plus signs.

**Recommendation:** Align with the TextMate grammar or establish a canonical format and enforce it in both places.

### 2.8 Inconsistent Line Anchoring (Low)

Some regexes anchor to `^` (start of line):
- `outputRefinesRegex`: `^(\s*)(output|refines)...`
- `inputParamRegex`: `^(\s*)inputs...`
- `pipeTypeRegex`: `^(\s*)type...`
- `modelRefRegex`: `^\s*model...`

Others don't:
- `pipeNameRegex`: `\bpipe\s*=...`
- `resultVarRegex`: `\b(result|batch_as|batch_over)...`

This means `pipeNameRegex` would match `pipe = "name"` inside a string value or comment, not just at the key position.

**Recommendation:** Anchor all regexes to `^` or use a consistent approach for determining whether a line position is a key vs. value context.

---

## 3. Color Configuration Issues

### 3.1 Two Near-Identical Reds (Medium)

In `package.json` `configurationDefaults`:

| Scope | Color | Usage |
|-------|-------|-------|
| `support.type.property-name.pipe.mthds` | `#FF6666` | Pipe section property names |
| `support.type.pipe-type.mthds` | `#FF6B6B` | Pipe type identifiers |
| `support.function.pipe-name.mthds` | `#FF6B6B` | Pipe names |

`#FF6666` and `#FF6B6B` differ by only 5 units in the green channel — they are visually indistinguishable on most displays. This is likely unintentional, possibly a copy-paste with a minor edit.

**Recommendation:** Use a single red (`#FF6B6B` per the palette doc) for all pipe-related elements, or intentionally differentiate with a more distinct color if they should be distinguishable.

### 3.2 Hardcoded Dracula Colors Override User Themes (Medium)

The `configurationDefaults.editor.tokenColorCustomizations.textMateRules` section (package.json lines 257-372) sets 15 hardcoded color rules. These override the user's chosen color theme for all MTHDS files.

While this ensures MTHDS files look good out of the box, it's aggressive behavior for an extension:
- Users who prefer light themes get dark-theme-optimized colors
- Users who've carefully chosen a theme have it overridden
- The colors don't adapt to theme contrast requirements

**Recommendation:** Consider shipping a dedicated color theme (e.g., "Pipelex Dark") that users can optionally enable, rather than overriding via `configurationDefaults`. Alternatively, reduce the defaults to only the MTHDS-specific scopes that no existing theme would handle, and let standard scopes (like `keyword.control`, `variable.other`) inherit from the user's theme.

### 3.3 Phantom Scope: `support.type.concept.native.mthds` (Low)

Line 288-293 of `package.json`:
```json
{
  "scope": "support.type.concept.native.mthds",
  "settings": {
    "foreground": "#98FB98",
    "fontStyle": "bold"
  }
}
```

This scope is defined in the color configuration but is **never assigned** in the TextMate grammar. No rule in `mthds.tmLanguage.json` produces this scope. The semantic token provider also doesn't map to it.

**Recommendation:** Either add grammar rules that produce this scope (for native/built-in concept types like `Text`, `Integer`, etc.) or remove the dead color rule.

### 3.4 No Light Theme Support (Low)

All colors in the palette are high-saturation, high-lightness values designed for dark backgrounds:
- `#FF6B6B` (Coral Red) — hard to read on white
- `#98FB98` (Pale Green) — very low contrast on white
- `#50FA7B` (Bright Green) — nearly invisible on light backgrounds
- `#F1FA8C` (Pale Yellow) — illegible on white

**Recommendation:** Define a light-theme variant of the color palette, or use VS Code's theme-aware color contribution API where available.

### 3.5 Colors Defined in Three Places (Low)

Color information is scattered across:
1. `package.json` `configurationDefaults.textMateRules` — actual runtime colors
2. `package.json` `semanticTokenScopes` — semantic-to-TextMate scope mapping
3. `docs/pipelex/syntax-color-palette.md` — human documentation

These can diverge. For instance, the palette doc says pipe-related elements are `#FF6B6B`, but the `textMateRules` uses `#FF6666` for `support.type.property-name.pipe.mthds`.

**Recommendation:** Treat the palette doc as the single source of truth. Consider generating the `textMateRules` section from a shared color definition file, or at minimum add a comment in `package.json` referencing the palette doc.

---

## 4. Architecture Issues

### 4.1 No Clear Division Between TextMate and Semantic Tokens (Critical)

Both the TextMate grammar and semantic token provider try to colorize the same constructs, with no clear layering strategy:

| Element | TextMate Grammar | Semantic Provider |
|---------|------------------|-------------------|
| Concept names | `support.type.concept.mthds` via `entryBegin` output/refines rules | `mthdsConcept` (token type 0) |
| Pipe sections | `support.type.property-name.pipe.mthds` via `table` rules | `mthdsPipeSection` (token type 4) |
| Pipe names | `support.type.property-name.pipe.mthds` via `entryBegin` | `mthdsPipeName` (token type 3) |
| Data variables | `variable.name.data.mthds` via `dataInjection` rules | `mthdsDataVariable` (token type 2) |
| Concept sections | `support.type.property-name.concept.mthds` via `table` rules | `mthdsConceptSection` (token type 5) |
| Model refs | `entity.name.model-ref.mthds` via `entryBegin` model rule | `mthdsModelRef` (token type 6) |

When semantic highlighting is enabled (which is the default, per line 256 of package.json), VS Code uses semantic tokens to **override** TextMate tokens. The semantic token scopes (package.json lines 222-253) map each semantic token type to a TextMate scope, which then picks up the hardcoded colors.

This means:
- The TextMate grammar does the work of colorizing these elements
- The semantic provider then redoes the same work, producing tokens that map back to the same (or similar) scopes
- If the semantic provider is less accurate (e.g., missing multi-line inputs), it actually makes coloring **worse** by overriding correct TextMate results with gaps

**Recommendation:** Define a clear separation:
- **TextMate grammar:** Handles all lexical/syntactic coloring — strings, keywords, punctuation, delimiters, Jinja syntax, HTML syntax. These don't require cross-line or semantic understanding.
- **Semantic provider:** Handles only truly semantic coloring that TextMate can't do — distinguishing concept *declarations* from *references*, validating pipe names against known definitions, resolving type references. Apply token modifiers rather than re-tokenizing the same elements.

### 4.2 No Tests (High)

Neither the TextMate grammar nor the semantic token provider has any tests:
- No vscode-tmgrammar-test snapshots for the grammar
- No unit tests for `PipelexSemanticTokensProvider`
- No integration tests verifying that specific MTHDS constructs produce expected tokens

The TOML grammar tests exist in `test-data/` but no corresponding MTHDS test fixtures are present.

**Recommendation:** Add:
1. TextMate grammar snapshot tests using a tool like `vscode-tmgrammar-test` or the Rust test infrastructure in `test-data/`
2. Unit tests for the semantic token provider (mock `vscode.TextDocument`, verify token positions and types)
3. Sample `.mthds` files in `test-data/` covering edge cases

### 4.3 Semantic Token Setting Mismatch (Low)

`package.json` defines `pipelex.syntax.semanticTokens` (line 485-490) with description "Whether to enable semantic tokens for tables and arrays" and default `true`. However, this setting controls **TOML** semantic tokens (for `tomlArrayKey`/`tomlTableKey`), not MTHDS semantic tokens.

The MTHDS semantic token provider in `pipelexExtension.ts` registers unconditionally — it doesn't check any setting. There is no way for users to disable MTHDS semantic highlighting independently.

**Recommendation:** Either:
- Add a separate `pipelex.mthds.semanticTokens` setting
- Or make the existing setting also control MTHDS semantic tokens
- Or document that MTHDS semantic tokens are always active

### 4.4 Injection Grammars Are Clean (Positive Note)

The `mthds.frontmatter.tmLanguage.json` and `mthds.markdown.tmLanguage.json` injection grammars are well-structured and follow the same pattern as the TOML counterparts. They correctly:
- Use `injectionSelector: "L:text.html.markdown"` for proper markdown integration
- Reference `source.mthds` via include for content delegation
- Register `embeddedLanguages` in package.json for bracket matching and other language features

No issues found with these files.

---

## 5. Summary of Recommendations

### Priority: Critical
1. **Remove pattern duplication** in the TextMate grammar — consolidate triple-defined rules
2. **Define clear TextMate vs. semantic token responsibilities** — eliminate overlapping colorization

### Priority: High
3. **Remove overly broad `jinjaVariable` pattern** from top-level scope and `value` rule
4. **Remove Jinja/HTML patterns from top-level `patterns`** array — scope them to string contexts only
5. **Fix `indexOf`-based position calculation** in semantic provider — use regex offsets
6. **Add tests** for both grammar and semantic tokens

### Priority: Medium
7. **Create a grammar generator** for MTHDS following the TOML pattern
8. **Fix multi-line input parsing** in semantic provider
9. **Replace magic number indices** with named constants
10. **Unify the two near-identical reds** (`#FF6666` / `#FF6B6B`)
11. **Reconsider hardcoded color overrides** — ship as optional theme instead
12. **Remove or implement `support.type.concept.native.mthds`**
13. **Fix brittle `{ type = "text" }` heuristic** in semantic provider
14. **Fix section header `indexOf`** to use regex offsets

### Priority: Low
15. **Support nested concept paths** in table regex
16. **Align pipe name format** between TextMate and semantic provider
17. **Add token modifiers** (declaration/reference) to semantic provider
18. **Add light theme support**
19. **Unify color definition sources** (palette doc, package.json, semantic scopes)
20. **Add `pipelex.mthds.semanticTokens` setting**
21. **Anchor all semantic provider regexes consistently**
