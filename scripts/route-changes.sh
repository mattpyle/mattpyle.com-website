#!/usr/bin/env bash
# Sorts a pull request's changed files into the routing outputs and writes
# them to $GITHUB_OUTPUT: `site`, `steward` and `browser`, plus `steward_tests`,
# the test files the Steward job runs, and `steward_tests_label`, a short name
# for the step.
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
#
# `steward_tests` is one of three things:
#   1. `tests/**/*.test.ts`, the full suite, for a push and for any change that
#      sets `steward` from outside `agents/steward/` (content, data, the
#      lockfile, a workflow or routing script). `steward_wide` marks them.
#   2. A space-separated list of test files, for a change confined to
#      `agents/steward/`. `scripts/select-steward-tests.mjs` builds it from the
#      import graph, and its header lists the exceptions that widen it to the
#      full suite and the one that adds the replay suite.
#   3. Empty, when no test reaches the change. The Steward job then runs the
#      typecheck only and says so.
# That script needs the `typescript` package. The `changes` job of `ci.yml`
# installs it; `a11y.yml`'s job does not, and does not read `steward_tests`, so
# there the script exits 3 and the glob stands. Any other failure also keeps the
# glob, with a warning: a selector that breaks must not skip tests. A change that
# sets `browser` always keeps the real-Chrome test in the list, since a change
# to the Dockerfile reaches it through no import.
set -euo pipefail

event_name="${1:?usage: route-changes.sh <event-name> <base-sha>}"
base_sha="${2:-}"
output="${GITHUB_OUTPUT:-/dev/stdout}"
scratch="${RUNNER_TEMP:-$(mktemp -d)}"

site=false
steward=false
browser=false
# Set by any change that sets `steward` from outside `agents/steward/`, and by any
# event but a pull request; it keeps the full glob.
steward_wide=false
if [ "$event_name" != "pull_request" ]; then
  site=true
  steward=true
  steward_wide=true
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
          src/content/*|src/data/*|package.json|package-lock.json|.github/workflows/ci.yml|scripts/route-changes.sh|scripts/select-steward-tests.mjs|scripts/vercel-ignore.sh) steward=true; steward_wide=true ;;
        esac
        case "$file" in
          package-lock.json|.github/workflows/ci.yml|scripts/route-changes.sh|scripts/select-steward-tests.mjs|scripts/vercel-ignore.sh) browser=true ;;
        esac
        ;;
    esac
  done < "$scratch/changed.txt"
  echo "Changed files: $(wc -l < "$scratch/changed.txt")"
fi
full_glob='tests/**/*.test.ts'
steward_tests="$full_glob"
if [ "$steward" = true ] && [ "$steward_wide" = false ]; then
  select_status=0
  steward_tests="$(node scripts/select-steward-tests.mjs < "$scratch/changed.txt" 2> "$scratch/select.log")" || select_status=$?
  cat "$scratch/select.log"
  if [ "$select_status" -eq 3 ]; then
    echo "typescript is not installed here; the Steward tests keep the full glob"
    steward_tests="$full_glob"
  elif [ "$select_status" -ne 0 ]; then
    echo "::warning::select-steward-tests.mjs failed (exit $select_status); the Steward tests keep the full glob"
    steward_tests="$full_glob"
  elif [ "$browser" = true ] && [ "$steward_tests" != "$full_glob" ]; then
    chrome=tests/lib/agent-audit-deep-chrome.test.ts
    case " $steward_tests " in
      *" $chrome "*) ;;
      *) steward_tests="${steward_tests:+$steward_tests }$chrome" ;;
    esac
  fi
fi
if [ "$steward_tests" = "$full_glob" ]; then
  steward_tests_label="$full_glob"
elif [ -z "$steward_tests" ]; then
  steward_tests_label="none, typecheck only"
else
  steward_tests_label="$(wc -w <<< "$steward_tests" | tr -d ' ') selected files"
fi
echo "site=$site" >> "$output"
echo "steward=$steward" >> "$output"
echo "browser=$browser" >> "$output"
echo "steward_tests=$steward_tests" >> "$output"
echo "steward_tests_label=$steward_tests_label" >> "$output"
echo "Routing: site=$site steward=$steward browser=$browser steward_tests=$steward_tests_label"
