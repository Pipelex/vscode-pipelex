# MTHDS Syntax Coloring: Web Portability Analysis

This document analyzes how the current MTHDS syntax coloring implementation can be reused for web-based syntax highlighting (documentation sites, code playgrounds, rendered examples in web apps).

---

## 1. Current State: What's Portable and What's Not

### TextMate Grammar = Already Portable

The `mthds.tmLanguage.json` file uses the **TextMate grammar format**, which is the de facto standard for syntax highlighting across the ecosystem:

| Consumer | Uses TextMate Grammars | Notes |
|----------|----------------------|-------|
| VS Code | Yes | Native format |
| Shiki | Yes | Uses `vscode-textmate` + `vscode-oniguruma` under the hood |
| Monaco Editor | Yes | Via `monaco-textmate` adapter |
| GitHub | Yes | Linguist uses TextMate grammars |
| GitLab | Yes | Via Rouge + TextMate |
| Sublime Text | Yes | TextMate originated here |

The `mthds.tmLanguage.json` file can be used directly by any of these consumers **without modification**. It's a standalone JSON file with no VS Code-specific APIs.

The injection grammars (`mthds.frontmatter.tmLanguage.json`, `mthds.markdown.tmLanguage.json`) are also standard TextMate format and would work with any consumer that supports grammar injection.

### Semantic Tokens = NOT Portable

The `PipelexSemanticTokensProvider` (in `editors/vscode/src/pipelex/semanticTokenProvider.ts`) uses the **VS Code Semantic Tokens API**, which is:
- A VS Code-specific extension API (`vscode.DocumentSemanticTokensProvider`)
- Not part of any web standard or cross-editor protocol
- Requires a running VS Code extension host or LSP server

Semantic tokens cannot be used in static site generators, Shiki, or browser-based editors without a running language server.

### Color Configuration = Partially Portable

