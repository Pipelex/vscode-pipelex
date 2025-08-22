#!/bin/bash

# Script to publish @pipelex/lsp from anywhere in the repo
# Usage: ./publish-lsp.sh [patch|minor|major]

# Get the directory where this script is located (repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS_DIR="$SCRIPT_DIR/js"
VSCODE_DIR="$SCRIPT_DIR/editors/vscode"

# Default to patch if no argument provided
VERSION_TYPE="${1:-patch}"

# Validate version type
if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
    echo "❌ Error: Version type must be 'patch', 'minor', or 'major'"
    echo "Usage: $0 [patch|minor|major]"
    exit 1
fi

echo "🚀 Publishing @pipelex/lsp with $VERSION_TYPE version bump..."

# Navigate to JS workspace root
cd "$JS_DIR" || {
    echo "❌ Error: Could not find js directory at $JS_DIR"
    exit 1
}

# Use yarn workspace commands (best practice for yarn workspaces)
echo "📦 Building LSP package..."
yarn workspace @pipelex/lsp run clean
yarn workspace @pipelex/lsp run build || {
    echo "❌ Error: Build failed"
    exit 1
}

echo "🔖 Bumping version..."
yarn workspace @pipelex/lsp version $VERSION_TYPE || {
    echo "❌ Error: Version bump failed"
    exit 1
}

echo "📤 Publishing to npm..."
cd lsp && npm publish --access public || {
    echo "❌ Error: npm publish failed"
    exit 1
}
cd ..

echo "🔄 Updating VSCode extension..."
cd "$VSCODE_DIR" || {
    echo "❌ Error: Could not find vscode directory at $VSCODE_DIR"
    exit 1
}

# Update VSCode extension to use latest published version
yarn add @pipelex/lsp@latest || {
    echo "❌ Error: Failed to update VSCode extension"
    exit 1
}

echo "🔨 Building VSCode extension..."
yarn build || {
    echo "❌ Error: Failed to build VSCode extension"
    exit 1
}

echo "✅ VSCode extension updated and built with latest @pipelex/lsp"
echo "✅ Publishing complete!"
