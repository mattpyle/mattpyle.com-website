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
  self-merges. `steward scorecard-schedule create` puts it on a daily Temporal Schedule at 03:30
  local. Since 2026-08-14 that is genuinely unattended: the Schedule lives in Temporal Cloud and the
  hosted worker advances it, so a firing produces a run with this laptop shut. Since 2026-08-15 it is
  also watched: the run signals a dead-man's-switch check on success, fails it explicitly on a bad
  result, and a run that never happens lets the check's own window lapse.
- **`auditSiteWorkflow`** — one agent-readiness audit of *any* site, run durably: the fetch-based
  checks, and on the deep tier one browser-rendered page per activity, then assembly. Started by the
  local MCP server (`steward mcp-serve`) and, since 2026-08-15, by the site's public `/mcp`
  endpoint's `deep_audit` tool; both hand back a workflow ID immediately and serve the report by
  polling. `steward audit-url` runs the same engine in-process with no worker and no Temporal.

### Task queues

Three, split by **locality** — which worker is allowed to do the work, not how heavy it is:

| Queue | Carries | Why it is where it is |
|---|---|---|
| `steward-light` | `reviewPost`'s passes | Reads the working copy and applies patches to local files |
| `steward-heavy` | `buildAndAuditDraft` | Same working copy, plus a browser |
| `steward-audit` | `auditSiteWorkflow` and `scorecardAuditWorkflow`, with all of their activities | Depends on nothing local: it reaches the site over HTTP and the repository over the GitHub API |

The scorecard moved onto `steward-audit` on 2026-08-14. It used to be split across the first two
queues because its publish leg drove git in a local worktree and its archive wrote a local file;
both now go through the GitHub API, so nothing it does needs a checkout. That is what made the
nightly Schedule able to leave this laptop.

There are two workers:

- **The laptop worker** (`steward up`, `src/worker.ts`) registers all three queues, so nothing about
  day-to-day use changes and a manual `steward scorecard` works whether or not the hosted worker is
  up.
- **The hosted worker** (`src/worker-hosted.ts`, the Railway container) registers `steward-audit`
  alone, and registers exactly the ten activities those two workflows name. It deliberately does not
  register `reviewPost`'s: a worker that claimed `snapshotDraft` would fail it, because the container
  has no drafts, and a failed task is worse than an unclaimed one.

The two never compete, because they claim different queues. A worker polling `steward-audit` needs
Chrome, a `GITHUB_TOKEN`, and no checkout.

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

