#!/usr/bin/env bash
set -euo pipefail

# Config
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-upstream}"   # your local mirror branch of Taplo/main
ROOT_README_PATH="README.md"
CONTRIB_PATH="CONTRIBUTING.md"
VSCODE_README_PATH="editors/vscode/README.md"
VSCODE_CHANGELOG_PATH="editors/vscode/CHANGELOG.md"

mkdir -p docs/upstream

# Helper to extract a file from the upstream branch into docs/upstream
pull_from_upstream () {
  local relpath="$1"
  local outfile="$2"
  if git show "${UPSTREAM_BRANCH}:${relpath}" > "$outfile" 2>/dev/null; then
    echo "✓ Pulled ${relpath}"
  else
    echo "⚠️  ${relpath} not found in ${UPSTREAM_BRANCH} (skipped)" >&2
    rm -f "$outfile" || true
  fi
}

echo "🔄 Syncing documentation from upstream..."
echo "Using upstream branch: ${UPSTREAM_BRANCH}"

# 1) Grab upstream docs (exact copies)
pull_from_upstream "README.md" "docs/upstream/README.UPSTREAM.md"
pull_from_upstream "CONTRIBUTING.md" "docs/upstream/CONTRIBUTING.UPSTREAM.md"
pull_from_upstream "editors/vscode/README.md" "docs/upstream/VSCODE_README.UPSTREAM.md"
pull_from_upstream "editors/vscode/CHANGELOG.md" "docs/upstream/VSCODE_CHANGELOG.UPSTREAM.md"

# 2) Compose final files by prepending headers
compose () {
  local header="$1"
  local upstream_copy="$2"
  local target="$3"
  local header_file="$4"

  echo "📝 Composing ${target}"
  {
    echo "<!-- GENERATED: do not edit ${target} directly."
    echo "     Edit ${header_file} and run scripts/compose-docs.sh -->"
    echo
    cat "$header"
    echo
    if [[ -f "$upstream_copy" ]]; then
      cat "$upstream_copy"
    else
      echo "_(No upstream file present for this path in ${UPSTREAM_BRANCH}.)_"
    fi
  } > "$target"
}

compose "docs/pipelex/README.header.md" "docs/upstream/README.UPSTREAM.md" "$ROOT_README_PATH" "docs/pipelex/README.header.md"
compose "docs/pipelex/CONTRIBUTING.header.md" "docs/upstream/CONTRIBUTING.UPSTREAM.md" "$CONTRIB_PATH" "docs/pipelex/CONTRIBUTING.header.md"
compose "docs/pipelex/VSCODE_README.header.md" "docs/upstream/VSCODE_README.UPSTREAM.md" "$VSCODE_README_PATH" "docs/pipelex/VSCODE_README.header.md"

# Handle VS Code CHANGELOG if header exists
if [[ -f "docs/pipelex/CHANGELOG.header.md" ]]; then
  echo "📝 Composing ${VSCODE_CHANGELOG_PATH}"
  {
    echo "<!-- GENERATED: do not edit ${VSCODE_CHANGELOG_PATH} directly."
    echo "     Edit CHANGELOG.md and docs/pipelex/CHANGELOG.header.md and run scripts/compose-docs.sh -->"
    echo
    # Include root CHANGELOG.md content first
    if [[ -f "CHANGELOG.md" ]]; then
      cat "CHANGELOG.md"
      echo
      echo "---"
      echo
    fi
    # Then add the header (which contains Taplo section)
    cat "docs/pipelex/CHANGELOG.header.md"
    echo
    # Finally add upstream Taplo changelog
    if [[ -f "docs/upstream/VSCODE_CHANGELOG.UPSTREAM.md" ]]; then
      cat "docs/upstream/VSCODE_CHANGELOG.UPSTREAM.md"
    else
      echo "_(No upstream file present for this path in ${UPSTREAM_BRANCH}.)_"
    fi
  } > "$VSCODE_CHANGELOG_PATH"
fi

echo
echo "✅ Docs composed successfully!"
echo "📋 Files updated:"
echo "   - $ROOT_README_PATH"
echo "   - $CONTRIB_PATH" 
echo "   - $VSCODE_README_PATH"
if [[ -f "docs/pipelex/CHANGELOG.header.md" ]]; then
  echo "   - $VSCODE_CHANGELOG_PATH"
fi
echo
echo "🔍 Review changes and commit:"
echo "   git add $ROOT_README_PATH $CONTRIB_PATH $VSCODE_README_PATH docs/upstream/*"
echo "   git commit -m \"docs: sync upstream docs and prepend Pipelex overlay\""
echo
echo "💡 To update documentation in the future, simply run:"
echo "   ./scripts/compose-docs.sh"
