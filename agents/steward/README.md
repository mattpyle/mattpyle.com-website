# The Steward — Phase 2

An editorial agent for mattpyle.com, implemented as Temporal workflows. It reviews content with
mechanical checks, prose linting, and LLM editorial passes; builds and audits the unpublished page
with axe and Lighthouse; synthesizes a report; **waits durably** for a human `approve` or `reject`;
and then opens a publish PR and verifies the result against the live origin.

It is a sidecar. The site builds, deploys, and serves identically with this entire
directory deleted. Nothing in the site's runtime, build, or Vercel deployment depends on it.

**Built:** `snapshotDraft`, `runCspell`, `runVale`, `checkFrontmatter`, `editorialPass`
(claims-structure), `buildAndAuditDraft`, `synthesizeReport`, `archiveReport`,
`applyPatchesActivity`, the durable wait, gate and audit modes across `writing` and `changelog`,
`publishPost` and `verifyDeploy` (Phase 2), and — as of 2026-07-21 — a human-readable report
renderer (`steward report <slug>`, and the same render on `review`'s completion).

**Not built:** the `ai-tells` editorial pass, still gated off behind `ENABLE_AI_TELLS` in
`src/config.ts` pending its validation study.

**Two things the Steward will never do**, both deliberate and both enforced in code rather than in
a prompt: it does not rewrite prose on the author's behalf (design rule 1), and **it does not merge
its own PR** (§8.7). Merging is what triggers the production deploy, and it stays a human act.

---

## Prerequisites

1. **Temporal CLI** on PATH. Verify: `temporal --version` (built against server 1.29.1).
2. **Node 22+** (the site requires ≥22.12.0; built and tested here on Node 24.12.0).
3. `npm install` from the **repo root** — this is an npm workspace, not a standalone package.
4. `.env` with `ANTHROPIC_API_KEY` (the editorial passes) and — **as of Phase 2** —
   `GITHUB_TOKEN` (the publish leg).
5. **Chrome** and the **Vale binary** (`npm run setup:vale`) for the build audit and prose lint.
6. **Optional: `steward` as a one-word command.** `cd agents/steward && npm link` once (a fresh
   clone needs this once; reversible with `npm unlink -g steward`). After that, `steward <verb>`
   runs from any directory — see "The CLI form" below.

### `GITHUB_TOKEN` — required for the publish leg, and `gh auth token` will not do

The publish leg opens a PR from **inside the worker**, which reads `process.env.GITHUB_TOKEN`.
A `gh` CLI login does **not** satisfy this: `gh` keeps its token in the OS keyring, where the
worker cannot see it. The Phase 2 dry-run was run by exporting `GITHUB_TOKEN="$(gh auth token)"`
into a one-off shell, which is fine for a supervised dry-run and **not** fine for the real thing —
the whole point of the publish leg is that it runs unattended after an approve that may have been
sent hours earlier.

Create a fine-grained PAT scoped to this repository only, with **contents: read/write** and
**pull requests: read/write**, and put it in `agents/steward/.env`:

```
GITHUB_TOKEN=github_pat_...
```

`config.ts` loads `.env` and already-set environment variables always win, so a CI secret or an
explicit inline value is never silently overridden by a stale local file.

---

## Runbook

### The CLI form: `steward <verb>`, from anywhere

After a one-time `npm link` (see Prerequisites #6), `steward` is a real command on PATH — it does
not need `cd agents/steward` first, or `--` to pass through npm's argument parsing:

```
steward up
steward review steward-smoke-test
steward status steward-smoke-test
steward approve steward-smoke-test
```

`package.json`'s `bin` field points at `scripts/steward.mjs`, a thin shim that resolves the
package root from **its own file location** (`import.meta.url`), never `process.cwd()` — that's
what makes `steward inbox` from the repo root, or any other directory, resolve the same
`agents/steward/.cache/temporal-dev.db` and the same repo-root `cspell.shared.yaml` that running
from inside `agents/steward` does. It spawns tsx's own JS entrypoint directly (the same
`.cmd`-avoiding pattern `src/lib/proc.ts`'s `tsxCommand` uses for the worker) rather than
`tsx.cmd`, which is a Windows EINVAL trap.

**Fallbacks, in case `steward` isn't linked or isn't found:**

```
cd agents/steward
npm run steward -- up            # npm-wrapped form
npx tsx src/cli.ts up            # direct form — see "Debugging notes" for why this one matters
```

**`steward up`** replaces the three-terminal dance for the common case: one foreground terminal
starts the Temporal dev server and the worker together, refuses to run if a stray server/worker
from an earlier session is already bound to the queue or the port, and does not print "ready" until
the server answers and the worker has actually registered on both queues. Ctrl+C tears down both
process trees.

If `up`'s terminal is gone or the stack needs a hard reset, `steward down` force-cleans any stray
worker/server process it can find and frees 7233/8233 — the same signature `up`'s preflight check
refuses to start on top of.

### The original three terminals — still works, and `up` doesn't replace it for every case

```
# 1 — Temporal server
temporal server start-dev --db-filename agents/steward/.cache/temporal-dev.db

# 2 — worker
cd agents/steward && npm run worker        # tsx src/worker.ts

# 3 — reviews
cd agents/steward
npm run steward -- review steward-smoke-test
```

Useful when you want the server and worker logs in separate windows, or want to restart the worker
alone without bouncing the server (and its history). Run the server command **from the repo root**
if you start it this way — `--db-filename` is relative to the working directory, and the whole
point of the flag is that history survives reboots. The dev server's default is in-memory. `steward
up` resolves the same path **absolutely** from `REPO_ROOT` regardless of current directory, so this
particular footgun does not apply there.

> **There is exactly one database, and it is `agents/steward/.cache/temporal-dev.db`.**
> This runbook previously named `agents/steward/.temporal/steward.db`, and the two diverged:
> sessions from Phase 3b onward ran against `.cache/`, while the documentation kept pointing at
> `.temporal/`. The observed failure mode is the worst kind — **a long-parked review appears to
> have vanished**, because `temporal workflow list` against the documented database is a
> perfectly successful command that returns a truthful answer about the wrong file.
>
> Reconciled 2026-07-19: `.cache/temporal-dev.db` **wins**, because it is the one holding the
> parked `hello-world` review. `.temporal/steward.db` was inspected on a throwaway server and
> contained only three *terminal* `phase1b-live-fixture` runs — the Phase 1b replay-fixture
> export source, already committed as a fixture. Nothing live was in it. **It has deliberately
> not been deleted**; that is Matt's call to make, not a cleanup to perform silently.
>
> `--db-filename` pointing at a non-existent file is not an error — the dev server creates an
> empty database and starts happily. A typo in this path can never fail loudly.

Web UI: <http://localhost:8233>.

### Troubleshooting

- **Workflows hang as "scheduled".** The worker is not polling the right queue or namespace.
  Check `QUEUE_LIGHT` / `QUEUE_HEAVY` / `NAMESPACE` in `src/config.ts` against the server.
- **`status` fails with no worker running.** Expected, and worth understanding: Temporal
  queries are executed *by the worker*, not by the server. With the worker down, the workflow
  is alive and signalable but not queryable. Use `temporal workflow describe --workflow-id
  steward-review-<slug>` for server-side truth in that situation.
- **`review` says a review is already open.** One is genuinely running. `status` it, or
  terminate it: `temporal workflow terminate --workflow-id steward-review-<slug> --reason ...`.

---

## Commands

Run as `steward <command>` (after `npm link`, from any directory — see the Runbook), or
`npm run steward -- <command>` / `npx tsx src/cli.ts <command>` from `agents/steward` as fallbacks.

| Command | Behavior |
|---|---|
| `up` | Starts the Temporal dev server + worker together in one foreground terminal, health-gated (see Runbook). Ctrl+C tears both down. |
| `down` | Force-cleans any stray worker/server matching the operational-rule-0 signature and frees 7233/8233. |
| `inbox [--all]` | One row per **open** (RUNNING) review across every slug and collection — what's waiting on you, sorted to the top, with counts. `--all` adds a second section listing up to 20 recently-closed reviews. Degrades to server-side `describe()` status (no verdict, no hint) per review if the worker is down. |
| `review <slug> [--skip-build-audit]` | Gate-mode review of a **writing draft**, poll until the fan-out finishes, render the report. Refuses if a review of that slug is currently **running**, or if the post is not `draft: true`. |
| `audit <collection> <slug> [--skip-build-audit]` | **Audit-mode** review of already-published content in `writing` or `changelog`. Same fan-out, same report, archived the same way — then completes. No verdict, no publish leg, and `apply` is refused. |
| `status <slug>` | Render current state, verdict, findings, patches, report path, Web UI deep link. |
| `report <slug> [--collection <name>]` | Pretty-print the **latest archived report** for a slug, straight off disk — no live workflow needed. Same renderer `review`'s completion tail uses (`lib/render-report.ts`). `--collection` defaults to `writing`. |
| `approve <slug> [--force]` | Send `approve`. Refused if the report has blocking findings (use `--force`) or if the file changed since review. With the publish leg on, this opens the PR and then verifies against production. **Send it a second time after you merge** — see below. |
| `reject <slug> --reason "<text>"` | Send `reject`. Reason required. Re-archives and completes. |

### Gate vs audit

Two modes, and the difference is what the review is *for*:

| | `review` (gate) | `audit` |
|---|---|---|
| Target | unpublished `draft: true` | already-published content |
| Collections | `writing` | `writing`, `changelog` |
| Ends at | `awaiting_verdict`, parked on a human signal | `audited`, completed |
| `approve` / `reject` | yes | n/a — nothing to decide |
| `apply` | yes | **refused** |
| Patches in report | yes | yes, as suggestions only |

**Audit findings are advisory.** Patches still appear in the report, because knowing the exact
edit is useful — but the Steward will not write them. Editing published content goes through the
normal git flow, with the report as input.

**Mode and collection live in the workflow input, never in config.** Both change the workflow's
command sequence, so they must be recorded in history; a config flip would otherwise send every
parked review down a branch it never took. See the build log's "Changelog parity" entry.

### The publish leg — what `approve` actually does

`approve` starts a sequence that **pauses for you in the middle**, and knowing that in advance is
the difference between "it's stuck" and "it's waiting".

```
approve  →  publishing        publishPost: branch, commit, push, open PR
         →  verifying_deploy  the curl matrix against www.mattpyle.com, every 90s
         →  publishing        ← PARKED HERE if you haven't merged yet
              ... you merge the PR ...
         →  approve again     idempotent resume: re-verifies, never re-publishes
         →  published
```

**The Steward opens the PR; you merge it.** Merging triggers the Vercel production deploy, and
that stays a human act. Until you merge, verification fails for a perfectly good reason — so after
ten attempts (~15 minutes) the workflow parks back in `publishing` with a message naming the PR,
rather than failing. It stays RUNNING and signalable indefinitely.

`steward inbox` surfaces this parked state itself — the row literally says "merge PR #N,
then re-approve" (or "PR CI is failing — fix it, then approve again") rather than requiring you to
remember which slug is waiting and why.

**After merging, send `approve` again.** This is an *idempotent resume*: it re-enters verification
and does not re-run `publishPost`. It also ignores its own publish flag — a resume cannot
un-publish something, and re-deciding at resume time is exactly the bug design rule 10 prevents.

**What ends up in the PR:** exactly one file — the post, with `draft: false` — branched from
`origin/master`. The body carries the report summary, per-pass finding counts, the content hash the
review was pinned to, and the archived report's path. If the branch already has an open PR, its
body is updated rather than a second PR opened.

**The date rule:** `draft: false` always; `date:` is refreshed to today only if it is absent or more
than 30 days stale (a recent date may have been set deliberately); `updated:` is never touched on
first publish, because the post has not been updated, it has been published.

### Archives

`reviews/<collection>/<slug>/<hash12>.json`, plus `latest.json`. The collection segment was added
2026-07-19 — the slug alone is not unique across collections. Pre-existing archives were migrated
into `reviews/writing/` in the same commit.

`apply` and `rereview` are Phase 1b. The `rereview` **signal** exists and works; it has no CLI
command yet (`temporal workflow signal --name rereview` will drive it).

## Authoring notes: spelling

The dictionary is `cspell.shared.yaml` **at the repo root**, and it is shared
with the site's own `npm run spellcheck` (which reaches it via `import` in
`cspell.json`). It moved there in Phase 2 Part A and is no longer the Steward's
alone: the two configs had drifted, and once the Steward could open publish PRs
that drift meant it could approve a post the site's CI then marked red.

Consequences worth knowing:

- **A `dict-add` now teaches both.** That is the point, not a side effect.
- **The Steward reads the file directly, not via `import:`.** cspell's
  `readConfigFile` does not resolve `import`, so the words must stay inline.
  A wordlist moved behind an import loads as empty — the loader refuses to run
  rather than emitting `block` findings against correct prose, but the cause is
  not obvious from the message unless you know this.
- Its language is **en-GB** as of 2026-07-19 — but see spec §8.2 before drawing
  conclusions from a green run: en-GB stops penalising British inflections, it
  does **not** reject US spellings.

There are three ways to resolve a spelling flag, and they are not
interchangeable.

**1. Fix the typo.** The default. If cspell offers one unambiguous suggestion it
also proposes a patch, which `steward apply` can write.

**2. `steward dict-add <word>` — for a name the site will use again.**

```bash
npm run steward -- dict-add Kimi
```

Appends to the project dictionary, sorted and deduplicated within a machine-added
section (the curated groups above it are hand-maintained, because several entries
carry attribution comments that a global re-sort would orphan). Use it for
products, models, people, companies — things that will recur. Unknown-word
findings now arrive with a **proposed disposition** — "likely proper noun (suggest
`steward dict-add X`)" or "likely typo" — from the editorial pass where it ran, or
a deterministic capitalisation rule where it did not. **The proposal is advice; a
human still types the verb.**

**3. `<!-- cspell:ignore -->` — for a one-off intentional string.**

For a token that is correct *here* and should stay flagged everywhere else. The
worked example is real and currently in the tree, at `hello-world:25`:

```markdown
<!-- cspell:ignore matthewpyle -->
*side note: Before this domain, I owned `matthewpyle.com` but the only people who
call me Matthew are the government and my mum when I've done something wrong.*
```

`matthewpyle` is a domain Matt used to own. It is not a typo and it is not
site vocabulary — it appears once, in a sentence about no longer owning it.
Adding it to the dictionary would suppress the flag site-wide forever, so that a
genuine future mistyping of `mattpyle` would sail through. An inline ignore is
scoped to the file and visible to the next reader.

> **That line is deliberately still flagged.** The comment above is documentation,
> not an instruction that has been carried out — `hello-world` is Matt's unfinished
> draft, and under the clean-room rule the Steward does not edit his prose. The
> flag standing until he decides is the system working, not a defect.

## Operational rules

Five rules that are easy to skip and expensive to skip.

**0. Before running anything, check for orphaned workers.**

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*worker.ts*' }
```

A worker left over from an earlier session keeps polling `steward-light` and will
claim tasks for activities it does not have, failing with
`Activity function <name> is not registered on this Worker`. That error reads
exactly like a code bug and is not one — in Phase 1b it appeared while a *newer*
worker had just run the whole fan-out successfully, because the two were competing
for the same queue. `tsx` spawns a child process, so expect two or three PIDs per
worker, not one.

`steward up` runs exactly this check before starting anything, and refuses (naming
the offending PIDs and the `taskkill` command) rather than starting a second stack
on top of a live one. `steward down` runs the same detection and kills what it
finds.

**1. Before changing workflow code, clear the open reviews.**

```
temporal workflow list
```

A review parks on a human signal and can sit there for weeks — that is the
feature, not a bug. But a parked workflow resumes by *replaying its history against
whatever the workflow code says now*. Change `reviewPost` while a review is parked
and that review can fail to replay with a non-determinism error: it cannot be
resumed, and a verdict the human already sent is stranded. Complete, reject, or
terminate open reviews first. At this stage they are only smoke-test artifacts, so
terminating is fine; once real drafts are in flight, it will not be.

**2. The replay regression test is the tripwire for rule 1.**

`tests/workflows/replay.test.ts` replays a committed real history
(`tests/fixtures/histories/phase1b-smoke-test.json` — a 113-event Phase 1b run
covering fan-out → apply → rereview → approve) against current workflow code. It
runs in CI and with `npm test`.

**Expect this to break in any phase that adds an activity to the fan-out.** Phase 1b
added `runVale` and `editorialPass`, which changed the command sequence and retired
the Phase 1a fixture. That is a versioning fact, not a regression.

If it goes red after a workflow change, that is not a broken test. It is the change
telling you it would have stranded every parked review. Either make the change
replay-safe (see the skill's versioning reference: `patched()` / worker versioning)
or accept the break deliberately — and if you re-export a fresh history as the
fixture, record *why* in the build log rather than swapping it silently.

Verified to actually fail: injecting a `wf.sleep()` before the first activity
produces `TMPRL1100 Nondeterminism error: Timer machine does not handle this event`.

**3. `archiveReport` writes; it does not commit.**

Reviews land in `agents/steward/reviews/` as ordinary untracked files, and the human
commits them with their normal flow. This is a deliberate decision, not an oversight:
committing to the human's working branch from inside an activity — while they may be
mid-edit in the same checkout — buys nothing and can surprise. It will be revisited
when the publish leg lands, which is the point where the Steward touches git anyway.
The trade-off to know about: an uncommitted archive is one `git clean` away from
gone.

**4. Re-decide `write-good.E-Prime` after three real reviews.**

At the Phase 1b tuning checkpoint, `write-good.E-Prime` fired **106 times across 12
files (8.8/file)** — far over the ">~5 hits per post" threshold that the spec offers
as a disable prompt — and Matt kept it anyway, deliberately. The call was made on
*published* files, several of which are changelog entries rather than prose posts.

**Present the re-decision normalised per 100 words, over writing posts only**
(amended 2026-07-19). Two reasons, and the second is a caveat on the baseline
itself:

- **Per-file counts are not comparable.** One changelog entry produced 10 Vale
  alerts; `hello-world` produced 90. That ~9× gap is length and genre, not
  quality. `steward stats` reports `/100w` for exactly this reason.
- **The 8.8 hits/file baseline is contaminated, and must not anchor the
  re-decision.** It came from 12 files of which **10 were changelog entries**, so
  it largely measures the house format of release notes — not Matt's prose. Cite
  it as history, not as a threshold. The honest comparison is the per-100-word
  density across the three *qualifying* reviews, against each other.

**Trigger:** once three qualifying reviews have run, present the E-Prime hit counts
across those three and ask Matt to re-decide keep/disable. Do not make this call
unilaterally in either direction — the Phase 1b checkpoint exists precisely because
the assistant's instinct (disable E-Prime) was wrong and Matt's was right.

**A review counts only if all three hold** (tightened 2026-07-19, when collections and
audit mode made the original wording ambiguous):

1. **`collection: writing`.** The decision being re-made is about *prose posts*.
   Changelog entries are terse, structured, and release-note shaped; their E-Prime
   density says nothing about whether the rule earns its place in an essay. The
   Phase 1b tuning table was itself distorted this way — 10 of its 12 files were
   changelog entries.
2. **`mode: gate`.** An audit is a retrospective pass over content that already
   shipped. The question here is whether E-Prime helps Matt *while drafting*, which
   only a gate review answers.
3. **Not a fixture.** `steward-smoke-test`, `phase1b-live-fixture`, and anything else
   under `tests/fixtures/` are planted defects, not writing.

**Count: 1 of 3.** (`hello-world`, Phase 1c part 2. The changelog audit run in the
collections session does **not** increment it — it fails both 1 and 2.)

To count qualifying reviews:

```bash
npm run steward -- stats
```

```
  slug                        collection  mode   E-Prime  words  /100w  qualifies
  hello-world                 writing     gate        59   1121   5.26  yes
  phase1b-live-fixture        writing     gate        12      0      —  no
  steward-smoke-test          writing     gate         5     29  17.24  no
  webmcp-tools                changelog   audit        7    199   3.52  no

  Qualifying reviews (writing · gate · not a fixture): 1 of 3
```

**This replaced a documented PowerShell one-liner, which was wrong in two ways at
once** (2026-07-19) — and both were found by *running* it, not by reading it. It
pointed at the pre-migration archive layout, and it filtered on `mode -eq 'gate'`,
which returned **nothing**, because reports written before audit mode existed have
no `mode` key in their raw JSON at all. Only Zod parsing supplies the default. A
shell filter has to reimplement that default by hand or silently return an empty
set, and a documented command that quietly returns nothing is exactly as bad as
one that returns a wrong number. `steward stats` parses through the real
`ReviewReport` schema, so the schema stays the only place that defines what a
missing `mode` means.

---

## Debugging notes

Hard-won, all of them from real lost time.

**Use `npx tsx src/cli.ts <args>` from `agents/steward` (not `npm run steward -- …` or the
`steward` shim) when you need to see a real error.** The npm lifecycle wrapper — and the
`steward` shim, which spawns tsx the same way `npm run` does — both swallow the CLI's own error
output behind script/process noise, so a real stack trace can read as a silent failure. Either
form is fine when it works; the direct `npx tsx` form is the one to reach for the moment it
doesn't.

**Redirect `node --test` output to a file before grepping it.**

```
npm test > /tmp/test.txt 2>&1; grep -E "^. (tests|pass|fail)" /tmp/test.txt
```

Piping `node --test` straight through `grep` on this setup buffers hard enough that a
10-minute run produced a zero-byte file — indistinguishable from a hang, and it cost a
wasted 400-second timeout in Phase 1a.

**Before believing "activity not registered", count the workers.** See rule 0. This
error has never once been a code bug in this project; it has twice been a stale worker.

---

## Tests

```
npm test --workspace=@mattpyle/steward     # no network
```

Activity tests are plain function calls against the fixtures in `tests/fixtures/posts/`.
Workflow tests use `@temporalio/testing`'s time-skipping environment with every activity
mocked — they assert orchestration (state sequence, block refusal, stale refusal), never what
the real checks find. Nothing reaches the network.

---

## Deviations from spec

Each entry: what, why, spec section. The spec has been amended in place; this is the
per-change record.

1. **`workflow.now()` does not exist (spec §7.4).** The spec instructs the workflow to use
   `workflow.now()` for in-workflow timestamps. That API is not in the TypeScript SDK —
   calling it fails the workflow task with `wf.now is not a function`, which is exactly how it
   was discovered. The TS SDK instead *patches* `Date` inside the workflow sandbox, so
   `new Date()` is already deterministic and replay-safe there. Wrapped in a `workflowNow()`
   helper so the reasoning is stated once rather than implied.

2. **New `ReviewState` value: `approved` (spec §6.1).** Phase 1a's `approve` records the
   decision and completes without publishing. The spec's enum offers only `published` as a
   terminal success state, which would have made every Phase 1a report claim a publish that
   never happened. Added `approved` rather than lie in the data.

3. **`archiveReport` does not git-commit (spec §8.9).** The spec has the activity run
   `git add` + `git commit` on the human's working branch. It writes the files and stops.
   Committing from inside an activity would interleave Steward commits with whatever the human
   is doing in the same checkout — including mid-rebase or with staged unrelated changes — for
   no benefit in Phase 1a, when the human is watching the terminal anyway. Revisit when the
   publish leg lands and commits become the point.

4. **`octokit` was not adopted (spec §4, §8.7).** The publish leg makes three GitHub REST calls
   with a bearer token, and `fetch` does that natively. Same reasoning that retired `execa` in
   Phase 1b: a dependency earns its place by providing a guarantee the platform does not already
   give. Error classification is explicit instead — 401/403/404/422 are
   `ApplicationFailure.nonRetryable`, everything else retries.

5. **`publishPost` commits from the worktree, not the primary checkout (spec §8.7 steps 1–5).**
   The spec's wording implies the primary checkout, since that is where the uncommitted draft
   lives. The first implementation did exactly that and it was wrong: `git checkout -B` in the
   primary checkout switches the branch **under the human**, who may be mid-edit, and the publish
   leg runs unattended. The draft's bytes are copied into the worktree instead — the same overlay
   `syncWorktree` performs for the build audit. Caught before it ever ran.

6. **`approve` gained a second argument rather than the publish gate living in config or input
   (spec §7.2, design rule 10).** See the spec's design rule 10 for the full reasoning; briefly,
   config would have broken the Phase 1b replay fixture and an input field would have made the
   live parked review unpublishable without restarting it.

7. **cspell runs in-process via `cspell-lib`, not the CLI (spec §8.2).** No process spawn to
   make Windows-safe, and the issue objects carry the suggestion metadata (`isPreferred`,
   ranked alternatives) that the JSON reporter flattens away — which is what the
   unambiguous-suggestion rule needs.

8. **"Unambiguous suggestion" is defined by edit distance (spec §8.2).** The spec says patch
   when cspell offers "a single unambiguous suggestion" without defining it. cspell's own
   `isPreferred` flag is too narrow: `refacrtor` gets no preferred suggestion even though
   `refactor` is distance 1 and the runner-up is distance 2. Rule implemented: a preferred
   suggestion always wins; otherwise patch only when exactly one suggestion sits at the
   minimum edit distance and that distance is ≤ 2. Everything else flags without a patch.

9. **Phase 1a dependencies only.** `@anthropic-ai/sdk`, `execa`, `octokit`, `lighthouse`,
   `chrome-launcher`, and `@axe-core/cli` are listed in spec §4 but are not installed. Nothing
   in Phase 1a spawns a process, calls an LLM, or touches GitHub. They land with the phases
   that use them, rather than sitting in the lockfile unused. `src/lib/proc.ts` (the execa
   wrapper) likewise arrives with the first activity that spawns anything.

10. **`checkFrontmatter`'s "missing description → block" check cannot fire in practice
   (spec §8.4).** `src/content.config.ts` already makes `description` required, so a post
   without one fails `astro build` — and, as it turns out, fails to load in the content
   collection at all. The check is implemented and unit-tested against a fixture, but no post
   that reaches the Steward can trigger it. See the build log; this is a finding about the
   spec's model of where validation lives, not a bug.

11. **Task-queue routing exists but the heavy queue has no work yet.** The worker registers
   both queues and the workflow declares `HEAVY_ACTIVITY_OPTIONS`, but every Phase 1a activity
   routes to `steward-light`. The split is wired so Phase 1c is a config change, per spec §3.

12. **No `applyPatches` implementation.** The signal is defined and handled; it responds with an
   explicit "not implemented until Phase 1b" message rather than silently ignoring the signal.
   Patches *are* proposed and rendered — they are just applied by hand for now.
