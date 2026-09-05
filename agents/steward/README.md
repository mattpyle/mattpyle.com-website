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

**Three independent workflows**, all orchestrated by one Temporal worker:

- **`reviewPost`** — reviews one piece of content: mechanical checks (spelling, frontmatter), prose
  linting ([Vale](https://vale.sh)), an LLM editorial pass, and — for unpublished drafts — a real
  `astro build` audited with axe and Lighthouse. All of it fans out in parallel, gets synthesized into
  one report, and archives to disk. In **gate** mode (an unpublished draft) it then parks durably on a
  human `approve`/`reject` signal. In **audit** mode (already-published content) it stops there —
  advisory only, no verdict, no publish leg.
- **`scorecardAuditWorkflow`** — a separate, scheduled-or-manual sweep of the *live* site (not a
  draft) against a fixed set of public conformance metrics (axe violations, Lighthouse categories,
  agentic-browsing checks). It opens a PR when the result changed or the last run is stale, and never
  self-merges. A daily Temporal Schedule fires it at 03:30 local, in Temporal Cloud, on the hosted
  worker, so a firing produces a run with this laptop shut.
- **`auditSiteWorkflow`** — one agent-readiness audit of *any* site, run durably: the fetch-based
  checks, and on the deep tier one browser-rendered page per activity, then assembly. Started by the
  local MCP server (`steward mcp-serve`) and by the site's public `/mcp` endpoint's `deep_audit` tool;
  both hand back a workflow ID immediately and serve the report by polling. `steward audit-url` runs
  the same engine in-process with no worker and no Temporal.

### Task queues and workers

Three queues, split by **locality** — which worker is allowed to do the work, not how heavy it is:

| Queue | Carries | Why it is where it is |
|---|---|---|
| `steward-light` | `reviewPost`'s passes | Reads the working copy and applies patches to local files |
| `steward-heavy` | `buildAndAuditDraft` | Same working copy, plus a browser |
| `steward-audit` | `auditSiteWorkflow` and `scorecardAuditWorkflow`, with all of their activities | Depends on nothing local: it reaches the site over HTTP and the repository over the GitHub API |

Two workers claim them, and never compete. The **laptop worker** (`steward up`, `src/worker.ts`)
registers all three. The **hosted worker** (`src/worker-hosted.ts`, the Railway container) registers
`steward-audit` alone, and exactly the twelve activities those two workflows name: a worker that
claimed `snapshotDraft` would fail it, because the container has no drafts, and a failed task is
worse than an unclaimed one.

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

Steward never touches your working directory to do any of this: the branch, the commit, and the
push all happen in its own git worktree. The commit carries the post's whole payload, not only its
markdown: everything under `src/assets/<collection>/<slug>/`, any `src/assets/` file the post
references relatively, every `public/` file the body or frontmatter names by root-relative path, and
`cspell.shared.yaml` when a `dict-add` changed it. `lib/post-payload.ts` names that set, and the
build audit's worktree overlay reads the same resolver, so what gets audited and what gets committed
cannot drift apart.

The commit also carries the three committed files under `src/data/` that `npm run prebuild`
generates — `page-paths.mjs`, `a2a-digest.json`, `agent-skills-index.json`. They are not resolved
from your checkout: the publish leg runs those three scripts in its own worktree, against the
content tree the commit is about to create, and stages whatever changed. Site tests assert the
committed copy matches the generator's output, so a post-only commit left them stale and the PR's
`Site tests & astro check` went red. `lib/generated-data.ts` names the three, and `steward cleanup`
sweeps them from your checkout for the same reason it sweeps the dictionary. A generator that exits
non-zero fails the publish non-retryably with its stderr, before the push.

The cost is that a draft you never committed is still sitting in your checkout afterwards, along
with untracked twins of its assets, and `git pull` refuses to move past the first one it would
overwrite. `steward cleanup <slug>` is the reconciliation step for that. It removes the post and
every companion the publish carried, guarded so it deletes only a file that is provably recoverable
from `origin` and refuses rather than guesses.

The review archive is split by the same publication line. `reviews/` is the committed dataset, but a
review file quotes the post line by line and carries its critique, so while the post says
`draft: true` its review is archived to `.reviews-drafts/`, which is gitignored — an unpublished
draft and its criticism must not reach public history, which cannot be recalled any more than a
cached RSS entry can.

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

steward up                   # starts the worker, and the dev server if that's the target
```

Then, in another terminal:

```bash
steward review my-draft-slug     # runs the checks, parks on your verdict
steward status my-draft-slug     # see where it's at
steward approve my-draft-slug    # opens the publish PR, then verifies once merged
steward cleanup my-draft-slug    # after the merge: drop the local draft twin and fast-forward
steward inbox                    # every review waiting on you, across every slug
steward audit-url example.com    # agent-readiness checks against any site
steward mcp-serve                # serve the audit over MCP, backed by local Temporal
```

`steward <verb> --help` prints the real options for each.

> [!TIP]
> Run any command with `npx tsx src/cli.ts <args>` instead of the `steward` shim if something fails
> silently — the shim's process wrapping can swallow the CLI's own error output.

### Which Temporal service it talks to

Three environment variables decide, read from `agents/steward/.env`:

```bash
TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233
TEMPORAL_NAMESPACE=<namespace>.<account>
TEMPORAL_API_KEY=<key>
```

**The API key is the switch.** Set, and the client and the worker both connect to Temporal Cloud over
TLS. Absent or empty, and both fall back to the local dev server at `localhost:7233` in the `default`
namespace, which is how this ran before and how it still runs with no `.env` at all. Task queues,
workflow IDs and every workflow are identical either way; only the connection changes.

The address and the namespace cannot be the switch, because both have local defaults that a Cloud
setup must also override — keying off either would read a half-configured environment as a complete
one. A non-loopback address with no key is refused at connect time rather than left to fail later as
a transport error that names neither cause.

`resolveTemporalConnection` in `config.ts` is the single place this is decided, and both
`Connection.connect` (the CLI) and `NativeConnection.connect` (the worker) build from it, so the two
halves of the stack cannot end up on different services.

One thing Cloud does not change: a workflow only advances while *some* worker polls its queue. For
`steward-audit` that is the hosted container; for `reviewPost` it is still `steward up` on this
machine.

## What the site imports from here

Steward was a pure sidecar until 2026-08-12 and is no longer: the site's public `/mcp` endpoint
imports from this workspace through two entries its exports map publishes. Nothing else in the
site's `src/` may import from here.

| Entry | What it publishes | What guards it |
|---|---|---|
| `@mattpyle/steward/agent-audit/fast` | The fast-tier audit, run inside the Vercel function | `tests/steward-fast-audit-packaging.test.mjs`: the graph may reach `undici` and `node:` and nothing else, and never `@temporalio/*`, `chrome-launcher`, `lighthouse` or the axe CLI |
| `@mattpyle/steward/agent-audit/deep-contract` | The deep tier's names and types: workflow type, task queue, query name, ID scheme, budgets, state shape | `tests/steward-deep-contract-packaging.test.mjs`: **no value imports at all**, so the bundle inherits nothing |

That constraint is why `runAudit` takes the deep tier as an injected `loadDeep` thunk rather than
importing it: a dynamic import is lazy for Node and eager for every bundler. A third entry has to
clear the same bar, and the argument is stated in the repo root's `CLAUDE.md`.

## The auditor's identity

The fetcher, Lighthouse's Chrome and axe's Chrome all send `AUDIT_USER_AGENT`,
`steward-audit/0.2.0 (+https://www.mattpyle.com/steward)`, so an audit is one visitor in the target's
access log and the one robots.txt token, `steward-audit`, refuses all of it. The token has to stay
the User-Agent's first product token, and a test holds the two together, because a robots.txt rule
naming a token the auditor does not send is a refusal that silently does nothing. The string must
also stay free of commas and semicolons: `@axe-core/cli` splits its `--chrome-options` value on both.

The URL points at `/steward`, the public page explaining what the audit checks, what one costs a
site, and how to refuse it.

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
- **It's a sidecar.** Delete `agents/steward/` and the site builds, deploys and serves identically,
  with the one exception above: the `/mcp` route's build depends on those two exports entries.

## Operator documentation

Task-shaped units — run a review, approve, audit a site, rotate a credential, troubleshoot a stuck
workflow — live in `steward/docs/`, one file per question, indexed by `steward/docs/README.md`.
That directory is private to this machine and not part of the repository, along with the design spec
and the build log. This README is the public account of what Steward is; the units are how it is
operated day to day.
