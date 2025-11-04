#!/usr/bin/env node

/**
 * Generate VS Code Extension Files from JSON Configuration
 * 2025 Best Practice - Pure JSON Configuration System
 */

const fs = require('fs');
const path = require('path');

// Load configuration files
const colorPalette = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/pipelex-color-palette.json'), 'utf8'));
const extensionConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/pipelex-extension-config.json'), 'utf8'));

/**
 * Generate VS Code theme from color palette
 */
function generateTheme(themeType) {
  const palette = colorPalette.palettes[themeType];
  const scopeMappings = colorPalette.scopeMappings;
  const fontStyles = colorPalette.fontStyles;
  
  const tokenColors = [];
  
  // Generate token colors from scope mappings
  Object.entries(scopeMappings).forEach(([colorPath, scopes]) => {
    const [category, subcategory] = colorPath.split('.');
    const color = palette[category][subcategory];
    const fontStyle = fontStyles[colorPath];
    
    const scopeArray = Array.isArray(scopes) ? scopes : [scopes];
    
    scopeArray.forEach(scope => {
      tokenColors.push({
        name: getScopeName(scope),
        scope: scope,
        settings: {
          foreground: color,
          ...(fontStyle && { fontStyle })
        }
      });
    });
  });

  // Generate TOML token colors
  const tomlScopeMappings = colorPalette.tomlScopeMappings;
  Object.entries(tomlScopeMappings).forEach(([colorPath, scopes]) => {
    const [category, subcategory] = colorPath.split('.');
    const color = palette[category][subcategory];
    
    const scopeArray = Array.isArray(scopes) ? scopes : [scopes];
    
    scopeArray.forEach(scope => {
      tokenColors.push({
        name: getScopeName(scope),
        scope: scope,
        settings: {
          foreground: color
        }
      });
    });
  });

  return {
    name: `Pipelex ${themeType === 'dark' ? 'Dark' : 'Light'}`,
    type: themeType,
    semanticHighlighting: true,
    colors: generateWorkspaceColors(palette, themeType === 'dark'),
    tokenColors
  };
}

/**
 * Generate workspace colors
 */
function generateWorkspaceColors(palette, isDark) {
  return {
    "editor.background": isDark ? "#1e1e1e" : "#ffffff",
    "editor.foreground": isDark ? "#d4d4d4" : "#333333",
    "activityBar.background": isDark ? "#2d2d30" : "#f3f3f3",
    "sideBar.background": isDark ? "#252526" : "#f8f8f8",
    "statusBar.background": palette.brand.primary,
    "statusBar.foreground": "#ffffff"
  };
}

/**
 * Get human-readable scope name
 */
function getScopeName(scope) {
  const scopeNames = {
    "support.type.property-name.pipe.plx": "Pipelex Pipe Section Headers",
    "support.type.pipe-type.plx": "Pipelex Pipe Type Identifiers",
    "support.type.property-name.concept.plx": "Pipelex Concept Section Headers",
    "support.type.concept.plx": "Pipelex Concept Names",
    "support.type.concept.native.plx": "Pipelex Native Concepts",
    "variable.name.data.plx": "Pipelex Data Variables",
    "support.function.pipe-name.plx": "Pipelex Pipe Names",
    "punctuation.definition.data-injection.plx": "Pipelex Data Injection Punctuation",
    "punctuation.definition.template-variable.plx": "Pipelex Template Variable Punctuation",
    "punctuation.definition.jinja.plx": "Pipelex Jinja Punctuation",
    "keyword.control.jinja.plx": "Pipelex Jinja Control Keywords",
    "variable.other.jinja.plx": "Pipelex Jinja Variables",
    "entity.name.tag.html.plx": "Pipelex HTML Tags",
    "entity.other.attribute-name.html.plx": "Pipelex HTML Attributes",
    "comment.block.html.plx": "Pipelex HTML Comments",
    // TOML scopes
    "string.quoted.double.toml": "TOML Strings",
    "string.quoted.single.toml": "TOML Strings",
    "string.quoted.triple.toml": "TOML Multiline Strings",
    "entity.name.tag.toml": "TOML Keys",
    "support.type.property-name.toml": "TOML Property Names",
    "constant.numeric.toml": "TOML Numbers",
    "constant.language.boolean.toml": "TOML Booleans",
    "comment.line.number-sign.toml": "TOML Comments",
    "entity.name.section.group-title.toml": "TOML Section Headers",
    "punctuation.definition.section.toml": "TOML Section Brackets",
    "punctuation.definition.array.toml": "TOML Array Brackets",
    "meta.array.toml": "TOML Arrays"
  };
  
  return scopeNames[scope] || scope;
}

/**
 * Write theme file
 */
function writeThemeFile(theme, outputPath) {
  const themeJson = JSON.stringify(theme, null, 2);
  fs.writeFileSync(outputPath, themeJson, 'utf8');
  console.log(`✅ Generated: ${outputPath}`);
}

/**
 * Main generation function
 */
function main() {
  const themesDir = path.join(__dirname, '../themes');
  
  // Ensure themes directory exists
  if (!fs.existsSync(themesDir)) {
    fs.mkdirSync(themesDir, { recursive: true });
  }

  // Generate themes
  const darkTheme = generateTheme('dark');
  writeThemeFile(darkTheme, path.join(themesDir, 'pipelex-dark-color-theme.json'));

  const lightTheme = generateTheme('light');
  writeThemeFile(lightTheme, path.join(themesDir, 'pipelex-light-color-theme.json'));

  console.log('🎨 Themes generated from JSON configuration!');
  console.log('📁 Configuration files:');
  console.log('   - config/pipelex-color-palette.json');
  console.log('   - config/pipelex-extension-config.json');
  console.log('📁 Generated themes in:', themesDir);
}

if (require.main === module) {
  main();
}

module.exports = { generateTheme, colorPalette, extensionConfig };
