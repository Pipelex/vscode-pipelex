# Pipelex Color Themes

This directory contains the official Pipelex color themes following VS Code 2025 best practices.

## Available Themes

- **Pipelex Dark** - Dark theme optimized for Pipelex syntax highlighting
- **Pipelex Light** - Light theme variant with adjusted contrast

## Color Palette

### Dark Theme Colors
- **Pipe Elements**: `#FF6666`, `#FF6B6B` (Red variants)
- **Concepts**: `#4ECDC4` (Teal), `#98FB98` (Light green for native)
- **Data Variables**: `#98FB98` (Light green)
- **Template/Jinja**: `#FF79C6` (Pink), `#8BE9FD` (Cyan), `#50FA7B` (Green)
- **HTML Elements**: `#FFB86C` (Orange), `#F1FA8C` (Yellow), `#6272A4` (Gray)

### Light Theme Colors
- Adjusted variants with better contrast for light backgrounds
- Maintains the same semantic color relationships

## Usage

These themes are automatically available when the Pipelex extension is installed. Users can:

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type "Preferences: Color Theme"
3. Select "Pipelex Dark" or "Pipelex Light"

## Customization

The color definitions are also available programmatically via:
```typescript
import { getPipelexColors, PIPELEX_COLORS_DARK } from '../src/colors/pipelex-colors';
```

## Benefits of This Approach

- ✅ **Separation of Concerns**: Themes separate from extension logic
- ✅ **User Choice**: Users can enable/disable themes independently
- ✅ **Reusability**: Color definitions can be imported by other extensions
- ✅ **Maintainability**: Centralized color management
- ✅ **Standards Compliance**: Follows VS Code extension guidelines
- ✅ **Future-Proof**: Easy to add new theme variants
