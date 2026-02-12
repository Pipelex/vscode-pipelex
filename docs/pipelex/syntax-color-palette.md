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

| Semantic Role | Color | Hex Code | Usage |
|--------------|-------|----------|-------|
| **Control Flow** | Light Cyan | `#8BE9FD` | Jinja keywords (if, for, etc.) |
| **Dynamic Values** | Bright Green | `#50FA7B` | Jinja variables inside templates |
| **Structural Elements** | Orange | `#FFB86C` | HTML tags, structural markers |
| **Metadata/Attributes** | Pale Yellow | `#F1FA8C` | Attributes, secondary properties |
| **Comments/Inactive** | Slate Blue/Gray | `#6272A4` | Comments, disabled content |

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

## Color Swatches

```
Coral Red:    #FF6B6B  ████████
Teal/Cyan:    #4ECDC4  ████████
Pale Green:   #98FB98  ████████
Magenta:      #FF79C6  ████████
Light Cyan:   #8BE9FD  ████████
Bright Green: #50FA7B  ████████
Orange:       #FFB86C  ████████
Pale Yellow:  #F1FA8C  ████████
Slate Blue:   #6272A4  ████████
```
