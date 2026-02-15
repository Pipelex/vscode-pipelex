# Pipelex Syntax Color Palette

This document describes the semantic color palette used for syntax highlighting in `.mthds` files. Use this as a reference for creating visual representations (e.g., flow-charts) of Pipelex pipeline execution.

## Primary Element Colors

| Semantic Role | Color | Hex Code | Usage |
|--------------|-------|----------|-------|
| **Pipes / Execution Units** | Coral Red | `#FF6B6B` | Pipe sections, pipe types (PipeLLM, PipeSequence), pipe names |
| **Concepts / Data Types** | Teal/Cyan | `#4ECDC4` | Concept definitions, concept type references |
| **Data Variables** | Pale Green | `#98FB98` | Variables (@var), native concept types |
| **Template/Injection Markers** | Magenta/Pink | `#FF79C6` | Jinja delimiters `{{ }}`, data injection `@`, template vars `$` |

## Secondary/Supporting Colors

These elements inherit their colors from the user's VS Code theme, providing consistent integration with any color scheme:

| Semantic Role | Source | Usage |
|--------------|--------|-------|
| **Control Flow** | Theme keyword color | Jinja keywords (if, for, etc.) |
| **Dynamic Values** | Theme variable color | Jinja variables inside templates |
| **Structural Elements** | Theme HTML tag color | HTML tags, structural markers |
| **Metadata/Attributes** | Theme attribute color | HTML attributes, secondary properties |
| **Comments/Inactive** | Theme comment color | Comments, disabled content |

## Flow-Chart Mapping Recommendations

For representing pipeline execution visually:

| Flow-Chart Element | Recommended Color | Hex Code |
|--------------------|-------------------|----------|
| Pipe nodes (execution steps) | Coral Red | `#FF6B6B` |
| Concept nodes (data types/schemas) | Teal | `#4ECDC4` |
| Data flow / variables | Pale Green | `#98FB98` |
| Control flow (conditionals, loops) | Light Cyan | `#8BE9FD` |
| Input/Output injection points | Magenta | `#FF79C6` |

## Theme Character

The palette follows a **Dracula-inspired** vibrant dark theme aesthetic with high contrast:

- **Warm colors** (reds/oranges) denote structural and execution elements
- **Cool colors** (cyans/greens) denote data and semantic elements

## Color Swatches (Hardcoded MTHDS Colors)

```
Coral Red:    #FF6B6B  ████████
Teal/Cyan:    #4ECDC4  ████████
Pale Green:   #98FB98  ████████
Magenta:      #FF79C6  ████████
```
