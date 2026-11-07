#!/usr/bin/env bash
# Vercel's `ignoreCommand` (vercel.json): exit 0 skips the build, exit 1 builds.
#
# A preview skips when the branch's changes since its merge base with `master`
# cannot reach the built site. The rule is `scripts/route-changes.sh`, called
# here as a pull request would call it; this wrapper owns only what Vercel
# needs around it: a shallow clone to deepen, a base commit with no event to
# name it, and an exit code in place of the `site` line.
#
# Every path that is not a clear "skip" exits 1: production, a missing
# `origin`, a failed fetch, a failed diff. A bug here costs a build, never a
# missing preview on a fix PR the findings loop is waiting on.
#
# The base is the merge base, not VERCEL_GIT_PREVIOUS_SHA: that variable is the
# branch's last deployment, so a second push would see only its own commit.
[ "${VERCEL_ENV:-}" = "preview" ] || exit 1

# Vercel's clone has no `origin` remote (PR 596's build log: "'origin' does not
# appear to be a git repository"), here or in `route-changes.sh`. The repository
# is public, so an anonymous fetch by URL works.
git remote get-url origin > /dev/null 2>&1 \
  || git remote add origin https://github.com/mattpyle/mattpyle.com-website.git || exit 1

# Vercel clones shallow. Deepen only a shallow clone: `--depth` on a full one
# would make it shallow.
depth=
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  depth=--depth=1000
fi
git fetch --no-tags $depth origin "+refs/heads/master:refs/remotes/origin/master" "$(git rev-parse HEAD)" || exit 1
base=$(git merge-base HEAD refs/remotes/origin/master) || exit 1

out=$(mktemp) || exit 1
GITHUB_OUTPUT="$out" bash scripts/route-changes.sh pull_request "$base" || exit 1
grep -qx 'site=false' "$out" && exit 0
exit 1