The color definitions in `package.json` `configurationDefaults.textMateRules` are VS Code-specific (they use VS Code's settings format). However, the **data** (scope-to-color mappings) can be extracted and converted to:
- CSS custom properties for web use
- Shiki theme objects
- Monaco theme rules

---

## 2. Recommended Web Strategy: Shiki

[Shiki](https://shiki.style/) is the recommended approach for web-based MTHDS syntax highlighting. It's used by VitePress (which this project already uses for the docs site), Astro, Nuxt Content, and many other documentation tools.

### Why Shiki

- Uses the exact same `vscode-textmate` engine that VS Code uses internally
- Accepts `.tmLanguage.json` files directly as custom languages
- Produces static HTML with inline styles — no JavaScript runtime needed
- Ships with 200+ themes, or accepts custom VS Code themes
- Already integrated into VitePress (this project's docs framework)

### Integration Steps

**Step 1: Register the MTHDS grammar with Shiki**

```typescript
import { createHighlighter } from 'shiki';
import mthdsGrammar from './mthds.tmLanguage.json';

const highlighter = await createHighlighter({
  langs: [
    {
      id: 'mthds',
      scopeName: 'source.mthds',
      // Shiki accepts the tmLanguage JSON directly
      ...mthdsGrammar,
      aliases: ['mthds', 'plx', 'pipelex'],
    }
  ],
  themes: ['dracula'] // Or a custom Pipelex theme
});

const html = highlighter.codeToHtml(code, { lang: 'mthds', theme: 'dracula' });
```

**Step 2: VitePress integration (for the docs site)**

In `site/.vitepress/config.ts`:
```typescript
import mthdsGrammar from '../../editors/vscode/mthds.tmLanguage.json';

export default defineConfig({
  markdown: {
    languages: [
      {
        id: 'mthds',
        scopeName: 'source.mthds',
        ...mthdsGrammar,
        aliases: ['mthds', 'plx'],
      }
    ]
  }
});
```

**Step 3: Create a custom Pipelex theme for Shiki**

Convert the color palette to a Shiki/VS Code theme format:
```typescript
const pipelexTheme = {
  name: 'pipelex-dark',
  type: 'dark',
  colors: {
    'editor.background': '#282A36',
    'editor.foreground': '#F8F8F2',
  },
  tokenColors: [
    {
      scope: 'support.type.property-name.pipe.mthds',
      settings: { foreground: '#FF6B6B', fontStyle: 'bold' }
    },
    {
      scope: 'support.type.concept.mthds',
      settings: { foreground: '#4ECDC4', fontStyle: 'bold' }
    },
    {
      scope: 'variable.name.data.mthds',
      settings: { foreground: '#98FB98', fontStyle: 'bold' }
    },
    {
      scope: 'punctuation.definition.jinja.mthds',
      settings: { foreground: '#FF79C6', fontStyle: 'bold' }
    },
    {
      scope: 'keyword.control.jinja.mthds',
      settings: { foreground: '#8BE9FD' }
    },
    {
      scope: 'variable.other.jinja.mthds',
      settings: { foreground: '#50FA7B' }
    },
    {
      scope: 'entity.name.tag.html.mthds',
      settings: { foreground: '#FFB86C' }
    },
    // ... remaining scopes from package.json textMateRules
  ]
};
```

---

## 3. What Would Need to Change

### 3.1 Move Semantic-Level Coloring Into TextMate Grammar

The semantic token provider adds coloring for constructs that the TextMate grammar could handle (and in most cases already does):

| Semantic Token | Can Be Done in TextMate? | How |
|----------------|-------------------------|-----|
| `mthdsConcept` in output/refines | **Already done** — `entryBegin` rules for output/refines assign `support.type.concept.mthds` |
| `mthdsPipeType` (`type = "PipeLLM"`) | **Partially done** — could add a specific `entryBegin` rule matching `type = "Pipe..."` |
| `mthdsDataVariable` in inputs | **Partially done** — needs a specific `entryBegin` pattern for `inputs = { ... }` |
| `mthdsPipeName` (`pipe = "name"`) | **Could be added** — specific `entryBegin` rule for `pipe = "..."` |
| `mthdsPipeSection` / `mthdsConceptSection` | **Already done** — table rules assign `support.type.property-name.pipe.mthds` and `.concept.mthds` |
| `mthdsModelRef` (`model = "$ref"`) | **Already done** — `entryBegin` model rule handles sigils |

The main gap is that TextMate cannot differentiate between a concept type **declaration** vs **reference** (e.g., `[concept.Name]` vs `output = "Name"`), but since the current semantic provider doesn't do this either (no modifiers), nothing is lost.

**Recommendation:** Ensure the TextMate grammar covers all the patterns the semantic provider handles. Then the semantic provider becomes optional — nice to have in VS Code for potential future declaration/reference distinction, but not needed for basic coloring.

### 3.2 Fix Grammar Issues First

Before publishing the grammar for web use, fix the issues from the [code review](./syntax-coloring-review.md):
- Remove the overly broad `jinjaVariable` pattern from `value` (it would color all identifiers on web too)
- Remove top-level Jinja/HTML patterns (they'd cause false positives in static rendering)
- Deduplicate patterns (not a correctness issue for web, but reduces grammar size)

### 3.3 Create a Standalone npm Package (Optional)

For easy consumption by web projects:

```
packages/mthds-grammar/
  package.json        # @pipelex/mthds-grammar
  mthds.tmLanguage.json
  mthds.frontmatter.tmLanguage.json
  mthds.markdown.tmLanguage.json
  theme-dark.json     # Pipelex dark theme
  theme-light.json    # Pipelex light theme (to be created)
  index.ts            # Exports grammar + theme objects
```

This package would:
- Be published to npm as `@pipelex/mthds-grammar`
- Be consumed by the VS Code extension (instead of the raw JSON file)
- Be consumed by the docs site for Shiki integration
- Be consumable by any third-party tool that wants MTHDS syntax highlighting

---

## 4. Alternative Approaches Comparison

| Approach | TextMate Grammar Reuse | Accuracy | Bundle Size | Runtime Cost | Maintenance |
|----------|----------------------|----------|-------------|-------------|-------------|
| **Shiki** (recommended) | Direct — same engine as VS Code | Identical to VS Code | ~2MB (oniguruma WASM) | Zero (static HTML output) | Low — grammar shared |
| **Prism.js** | None — requires rewrite as Prism plugin | Approximate — simpler regex engine | ~20KB (language only) | Low (runtime regex) | High — separate grammar |
| **highlight.js** | None — requires rewrite | Approximate | ~30KB (language only) | Low (runtime regex) | High — separate grammar |
| **CodeMirror 6** | Partial — via `@pcdotfan/codemirror-textmate` | Good — uses vscode-textmate | ~2MB (oniguruma WASM) | Medium (runtime tokenization) | Low — grammar shared |
| **Monaco Editor** | Full — via `monaco-textmate` | Identical to VS Code | ~2MB (oniguruma WASM) | Medium (runtime tokenization) | Low — grammar shared |

### Recommendation

- **For static sites (docs, blogs, README rendering):** Use **Shiki**. Zero runtime cost, identical accuracy, direct grammar reuse.
- **For interactive editors (code playgrounds, web IDE):** Use **Monaco** with `monaco-textmate`. Full VS Code compatibility including the grammar.
- **Avoid Prism/highlight.js** for MTHDS — the language is too complex (embedded Jinja, HTML, multi-line strings) for their simpler tokenization models, and maintaining a separate grammar definition is not worth the smaller bundle size.

---

## 5. CSS Theme Generation

For cases where you want to style MTHDS code blocks with CSS rather than inline styles (e.g., in a CMS, custom renderer, or server-rendered pages), generate CSS from the color palette:

```css
/* Generated from docs/pipelex/syntax-color-palette.md */
/* Dark theme — use inside a .dark or prefers-color-scheme media query */

.mthds-highlight .pipe-section,
.mthds-highlight .pipe-type,
.mthds-highlight .pipe-name {
    color: #FF6B6B;
    font-weight: bold;
}

.mthds-highlight .concept,
.mthds-highlight .concept-section {
    color: #4ECDC4;
    font-weight: bold;
}

.mthds-highlight .data-variable {
    color: #98FB98;
    font-weight: bold;
}

.mthds-highlight .jinja-delimiter,
.mthds-highlight .sigil {
    color: #FF79C6;
    font-weight: bold;
}

.mthds-highlight .jinja-keyword {
    color: #8BE9FD;
}

.mthds-highlight .jinja-variable {
    color: #50FA7B;
}

.mthds-highlight .html-tag {
    color: #FFB86C;
}

.mthds-highlight .html-attribute {
    color: #F1FA8C;
}

.mthds-highlight .comment {
    color: #6272A4;
    font-style: italic;
}
```

Note: This CSS uses semantic class names. The actual class names depend on the rendering tool. Shiki outputs `<span style="color:...">` by default but supports CSS class output via `codeToHtml({ lang, theme, cssVariablePrefix })` or the `transformers` API.

---

## 6. Summary

| Aspect | Current State | Web-Ready? |
|--------|---------------|------------|
| TextMate grammar | 1066-line JSON, has bugs (see review) | Yes, after bug fixes |
| Semantic tokens | VS Code-only, 121 lines | No — VS Code-specific |
| Color palette | Dracula-inspired, dark only | Partially — needs light variant |
| Injection grammars | Frontmatter + markdown code blocks | Yes |
| npm package | Does not exist | Recommended to create |

**Bottom line:** The TextMate grammar is the portable asset. Fix the issues identified in the code review, verify it produces correct tokens in Shiki, and the web story is straightforward. The semantic token provider is VS Code-only and should be treated as a VS Code enhancement layer, not a dependency for coloring.
