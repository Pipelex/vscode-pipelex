#!/usr/bin/env bash
# The one reading of which `@pipelex/mthds-ui` specs this repo may commit, shared by
# `.githooks/pre-commit` and `make check-no-local-deps` so the two guards cannot disagree.
#
# Two spellings are admitted:
#   - `npm:<version>`, what `make use-npm VERSION=X.Y.Z` writes — the ordinary state of the repo.
#   - `github:<owner>/<repo>#<40-hex sha>`, a sprint pin as the workspace's `wt pin` writes it. A full
#     commit SHA is what makes it a pin: it resolves the same bytes forever, where a branch or a tag
#     moves under the lockfile, and it is collapsed back onto `npm:` before its branch merges.
#
# Everything else is refused, above all the `portal:` link `make use-local` writes, and a `github:`
# source naming a branch, a tag or an abbreviated SHA.
set -euo pipefail

manifest="${1:-editors/vscode/package.json}"
package='@pipelex/mthds-ui'

if [ ! -f "$manifest" ]; then
    echo "ERROR: $manifest not found."
    exit 1
fi

# Every entry is judged, not merely the first: an admitted spelling in `dependencies` must not
# vouch for a `portal:` link standing in `resolutions`.
specs=$(sed -nE 's/.*"@pipelex\/mthds-ui"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$manifest")
if [ -z "$specs" ]; then
    echo "ERROR: $manifest declares no $package dependency."
    exit 1
fi

refused=0
while IFS= read -r spec; do
    case "$spec" in
        npm:*)
            ;;
        github:*)
            if ! printf '%s\n' "$spec" | grep -qE '^github:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9a-f]{40}$'; then
                echo "ERROR: $package in $manifest is \"$spec\", a github: source that is not a full commit SHA."
                echo "A sprint pin names the whole 40-character SHA, which \`wt pin\` writes; a branch or tag moves under the lock."
                refused=1
            fi
            ;;
        portal:* | file:* | link:*)
            echo "ERROR: $package in $manifest is \"$spec\", a local link left by \`make use-local\`."
            echo "Run 'make use-npm VERSION=X.Y.Z' before committing."
            refused=1
            ;;
        *)
            echo "ERROR: $package in $manifest is \"$spec\", which is neither the npm spec nor a sprint pin."
            echo "Run 'make use-npm VERSION=X.Y.Z' before committing."
            refused=1
            ;;
    esac
done <<< "$specs"

exit "$refused"
