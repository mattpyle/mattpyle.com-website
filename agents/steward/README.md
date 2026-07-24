# Steward

An editorial agent for [mattpyle.com](https://www.mattpyle.com), built on [Temporal](https://temporal.io)
workflows. It reviews a draft, waits — durably, for as long as it takes — for a human decision, then
publishes and checks its own work against the live site.

## Why Temporal

Editorial review has a shape that suits durable execution unusually well: a handful of checks that
can run in parallel, a wait for a human verdict that might take minutes or weeks, and a publish step
that has to survive a crashed worker, a flaky network call, or a human who merges the PR three days
later. A workflow that's been parked on a signal for three weeks resumes exactly where it left off —
that's the property being dogfooded here, on a low-stakes, real target.

## How it works

**Two independent workflows**, both orchestrated by one Temporal worker:

- **`reviewPost`** — reviews one piece of content: mechanical checks (spelling, frontmatter), prose
  linting ([Vale](https://vale.sh)), an LLM editorial pass, and — for unpublished drafts — a real
  `astro build` audited with axe and Lighthouse. All of it fans out in parallel, gets synthesized into
  one report, and archives to disk. In **gate** mode (an unpublished draft) it then parks durably on a
  human `approve`/`reject` signal. In **audit** mode (already-published content) it stops there —
  advisory only, no verdict, no publish leg.
- **`scorecardAuditWorkflow`** — a separate, scheduled-or-manual sweep of the *live* site (not a
  draft) against a fixed set of public conformance metrics (axe violations, Lighthouse categories,
  agentic-browsing checks). It opens a PR when the result changed or the last run is stale, and never
  self-merges.

### The publish leg

Approving a gate review doesn't publish anything by itself — it starts a sequence that opens a PR,
polls the live origin for propagation, and can end up **parked mid-publish** waiting for a human to
merge:

```
approve → publishing (branch, commit, push, open PR)
        → verifying deploy (checks the live origin, retries for ~15 min)
        → parked, if you haven't merged yet — resume by approving again
        → published, once the checks against production pass
```

Steward opens the pull request. **A human merges it.** That's the only thing that triggers the
Vercel deploy, and it's deliberately never automated. Re-sending `approve` after merging is an
idempotent resume — it re-checks the live site, it does not re-run the publish.

"Published" means verified against the live origin — not "the PR merged," not "the build succeeded."
The workflow checks the real page (HTML, negotiated and direct markdown variants, `llms.txt`, the
sitemap, the OG image) on `www.mattpyle.com` itself before it calls anything done.

## Quickstart

**Prerequisites:** Node 22+, the [Temporal CLI](https://docs.temporal.io/cli) on PATH, Chrome, the
Vale binary (`npm run setup:vale`), and an `.env` with `ANTHROPIC_API_KEY` (for the editorial pass)
and `GITHUB_TOKEN` (for the publish leg — a `gh auth token` won't do, since the worker reads
`process.env` directly).

```bash
npm install                  # from the repo root — this is an npm workspace
cd agents/steward
npm link                     # optional: makes `steward` a real command on PATH

steward up                   # starts the Temporal dev server + worker together
```

In another terminal:

```bash
steward review my-draft-slug     # runs the checks, parks on your verdict
steward status my-draft-slug     # see where it's at
steward approve my-draft-slug    # opens the publish PR, then verifies once merged
```

`steward inbox` lists every review waiting on you, across every slug, with a plain-language hint for
what to do next.

> [!TIP]
> Run any command with `npx tsx src/cli.ts <args>` instead of the `steward` shim if something fails
> silently — the shim's process wrapping can swallow the CLI's own error output.

## Design principles

- **It flags; it doesn't rewrite.** Every pass — mechanical or LLM — reports findings with citations
  back to the specific line. None of them patch the author's prose on their own judgment. A small,
  tightly-scoped patch application exists for unambiguous mechanical fixes (a misspelling with one
  clear correction); anything that looks like a judgment call is left for the human.
- **The live origin is the only source of truth for "published."** A merged PR or a green build is
  not the finish line — the workflow doesn't call a piece published until it's verified the actual
  checks against `www.mattpyle.com`.
- **It never merges its own PR.** Both workflows open pull requests; neither ever merges one. That
  stays a human act, on purpose.
- **It's a sidecar, not a dependency.** Delete `agents/steward/` and the site is unaffected — same
  build, same deploy, same runtime.
