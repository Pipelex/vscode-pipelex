#!/bin/bash

# Script to publish @pipelex/tools-wasm from anywhere in the repo
# Usage: ./publish-tools-wasm.sh [patch|minor|major|none]
# ("none" publishes the version currently in package.json without bumping —
#  useful for a first publish of a freshly added version.)

# Get the directory where this script is located (repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS_DIR="$SCRIPT_DIR/js"

# Default to patch if no argument provided
VERSION_TYPE="${1:-patch}"

# Validate version type
if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major|none)$ ]]; then
    echo "❌ Error: Version type must be 'patch', 'minor', 'major', or 'none'"
    echo "Usage: $0 [patch|minor|major|none]"
    exit 1
fi

echo "🚀 Publishing @pipelex/tools-wasm with $VERSION_TYPE version bump..."

# Navigate to JS workspace root
cd "$JS_DIR" || {
    echo "❌ Error: Could not find js directory at $JS_DIR"
    exit 1
}

# Use yarn workspace commands (best practice for yarn workspaces)
echo "📦 Building release bundle..."
yarn workspace @pipelex/tools-wasm run clean
RELEASE=true yarn workspace @pipelex/tools-wasm run build || {
    echo "❌ Error: Build failed"
    exit 1
}

echo "🧪 Testing the release bundle..."
yarn workspace @pipelex/tools-wasm run test || {
    echo "❌ Error: Tests failed against the release bundle"
    exit 1
}

if [[ "$VERSION_TYPE" != "none" ]]; then
    echo "🔖 Bumping version..."
    yarn workspace @pipelex/tools-wasm version "$VERSION_TYPE" || {
        echo "❌ Error: Version bump failed"
        exit 1
    }
fi

echo "📤 Publishing to npm..."
cd tools-wasm && npm publish --access public || {
    echo "❌ Error: npm publish failed"
    exit 1
}
cd ..

echo "✅ Publishing complete!"
echo "ℹ️  Remember to commit the version bump in js/tools-wasm/package.json"
