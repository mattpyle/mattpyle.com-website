#!/usr/bin/env bash
# Sorts a pull request's changed files into the three routing outputs and
# writes them to $GITHUB_OUTPUT: `site`, `steward` and `browser`.
#
#   scripts/route-changes.sh <event-name> <base-sha>
#
# Called from two workflows, `ci.yml` and `a11y.yml`, each in a `changes` job.
# There is one copy on purpose: the two tables drifted apart within a day when
# the `browser` output was added to only one of them. The routing table, and
# the reason for each row, is the header of `ci.yml`. Change a row here and
# update that table in the same commit.
#
# Any event other than `pull_request` skips the diff and sets `site` and
# `steward` true, so master timings and the drift checks that read master runs
# stay comparable. It leaves `browser` false: the pull request already ran it.
set -euo pipefail

event_name="${1:?usage: route-changes.sh <event-name> <base-sha>}"
base_sha="${2:-}"
output="${GITHUB_OUTPUT:-/dev/stdout}"
scratch="${RUNNER_TEMP:-$(mktemp -d)}"

site=false
steward=false
browser=false
if [ "$event_name" != "pull_request" ]; then
  site=true
  steward=true
else
  git fetch --no-tags --depth=1 origin "$base_sha"
  git diff --name-only --no-renames "$base_sha" HEAD > "$scratch/changed.txt"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    # Markdown is documentation unless it is published content.
    case "$file" in
      src/content/*) ;;
      *.md) continue ;;
    esac
    case "$file" in
      agents/steward/*)
        steward=true
        case "$file" in
          agents/steward/src/lib/agent-audit/*|agents/steward/package.json) site=true; browser=true ;;
          agents/steward/src/lib/audit-engine.ts|agents/steward/src/lib/chrome-probe.ts|agents/steward/Dockerfile) browser=true ;;
        esac
        ;;
      *)
        site=true
        case "$file" in
          src/content/*|src/data/*|package.json|package-lock.json|.github/workflows/ci.yml) steward=true ;;
        esac
        case "$file" in
          package-lock.json|.github/workflows/ci.yml) browser=true ;;
        esac
        ;;
    esac
  done < "$scratch/changed.txt"
  echo "Changed files: $(wc -l < "$scratch/changed.txt")"
fi
echo "site=$site" >> "$output"
echo "steward=$steward" >> "$output"
echo "browser=$browser" >> "$output"
echo "Routing: site=$site steward=$steward browser=$browser"
