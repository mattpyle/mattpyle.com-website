#!/usr/bin/env bash
# Sorts a pull request's changed files into the routing outputs and writes
# them to $GITHUB_OUTPUT: `site`, `steward`, `browser` and `consultant`, plus `steward_tests`,
# which says how the Steward job picks its tests, and `steward_changed`, the
# changed files it picks from.
#
#   scripts/route-changes.sh <event-name> <base-sha> [base]
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
# On a pull request the diff runs from the merge commit's first parent to the
# merge commit. The first parent is master as it stands now. The recorded base,
# `base-sha`, is master as it stood when the pull request opened. Once master
# moves on, a diff against that base also lists every change merged since. Those
# changes then route the pull request to jobs it did not touch. The recorded base
# is used only when HEAD is not a merge commit. The checkout is shallow, so the
# script fetches HEAD's parents before it checks for a merge commit.
#
# A third argument, `base`, turns that rule off: the diff always runs from
# `base-sha`. `vercel-ignore.sh` passes it. Vercel checks out the branch tip, not
# GitHub's merge commit, so a merge commit there is a branch that merged master
# in, and its first parent is the branch. A diff from the first parent would list
# only what master brought, and a site change would lose its preview.
#
# `steward_tests` is one of three things:
#   1. `tests/**/*.test.ts`, the full suite, for a push and for a change to
#      `package.json`, the lockfile, `ci.yml` or a routing script.
#      `steward_wide` marks them.
#   2. `tests/console/**/*.test.ts`, when every Steward file changed sits under
#      `src/console/` or `tests/console/`, assets included. The findings console
#      is an island: nothing outside it imports it except the `steward console`
#      verb in `src/cli.ts`, which loads it on demand, and the console tests read
#      its assets by path. This rule comes first because the graph would add the
#      CLI tests that reach the console. `steward_nonconsole` marks the changes
#      that are not console-only.
#   3. `select`, for any other change under `agents/steward/`, and for a change
#      under `src/content/` or `src/data/`, which `steward_site` marks: the
#      script's `SITE_READERS` names the few tests that read those folders. The Steward
#      job then runs `scripts/select-steward-tests.mjs` on `steward_changed`, the
#      changed files written here, after its `npm ci`, because the script needs
#      the installed `typescript`. This script stays free of node so that
#      `a11y.yml`'s job and `vercel-ignore.sh` run it with nothing installed.
# `steward_changed` is written only for `select`.
set -euo pipefail

event_name="${1:?usage: route-changes.sh <event-name> <base-sha>}"
base_sha="${2:-}"
diff_from="${3:-}"
output="${GITHUB_OUTPUT:-/dev/stdout}"
scratch="${RUNNER_TEMP:-$(mktemp -d)}"

site=false
steward=false
browser=false
consultant=false
# Set by the install, the workflow file and the routing scripts, and by any
# event but a pull request; it keeps the full glob.
steward_wide=false
# Set by the site's content and data; it hands the choice to the script's list.
steward_site=false
# Set by any Steward file outside the console; it hands the choice to the graph.
steward_nonconsole=false
if [ "$event_name" != "pull_request" ]; then
  site=true
  steward=true
  consultant=true
  steward_wide=true
else
  # The checkout is shallow: fetch HEAD's parents before reading them.
  git fetch --no-tags --depth=2 origin "$(git rev-parse HEAD)"
  if [ "$diff_from" != base ] && git rev-parse -q --verify HEAD^2 > /dev/null; then
    # A merge commit: its first parent is current master.
    git diff --name-only --no-renames HEAD^1 HEAD > "$scratch/changed.txt"
  else
    # Not a merge commit, or the caller asked for its own base: diff from the base given.
    git fetch --no-tags --depth=1 origin "$base_sha"
    git diff --name-only --no-renames "$base_sha" HEAD > "$scratch/changed.txt"
  fi
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    # Markdown is documentation unless it is published content, a file the site
    # serves or builds from (`public/agents.md`, the skills under `src/data/`),
    # or Steward source.
    case "$file" in
      src/content/*|src/data/*|public/*|agents/steward/src/*) ;;
      *.md) continue ;;
    esac
    case "$file" in
      agents/steward/*)
        steward=true
        case "$file" in
          agents/steward/src/console/*|agents/steward/tests/console/*) ;;
          *) steward_nonconsole=true ;;
        esac
        case "$file" in
          agents/steward/src/lib/agent-audit/*|agents/steward/package.json) site=true; browser=true ;;
          agents/steward/src/lib/audit-engine.ts|agents/steward/src/lib/chrome-probe.ts|agents/steward/Dockerfile) browser=true ;;
        esac
        ;;
      agents/consultant/*)
        # The audit consultant: its own package and its own job. The site never imports it.
        consultant=true
        ;;
      *)
        site=true
        case "$file" in
          src/content/*|src/data/*) steward=true; steward_site=true ;;
          package.json|package-lock.json|.github/workflows/ci.yml|scripts/route-changes.sh|scripts/select-steward-tests.mjs|scripts/vercel-ignore.sh) steward=true; steward_wide=true ;;
        esac
        case "$file" in
          package-lock.json|.github/workflows/ci.yml|scripts/route-changes.sh|scripts/select-steward-tests.mjs|scripts/vercel-ignore.sh) browser=true ;;
        esac
        case "$file" in
          package.json|package-lock.json|.github/workflows/ci.yml|scripts/route-changes.sh) consultant=true ;;
          # The site's A2A adapter for the consultant: its integration test lives in the package.
          src/lib/a2a-consultant-*|src/lib/consultant-task-id.mjs|src/lib/a2a-responder.mjs|src/lib/mcp-temporal.mjs) consultant=true ;;
        esac
        ;;
    esac
  done < "$scratch/changed.txt"
  echo "Changed files: $(wc -l < "$scratch/changed.txt")"
fi
steward_tests='tests/**/*.test.ts'
if [ "$steward" = true ] && [ "$steward_wide" = false ]; then
  if [ "$steward_nonconsole" = true ] || [ "$steward_site" = true ]; then
    steward_tests=select
  else
    steward_tests='tests/console/**/*.test.ts'
  fi
fi
echo "site=$site" >> "$output"
echo "steward=$steward" >> "$output"
echo "browser=$browser" >> "$output"
echo "consultant=$consultant" >> "$output"
echo "steward_tests=$steward_tests" >> "$output"
if [ "$steward_tests" = select ]; then
  {
    echo "steward_changed<<CHANGED_FILES_EOF"
    cat "$scratch/changed.txt"
    echo "CHANGED_FILES_EOF"
  } >> "$output"
fi
echo "Routing: site=$site steward=$steward browser=$browser consultant=$consultant steward_tests=$steward_tests"