steward up                   # starts the worker, and the dev server if that's the target
```

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

Use the **namespace** endpoint (`<namespace>.<account>.tmprl.cloud:7233`) rather than the regional
one. It is a CNAME that follows the active region, so enabling High Availability later moves a
failover under the connection with no config change.

`steward up` follows the same switch: against Cloud it starts the worker alone, since there is no
local server to run, and its ready banner names the service either way.

### The hosted worker

A Railway container runs `src/worker-hosted.ts` against the Cloud namespace, polling `steward-audit`
continuously. It is what makes the nightly Scorecard and any deep audit finish without this machine.

It takes five environment variables, all set in Railway's own Variables tab and none of them in the
image: the three connection variables above, a `GITHUB_TOKEN` (a fine-grained PAT scoped to this one
repository, contents and pull-requests write) that the scorecard's publish and archive legs need, and
`STEWARD_HEALTHCHECK_BASE`, the ping base of the dead-man's-switch service the run-health signals go
to.

The worker **refuses to start** without the token, rather than discovering it is missing at 03:30. It
only **warns** about a missing ping base, and the difference is deliberate: a missing token means the
nightly run throws its work away, a missing ping base means it works unwatched, and a monitoring
variable must never be able to take down the thing it watches. The ready line names which it is
(`alerting: configured` / `alerting: OFF`).

```bash
docker build -f agents/steward/Dockerfile -t steward-audit-worker .   # context is the REPO ROOT
railway up                                                            # from the repo root
railway logs                                                          # look for `steward worker polling`
```

To redeploy: push to the branch Railway watches, or `railway up` again. The worker stops polling on
SIGTERM, drains for 20 seconds, and exits; anything still in flight is retried by Temporal, and pages
already rendered are in workflow history rather than being re-run.

The restart policy is `ALWAYS` with no retry cap, which is a deliberate choice about *silent* death
rather than about crashes. `ON_FAILURE` does not restart a process that exited 0, and this worker's
`main()` returns normally once `worker.run()` resolves, so a clean exit would leave the container
stopped. A retry cap has the same shape: after N failures Railway stops trying and the service sits
dead. Either way the nightly Scorecard would stop producing runs, and a crash loop visible in the
Railway dashboard is the better failure. Since 2026-08-15 a stopped worker is also an email: the
nightly run's check goes unpinged and the alerting service reports the silence. The restart policy is
still the first line of defence, because recovering beats reporting.

The image is deliberately host-agnostic — nothing in the Dockerfile knows what Railway is, and
everything Railway-specific lives in `railway.json` — so the Serverless Workers migration can reuse
it unchanged.

One thing Cloud does not change: a workflow only advances while *some* worker polls its queue. For
`steward-audit` that is the container; for `reviewPost` it is still `steward up` on this machine.

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

Both tiers have a second consumer: the site's public `/mcp` endpoint (`src/pages/mcp.ts`).

The fast tier runs **inside** the Vercel function, answering an `audit_site` tool call
synchronously. It reaches it through `@mattpyle/steward/agent-audit/fast`. That entry's import graph
must never reach `@temporalio/*`, `chrome-launcher`, `lighthouse` or the axe CLI, which is why
`runAudit` takes the deep tier as an injected `loadDeep` thunk rather than importing it: a dynamic
import is lazy for Node and eager for every bundler. The site's
`tests/steward-fast-audit-packaging.test.mjs` walks the graph and fails if any of them appears.

The deep tier runs **on the hosted worker**, started from the function as `auditSiteWorkflow` on the
Cloud namespace (`deep_audit`) and polled back (`get_audit`). Since 2026-08-15 that is public and
unadvertised. The function reaches the names it needs — workflow type, task queue, query name, ID
scheme, budgets, state types — through a second exports entry,
`@mattpyle/steward/agent-audit/deep-contract`, which is required to have **no value imports at all**
so it adds nothing to the function bundle; `tests/steward-deep-contract-packaging.test.mjs` holds
that. Adding a third entry means making the root `CLAUDE.md` argument again.

The public deep tier is capped hard: 10 deep audits per UTC day across everyone, 2 per caller, both
env-configurable, both counted before the workflow is started, both failing closed. There is no
operator bypass — your own runs go through the CLI or a direct workflow start, and testing the
endpoint itself means deleting the day's counter keys from the Upstash console (see the user guide,
beside the take-down lever).

The HTML report is the one to send somebody. Open the `.html` file in a browser: headline tiles for
the rendered-experience numbers with the sample size beside each one, the per-category counts, the
ranked fix list with every finding's evidence behind a `<details>`, and every check further down. It
carries no script element at all and requests nothing from the network — not a font, not a
stylesheet, and nothing from the site it is a report about. Every value in it is site-chosen text, so
every value is HTML-escaped on the way in and any URL that is not `http(s)` is printed as text rather
than linked. `--html <path>` puts it somewhere specific, the way `--json` and `--out` do.

`npm run check:html-report -w @mattpyle/steward` is the accessibility claim's evidence: it renders a
fixture with every status, every severity and evidence of every shape, then runs `runAxe` over it.
A script rather than a test, because it launches a browser and the suite has neither a browser nor a
network in it. Pass a path to scan a real report instead.

```bash
steward mcp-serve                              # serve audit_site over MCP, backed by local Temporal
```

`mcp-serve` is the same audit behind an MCP server, so an agent that is not at this terminal can run
one. Unlike `audit-url` it runs the audit as a Temporal workflow, so a worker has to be up or nothing
executes. `audit_site(url, fast?)` returns a workflow ID immediately rather than the result, and
`get_audit(workflowId, view)` reads it back: `status` until `done` is true, then `report` for the
canonical JSON or `summary` for the markdown digest. That shape is not a preference. A deep audit is
minutes long, past what any MCP client will hold a call open for, and the handle is durable across a
worker restart.

The same three documents are also `steward://audit/<id>/{status,report,summary}` resources, and both
surfaces render through one function, so they cannot disagree. `get_audit` exists because the chat
clients — claude.ai, Claude desktop, Cowork — call tools but do not read resources: behind a resource
alone, the report is unreachable from the largest population of agents, and `audit_site` hands those
callers an ID they can do nothing with.

It listens on `127.0.0.1:8765` by default and has no authentication, so reaching it from elsewhere
means a tunnel, and a tunnel makes an unauthenticated audit runner reachable by anyone with the URL.
Attended runs only, and take the tunnel down afterwards.

The listener answers only requests whose `Host` header names a loopback address — `localhost`,
`127.0.0.1` or `[::1]`, on any port — and refuses everything else with a 403 before routing, the
health probe included. That is the DNS-rebinding defence: a page in your own browser can POST to the
loopback port without CORS having a say, but it cannot forge the Host header, and a name an attacker
resolves to 127.0.0.1 is not one of the three. A tunnel forwards the public request's Host, so a
tunnelled session has to name that hostname: `--allow-host <hostname>`, repeatable, or
`STEWARD_MCP_ALLOWED_HOSTS` as a comma-separated list. Nothing beyond loopback is ever a default.

The two tiers have different budgets, and `--budget <seconds>` defaults to whichever one is running:
120 with `--fast`, 420 without. A deep run against this site takes about a minute.

Two properties it is built around, both of which matter more than the checks themselves. It
**verifies behaviour rather than presence**: a 200 from `/llms.txt` that is really the site's HTML
catch-all fails, and so does a page that answers `Accept: text/markdown` with a different page. And
it **refuses a target inside your own network**: every hostname is resolved and every address
classified before a socket opens, and again on each redirect hop, allowing only globally-routable
unicast addresses, with no flag to turn that off.

The guard binds in three places, and each one exists because the previous one had a way around it:

| Where | What it covers |
|---|---|
| `safe-fetch.ts` | Every fetch the fast tier makes, and every redirect hop, followed by hand. The connection is **pinned** to the address that was classified, on a per-hop undici dispatcher whose `connect.lookup` consults no resolver, so a resolver answering differently between the check and the connect (DNS rebinding) has nothing to answer. |
| `deep.ts` | The sampled page, vetted before Chrome is launched, so a refusal costs no browser. |
| `vetting-proxy.ts` | Every HTTP-shaped request Chrome makes for itself. Chrome runs behind a local forward proxy (`--proxy-server`, with the loopback bypass removed) that classifies and pins each one: subresources, `fetch()` calls, and the target of any redirect a sampled page answers with. Refusals come back to the page as a 403 and to the reader as a note on the run. WebRTC is the exception a proxy cannot cover, so the launch flags also carry `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, which confines a peer connection to transports the proxy carries. |

The proxy does not re-check robots.txt for a redirect target; robots governs which pages the deep
tier chooses to sample, and it is not what stands between a URL and your network. Running Chrome in a
network namespace with no route to anything private is the other way to do this and is Linux-only, so
it does not fit the Windows desktop the worker runs on. The proxy's measured cost to a Lighthouse run
is nothing: three interleaved runs on `https://www.mattpyle.com/` and three on
`https://developer.mozilla.org/en-US/` moved no category score and no wall-clock median.

It also obeys the target's robots.txt — including for the pages the deep tier renders — because an
agent-readiness auditor that ignores robots fails its own audit.

**One identity across three clients.** The fetcher, Lighthouse's Chrome and axe's all send
`AUDIT_USER_AGENT`, `steward-audit/0.2.0 (+https://www.mattpyle.com/steward)`, so an audit is one
visitor in the target's access log and the one robots.txt token, `steward-audit`, refuses all of it.
The token is the User-Agent's first product token and a test holds the two together, because a
robots.txt rule naming a token the auditor does not send is a refusal that silently does nothing.
The URL points at `/steward`, which explains the auditor, what one audit costs a site, and how to
refuse it. The string must stay free of commas and semicolons: `@axe-core/cli` splits its
`--chrome-options` value on both.

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
