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
  self-merges. `steward scorecard-schedule create` puts it on a daily Temporal Schedule — which fires
  only while this local stack is up, so it is a daily audit on a laptop rather than unattended nightly
  auditing. It fires at 20:00 local, or on the next `steward up` within 23 hours of a missed firing, at
  most once a day.

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
push all happen in its own git worktree. The cost is that a draft you never committed is still
sitting in your checkout afterwards, a stale twin of the post that just went live, and `git pull`
refuses to move past it. `steward cleanup <slug>` is the reconciliation step for that, guarded so
it deletes only a file that is provably recoverable from `origin` and refuses rather than guesses.

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
steward cleanup my-draft-slug    # after the merge: drop the local draft twin, fast-forward
```

`steward inbox` lists every review waiting on you, across every slug, with a plain-language hint for
what to do next.

```bash
steward tells src/content/writing/my-post.md   # deterministic tell citations for one file
```

`steward tells` needs no worker, no Temporal server, and no API key: it reads the file, runs the five
deterministic counters, and prints counts, per-100-word densities, and the line each hit came from.
The same citations ride on every review and audit report under **MACHINE VOICE**. The composite
`aiLikenessScore` is a separate thing and stays behind `--ai-tells`, because it failed its validation
study (spec §9.2) — the citations did not.

```bash
steward audit-url example.com                  # agent-readiness checks against any site
steward audit-url example.com --fast           # HTTP checks only: no browser, seconds not minutes
```

`audit-url` points the scorecard methodology at a site that is not this one, in two tiers. The fast
tier is the agent surfaces over plain HTTP: robots.txt, sitemap, llms.txt, agents.md, markdown
content negotiation, and the well-known discovery documents, twelve checks in about a dozen
requests. The deep tier renders up to three of the site's own pages and reports Lighthouse's
per-axis scores and axe-core's violation counts across them, using the same runners the scorecard
uses so the numbers mean the same thing. Deep runs by default; `--fast` skips it. No worker, no
Temporal, no API key. It writes one canonical JSON result plus two
renderings derived from it — a markdown summary for a chat window and a self-contained HTML report
for a person — and reports no composite score, only per-category counts and a ranked fix list.

The HTML report is the one to send somebody. Open the `.html` file in a browser: headline tiles for
the rendered-experience numbers with the sample size beside each one, the per-category counts, the
ranked fix list with every finding's evidence behind a `<details>`, and every check further down. It
carries no script element at all and requests nothing from the network — not a font, not a
stylesheet, and nothing from the site it is a report about. Every value in it is site-chosen text, so
every value is HTML-escaped on the way in and any URL that is not `http(s)` is printed as text rather
than linked. `--html <path>` puts it somewhere specific, the way `--json` and `--out` do.

The two tiers have different budgets, and `--budget <seconds>` defaults to whichever one is running:
120 with `--fast`, 420 without. A deep run against this site takes about a minute.

Two properties it is built around, both of which matter more than the checks themselves. It
**verifies behaviour rather than presence**: a 200 from `/llms.txt` that is really the site's HTML
catch-all fails, and so does a page that answers `Accept: text/markdown` with a different page. And
it **refuses a target inside your own network**: every hostname is resolved and every address
classified before a socket opens, and again on each redirect hop, allowing only globally-routable
unicast addresses, with no flag to turn that off. One caveat, stated in `safe-fetch.ts` rather than
only here: the name is resolved again by Node when it connects, so a hostile resolver answering
differently the second time (DNS rebinding) is not covered, and closing that needs the connection
pinned to the vetted address. A second caveat arrives with the deep tier and is stated in `deep.ts`:
the page Chrome is sent to goes through the same address check first, but the subresources that page
then pulls in are requested by Chrome, which consulted nothing. Both gaps are recorded on the
`hosted-mcp-server` card as things to close before stage 2 hosts this. It also obeys the target's
robots.txt — including for the pages the deep tier renders — because an agent-readiness auditor that
ignores robots fails its own audit.

**One identity across three clients.** The fetcher, Lighthouse's Chrome and axe's all send
`AUDIT_USER_AGENT`, so an audit is one visitor in the target's access log and the one robots.txt
token refuses all of it. The User-Agent points at `/agents.md`, which explains the auditor and how to
refuse it. It must stay free of commas and semicolons: `@axe-core/cli` splits its `--chrome-options`
value on both.

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
