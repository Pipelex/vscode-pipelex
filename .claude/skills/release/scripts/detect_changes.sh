#!/usr/bin/env bash
set -euo pipefail

# Detect which Pipelex components changed since the last release.
# Usage: detect_changes.sh [--base <git-ref>] [--repo <path>]

BASE_REF=""
REPO_DIR="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_REF="$2"; shift 2 ;;
    --repo) REPO_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

cd "$REPO_DIR"

# --- Read current versions ---
EXT_VERSION=$(jq -r '.version' editors/vscode/package.json 2>/dev/null || echo "unknown")
CLI_VERSION=$(sed -n 's/^version *= *"\(.*\)"/\1/p' crates/pipelex-cli/Cargo.toml 2>/dev/null || echo "unknown")
COMMON_VERSION=$(sed -n 's/^version *= *"\(.*\)"/\1/p' crates/pipelex-common/Cargo.toml 2>/dev/null || echo "unknown")
LSP_VERSION=$(sed -n 's/^version *= *"\(.*\)"/\1/p' crates/pipelex-lsp/Cargo.toml 2>/dev/null || echo "unknown")
WASM_VERSION=$(sed -n 's/^version *= *"\(.*\)"/\1/p' crates/pipelex-wasm/Cargo.toml 2>/dev/null || echo "unknown")
JS_LSP_VERSION=$(jq -r '.version' js/lsp/package.json 2>/dev/null || echo "unknown")

# --- Find latest tags ---
EXT_TAG=$(git tag -l 'pipelex-vscode-ext/v*' --sort=-version:refname | head -1)
CLI_TAG=$(git tag -l 'plxt-cli/v*' --sort=-version:refname | head -1)

# Fall back to first commit if no tags exist
FALLBACK_REF=$(git rev-list --max-parents=0 HEAD | head -1)
EXT_BASE="${BASE_REF:-${EXT_TAG:-$FALLBACK_REF}}"
CLI_BASE="${BASE_REF:-${CLI_TAG:-$FALLBACK_REF}}"

