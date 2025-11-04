# Pipelex Extension Configuration - 2025 Best Practice

This directory contains **pure JSON configuration files** that define everything about the Pipelex extension in a reusable format.

## 📁 Configuration Files

### `pipelex-color-palette.json`
**Complete color system definition:**
- ✅ **Dark & Light themes** with semantic color categories
- ✅ **Scope mappings** (which colors apply to which syntax elements)
- ✅ **Font styles** (bold, italic, etc.)
- ✅ **Descriptions** for each color category
- ✅ **JSON Schema** for validation

### `pipelex-extension-config.json`
**Extension metadata and contributions:**
- ✅ **Languages** (PLX, TOML)
- ✅ **Grammars** and syntax definitions
- ✅ **Semantic tokens** 
- ✅ **Commands** and menus
- ✅ **Extension metadata** (name, description, etc.)

## 🚀 Usage

### Generate Everything from Config:
```bash
# Generate themes from JSON config
yarn build:themes

# This reads the JSON files and generates:
# - themes/pipelex-dark-color-theme.json
# - themes/pipelex-light-color-theme.json
```

### Edit Colors:
1. **Edit `pipelex-color-palette.json`**
2. **Run `yarn build:themes`**
3. **Reload extension** (`Ctrl+Shift+F5`)

## ✅ **Why This is Best Practice 2025:**

### **1. Pure JSON = Maximum Reusability**
```json
// Any tool can read this - no TypeScript compilation needed
{
  "palettes": {
    "dark": {
      "pipe": { "primary": "#FF6666" }
    }
  }
}
```

### **2. Cross-Platform Compatible**
- ✅ **VS Code extensions**
- ✅ **Web applications** 
- ✅ **Other editors** (Vim, Emacs, etc.)
- ✅ **Documentation tools**
- ✅ **CI/CD pipelines**

### **3. Validation & Documentation**
- ✅ **JSON Schema** validation
- ✅ **Self-documenting** with descriptions
- ✅ **Version controlled** configuration
- ✅ **No compilation step** needed

### **4. Easy Maintenance**
- ✅ **Single source of truth**
- ✅ **Non-technical users** can edit colors
- ✅ **Automated generation** of all theme files
- ✅ **Consistent** across all outputs

## 🎨 **Color Categories**

| Category | Purpose | Example Colors |
|----------|---------|----------------|
| `pipe` | Language constructs | `#FF6666`, `#FF6B6B` |
| `concept` | Type definitions | `#4ECDC4`, `#98FB98` |
| `data` | Variables & injection | `#98FB98`, `#FF79C6` |
| `template` | Jinja/templating | `#FF79C6`, `#8BE9FD` |
| `html` | Embedded HTML | `#FFB86C`, `#F1FA8C` |
| `brand` | Pipelex branding | `#45bf9f` |

## 🔄 **Development Workflow**

1. **Edit JSON config files** (no compilation needed!)
2. **Run `yarn build:themes`** (generates theme files)
3. **Reload extension** (`Ctrl+Shift+F5`)
4. **Test changes** immediately

This system is **100% reusable** and follows **2025 best practices** for extension configuration!
