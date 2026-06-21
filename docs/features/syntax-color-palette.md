# Pipelex Syntax Color Palette

This document describes the semantic color palette used for syntax highlighting in `.mthds` files. Use this as a reference for creating visual representations (e.g., flow-charts) of Pipelex pipeline execution.

## Theme awareness

The palette is **theme-aware**, but the two halves are delivered differently because of a VS Code constraint.

- **Dark palette — shipped declaratively.** It is the unscoped `editor.tokenColorCustomizations.textMateRules` in `contributes.configurationDefaults` (`editors/vscode/package.json`). It applies to every theme, so all dark themes get it with zero user-settings footprint (including dark themes whose name lacks "Dark", e.g. Monokai, Abyss).
- **Light palette — applied at runtime, with consent.** VS Code does **not** honor theme-scoped keys (`[*Light*]`, `[ThemeName]`) when they come from an extension's `configurationDefaults` — only from real user/workspace settings. So the light palette cannot be shipped declaratively; on a light theme the unscoped dark rules would otherwise leak through and read as low-contrast. Instead, the extension detects a light theme (via `vscode.window.activeColorTheme.kind`) and, the first time a light theme is active with a `.mthds` file open, offers to write a managed `[*Light*]` block into the user's **own** global `editor.tokenColorCustomizations` (where theme-scoped keys *are* honored). See `editors/vscode/src/pipelex/syntax/lightColors.ts`.

This keeps dark-only users untouched and only writes settings for opted-in light-theme users.

**Consent + lifecycle**
- One-time non-modal prompt: **Apply** / **Not now** / **Don't ask again**. The choice is remembered in `context.globalState` (`pipelex.syntaxColors.lightConsent`).
- The write is **merge-safe**: it adds only the MTHDS-scoped rules under `[*Light*]`, preserving any `editor.tokenColorCustomizations` the user already has, and is idempotent (re-applying doesn't duplicate). Each rule the extension writes is stamped with a sentinel `name` (`pipelex.mthds.light`); apply, remove, and refresh identify "our" rules by that stamp alone, so they never overwrite or delete a user-authored rule even if it targets the exact same `.mthds` scope. A palette refresh is therefore non-destructive: it replaces only the extension's own sentinel-stamped rules and leaves every user-authored rule in place.
- Commands: **Pipelex: Apply Light Theme Colors for MTHDS** (opt in later) and **Pipelex: Remove Light Theme Colors for MTHDS** (clean removal — also the way to undo, since VS Code has no uninstall hook).
- A palette version (`pipelex.syntaxColors.appliedVersion`) lets a future hue change refresh an already-applied block on update.

The two palettes differ in coverage:

- The **dark palette** covers only the MTHDS *brand* scopes (concept/pipe/variable/model/template/comment). Secondary token types (strings, property names, booleans, numbers, punctuation, Jinja/HTML) are left to the user's dark theme — that side already reads well, so we don't disturb it.
- The **light palette** additionally pins those secondary scopes to the storybook colors, so MTHDS code matches the `pipelex-light` reference on **any** light theme — not just ones (like Light+) whose defaults already happen to match. Every pinned scope is fully `.mthds`-suffixed, because the `[*Light*]` block applies to all files in light themes and only fully-qualified scopes keep it from recoloring other languages.

The light hues mirror the `pipelex-light` shiki theme in `mthds-ui` (`src/shiki/pipelexLightTheme.ts`) but use the **vscode grammar's** actual scope names (a few differ from the shiki copy). Note that shiki is **not** used for editor highlighting — it only renders MTHDS code in web contexts (storybook, app, hub); the editor is colored entirely by these TextMate rules. Also note that `editor.tokenColorCustomizations` can only set token *foreground* colors — not the editor background (that comes from the theme, and VS Code has no per-language background), so the cream storybook background is not reproducible for a single file type.

## Primary Element Colors

| Semantic Role | Usage | Dark | Light |
|--------------|-------|------|-------|
| **Pipes / Execution Units** | Pipe sections, pipe types (PipeLLM, PipeSequence), pipe names | `#FF6B6B` (coral red) | `#D32F2F` |
| **Concepts / Data Types** | Concept definitions, concept type references | `#4ECDC4` (teal/cyan) | `#0F766E` |
| **Data Variables** | Variables (@var), native concept types | `#98FB98` (pale green) | `#15803D` |
| **Model References** | Model field references (`$preset`, `@alias`, `~waterfall`) | `#FFB86C` (orange) | `#C2410C` |
| **Template/Injection Markers** | Jinja delimiters `{{ }}`, data injection `@`, template vars `$`, escapes, arrows, HTML/Jinja tags | `#FF79C6` (magenta/pink) | `#C2255C` |
| **Namespace Separator** | Domain/package address separators | `#7C7C9C` (muted) | `#6A6158` |
| **Comments / Preprocessor** | Comments, preprocessor directives | `#6a9955` (green, italic) | `#008000` |
| **Invalid Escape** | Illegal escape sequences | `#FF5555` (red, underline) | `#C00000` |

## Secondary/Supporting Colors

In **dark** mode these inherit from the user's theme. In **light** mode they're pinned to the storybook colors (so the look is consistent across light themes):

| Semantic Role | Usage | Dark | Light |
|--------------|-------|------|-------|
| **Strings** | Quoted values, prompt blocks, Jinja string literals | theme | `#A31515` |
| **Property Names / Jinja Variables** | Keys (`type`, `description`, …), `{{ var }}` | theme | `#001080` (navy) |
| **Booleans** | `true` / `false` | theme | `#0000FF` |
| **Numbers / Date-Time** | numeric & date/time literals | theme | `#098658` |
| **Jinja Functions / HTML Attributes** | `{{ fn() }}`, tag attrs | theme | `#795E26` (brown) |
| **Punctuation** | brackets, separators, `=`, quotes | theme | `#1B1713` |

## Flow-Chart Mapping Recommendations

For representing pipeline execution visually, use the palette that matches the target background. Dark hues for dark canvases:

| Flow-Chart Element | Dark | Light |
|--------------------|------|-------|
| Pipe nodes (execution steps) | `#FF6B6B` | `#D32F2F` |
| Concept nodes (data types/schemas) | `#4ECDC4` | `#0F766E` |
| Data flow / variables | `#98FB98` | `#15803D` |
| Input/Output injection points | `#FF79C6` | `#C2255C` |

## Theme Character

The dark palette follows a **Dracula-inspired** vibrant aesthetic with high contrast; the light palette keeps the same brand hue assignments, darkened to read on a warm cream background:

- **Warm colors** (reds/oranges) denote structural and execution elements
- **Cool colors** (cyans/greens) denote data and semantic elements

## Color Swatches

```
                   Dark        Light
Coral Red:         #FF6B6B     #D32F2F
Teal/Cyan:         #4ECDC4     #0F766E
Pale Green:        #98FB98     #15803D
Orange:            #FFB86C     #C2410C
Magenta:           #FF79C6     #C2255C
```