# --- Categorize changed files ---
categorize() {
  local file="$1"
  case "$file" in
    editors/vscode/*|js/*) echo "extension" ;;
    crates/pipelex-cli/*) echo "cli" ;;
    crates/pipelex-common/*|crates/pipelex-lsp/*|crates/pipelex-wasm/*|crates/taplo-lsp/*|crates/taplo-common/*) echo "common" ;;
    .github/*|docs/*|site/*|scripts/*) echo "ci_docs" ;;
    test-data/*) echo "test_data" ;;
    *.md) echo "ci_docs" ;;
    *) echo "other" ;;
  esac
}

count_category() {
  local base="$1" category="$2" count=0
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    [[ "$(categorize "$file")" == "$category" ]] && ((++count))
  done < <(git diff --name-only "$base"..HEAD 2>/dev/null)
  echo "$count"
}

# --- Count changes per category for each base ---
EXT_EXT_FILES=$(count_category "$EXT_BASE" "extension")
EXT_CLI_FILES=$(count_category "$EXT_BASE" "cli")
EXT_COMMON_FILES=$(count_category "$EXT_BASE" "common")
EXT_CIDOCS_FILES=$(count_category "$EXT_BASE" "ci_docs")
EXT_TEST_FILES=$(count_category "$EXT_BASE" "test_data")
EXT_OTHER_FILES=$(count_category "$EXT_BASE" "other")

CLI_EXT_FILES=$(count_category "$CLI_BASE" "extension")
CLI_CLI_FILES=$(count_category "$CLI_BASE" "cli")
CLI_COMMON_FILES=$(count_category "$CLI_BASE" "common")
CLI_CIDOCS_FILES=$(count_category "$CLI_BASE" "ci_docs")
CLI_TEST_FILES=$(count_category "$CLI_BASE" "test_data")
CLI_OTHER_FILES=$(count_category "$CLI_BASE" "other")

# --- Determine affected components ---
# Use the most recent tag as the unified base for file listing
if [[ -n "$BASE_REF" ]]; then
  UNIFIED_BASE="$BASE_REF"
elif [[ -n "$EXT_TAG" && -n "$CLI_TAG" ]]; then
  # Use whichever tag is more recent
  if git merge-base --is-ancestor "$EXT_TAG" "$CLI_TAG" 2>/dev/null; then
    UNIFIED_BASE="$CLI_TAG"
  else
    UNIFIED_BASE="$EXT_TAG"
  fi
elif [[ -n "$EXT_TAG" ]]; then
  UNIFIED_BASE="$EXT_TAG"
elif [[ -n "$CLI_TAG" ]]; then
  UNIFIED_BASE="$CLI_TAG"
else
  UNIFIED_BASE="$FALLBACK_REF"
fi

EXT_AFFECTED="false"
CLI_AFFECTED="false"
COMMON_AFFECTED="false"
CI_DOCS_ONLY="true"

(( EXT_EXT_FILES + EXT_COMMON_FILES > 0 )) && EXT_AFFECTED="true" && CI_DOCS_ONLY="false"
(( CLI_CLI_FILES + CLI_COMMON_FILES > 0 )) && CLI_AFFECTED="true" && CI_DOCS_ONLY="false"
(( EXT_COMMON_FILES + CLI_COMMON_FILES > 0 )) && COMMON_AFFECTED="true"
(( EXT_OTHER_FILES + CLI_OTHER_FILES + EXT_TEST_FILES + CLI_TEST_FILES > 0 )) && CI_DOCS_ONLY="false"

# --- Check changelog status ---
UNRELEASED_CONTENT=""
IN_UNRELEASED=false
while IFS= read -r line; do
  if [[ "$line" =~ ^##[[:space:]]*\[Unreleased\] ]]; then
    IN_UNRELEASED=true
    continue
  fi
  if $IN_UNRELEASED && [[ "$line" =~ ^##[[:space:]]*\[ ]]; then
    break
  fi
  if $IN_UNRELEASED && [[ -n "$line" ]] && [[ ! "$line" =~ ^[[:space:]]*$ ]]; then
    UNRELEASED_CONTENT+="$line"$'\n'
  fi
done < CHANGELOG.md

UNRELEASED_HAS_CONTENT="false"
UNRELEASED_LINES=0
if [[ -n "$UNRELEASED_CONTENT" ]]; then
  UNRELEASED_HAS_CONTENT="true"
  UNRELEASED_LINES=$(echo "$UNRELEASED_CONTENT" | wc -l | tr -d ' ')
fi

# --- Output ---
cat <<EOF
=== PIPELEX RELEASE DETECTION ===
REPO: $(pwd)
DATE: $(date +%Y-%m-%d)

--- CURRENT VERSIONS ---
extension: $EXT_VERSION
cli: $CLI_VERSION
pipelex-common: $COMMON_VERSION
pipelex-lsp: $LSP_VERSION
pipelex-wasm: $WASM_VERSION
pipelex-lsp-js: $JS_LSP_VERSION

--- LATEST TAGS ---
extension: ${EXT_TAG:-<none>}
cli: ${CLI_TAG:-<none>}

--- CHANGES SINCE LAST EXTENSION RELEASE (${EXT_BASE}) ---
extension_files: $EXT_EXT_FILES
cli_files: $EXT_CLI_FILES
common_files: $EXT_COMMON_FILES
ci_docs_files: $EXT_CIDOCS_FILES
test_data_files: $EXT_TEST_FILES
other_files: $EXT_OTHER_FILES

--- CHANGES SINCE LAST CLI RELEASE (${CLI_BASE}) ---
extension_files: $CLI_EXT_FILES
cli_files: $CLI_CLI_FILES
common_files: $CLI_COMMON_FILES
ci_docs_files: $CLI_CIDOCS_FILES
test_data_files: $CLI_TEST_FILES
other_files: $CLI_OTHER_FILES

--- AFFECTED COMPONENTS ---
extension: $EXT_AFFECTED
cli: $CLI_AFFECTED
common: $COMMON_AFFECTED
ci_docs_only: $CI_DOCS_ONLY

--- CHANGED FILES (since ${UNIFIED_BASE}) ---
EOF

git diff --name-only "$UNIFIED_BASE"..HEAD 2>/dev/null | while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  echo "[$(categorize "$file")] $file"
done

cat <<EOF

--- CHANGELOG STATUS ---
unreleased_has_content: $UNRELEASED_HAS_CONTENT
unreleased_lines: $UNRELEASED_LINES
EOF
