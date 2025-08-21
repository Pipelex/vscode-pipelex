#!/usr/bin/env bash
set -euo pipefail

# Config
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-upstream}"   # your local mirror branch of Taplo/main
ROOT_README_PATH="README.md"
CONTRIB_PATH="CONTRIBUTING.md"
VSCODE_README_PATH="editors/vscode/README.md"

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

# 2) Compose final files by prepending headers
compose () {
  local header="$1"
  local upstream_copy="$2"
  local target="$3"

  echo "📝 Composing ${target}"
  {
    cat "$header"
    echo
    if [[ -f "$upstream_copy" ]]; then
      cat "$upstream_copy"
    else
      echo "_(No upstream file present for this path in ${UPSTREAM_BRANCH}.)_"
    fi
  } > "$target"
}

compose "docs/pipelex/README.header.md" "docs/upstream/README.UPSTREAM.md" "$ROOT_README_PATH"
compose "docs/pipelex/CONTRIBUTING.header.md" "docs/upstream/CONTRIBUTING.UPSTREAM.md" "$CONTRIB_PATH"
compose "docs/pipelex/VSCODE_README.header.md" "docs/upstream/VSCODE_README.UPSTREAM.md" "$VSCODE_README_PATH"

echo
echo "✅ Docs composed successfully!"
echo "📋 Files updated:"
echo "   - $ROOT_README_PATH"
echo "   - $CONTRIB_PATH" 
echo "   - $VSCODE_README_PATH"
echo
echo "🔍 Review changes and commit:"
echo "   git add $ROOT_README_PATH $CONTRIB_PATH $VSCODE_README_PATH docs/upstream/*"
echo "   git commit -m \"docs: sync upstream docs and prepend Pipelex overlay\""
echo
echo "💡 To update documentation in the future, simply run:"
echo "   ./scripts/compose-docs.sh"
