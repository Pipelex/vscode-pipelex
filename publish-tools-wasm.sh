#!/bin/bash

# MANUAL ESCAPE HATCH — normally you do NOT run this.
#
# @pipelex/tools-wasm is published by CI: `/release` bumps the version in
# js/tools-wasm/package.json, the `auto_tag` job in ci.yaml tags
# pipelex-tools-wasm/v{version} on push to main, and the npm_publish_tools_wasm
# job in releases.yaml builds, tests and publishes it. Use this script only when
# CI cannot run.
#
# Usage: ./publish-tools-wasm.sh [none|patch|minor|major]
#
# The default is "none" — publish the version already committed in package.json.
# The bump belongs to `/release` and to the changelog; bumping here instead
# creates a version that no tag, no changelog entry, and no commit accounts for.
# The patch/minor/major modes are kept for genuine emergencies only, and you must
# still commit the resulting package.json change.

# Get the directory where this script is located (repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS_DIR="$SCRIPT_DIR/js"

# Default to "none": publish what is committed, bump nothing.
VERSION_TYPE="${1:-none}"

# Validate version type
if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major|none)$ ]]; then
    echo "❌ Error: Version type must be 'none', 'patch', 'minor', or 'major'"
    echo "Usage: $0 [none|patch|minor|major]"
    exit 1
fi

echo "⚠️  Manual publish — CI (releases.yaml) normally does this on a pipelex-tools-wasm/v* tag."
if [[ "$VERSION_TYPE" == "none" ]]; then
    echo "🚀 Publishing @pipelex/tools-wasm at its committed version (no bump)..."
else
    echo "🚀 Publishing @pipelex/tools-wasm with a $VERSION_TYPE version bump..."
fi

# Navigate to JS workspace root
cd "$JS_DIR" || {
    echo "❌ Error: Could not find js directory at $JS_DIR"
    exit 1
}

# Use yarn workspace commands (best practice for yarn workspaces)
echo "📦 Building release bundle..."
yarn workspace @pipelex/tools-wasm run clean || {
    echo "❌ Error: Clean failed"
    exit 1
}
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
