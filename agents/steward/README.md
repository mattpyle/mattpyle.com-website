# The Steward — Phase 1a

An editorial agent for mattpyle.com, implemented as Temporal workflows. It reviews a
`draft: true` writing post with mechanical checks, synthesizes a report, then **waits
durably** for a human `approve` or `reject`.

It is a sidecar. The site builds, deploys, and serves identically with this entire
directory deleted. Nothing in the site's runtime, build, or Vercel deployment depends on it.

**Phase 1a scope:** `snapshotDraft`, `runCspell`, `checkFrontmatter`, `synthesizeReport`
(template summary, no LLM), `archiveReport`, the durable wait, and the `review` / `status` /
`approve` / `reject` CLI. Vale, the LLM editorial passes, the build-and-audit pass, patch
application, and the publish leg are later phases, gated off in `src/config.ts`.

---

## Prerequisites

1. **Temporal CLI** on PATH. Verify: `temporal --version` (built against server 1.29.1).
2. **Node 22+** (the site requires ≥22.12.0; built and tested here on Node 24.12.0).
3. `npm install` from the **repo root** — this is an npm workspace, not a standalone package.
4. `.env` is **not required for Phase 1a.** No activity makes a network or LLM call yet, and
   the defaults in `src/config.ts` are correct for this machine. Copy `.env.example` to
   `.env` when Phase 1b lands.

Not needed yet: Chrome, the Vale binary, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`.

---

## Runbook (three terminals)

```
# 1 — Temporal server
temporal server start-dev --db-filename agents/steward/.temporal/steward.db

# 2 — worker
cd agents/steward && npm run worker        # tsx src/worker.ts

# 3 — reviews
cd agents/steward
npm run steward -- review steward-smoke-test
npm run steward -- status steward-smoke-test
npm run steward -- approve steward-smoke-test
```

Run the server command **from the repo root** — `--db-filename` is relative to the working
directory, and the whole point of the flag is that history survives reboots. The dev server's
default is in-memory.

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

| Command | Behavior |
|---|---|
| `review <slug> [--skip-build-audit]` | Gate-mode review of a **writing draft**, poll until the fan-out finishes, render the report. Refuses if a review of that slug is currently **running**, or if the post is not `draft: true`. |
| `audit <collection> <slug> [--skip-build-audit]` | **Audit-mode** review of already-published content in `writing` or `changelog`. Same fan-out, same report, archived the same way — then completes. No verdict, no publish leg, and `apply` is refused. |
| `status <slug>` | Render current state, verdict, findings, patches, report path, Web UI deep link. |
| `approve <slug> [--force]` | Send `approve`. Refused if the report has blocking findings (use `--force`) or if the file changed since review. |
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

### Archives

`reviews/<collection>/<slug>/<hash12>.json`, plus `latest.json`. The collection segment was added
2026-07-19 — the slug alone is not unique across collections. Pre-existing archives were migrated
into `reviews/writing/` in the same commit.

`apply` and `rereview` are Phase 1b. The `rereview` **signal** exists and works; it has no CLI
command yet (`temporal workflow signal --name rereview` will drive it).

## Authoring notes: spelling

The Steward's dictionary is `agents/steward/cspell.config.yaml`, deliberately
separate from the site's own `cspell.json`. Its language is **en-GB** as of
2026-07-19 — but see spec §8.2 before drawing conclusions from a green run:
en-GB stops penalising British inflections, it does **not** reject US spellings.

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

**Use `npx tsx src/cli.ts <args>` from `agents/steward`, not `npm run steward -- …`.**
The npm lifecycle wrapper swallows the CLI's own error output behind its script noise,
so a real stack trace reads as a silent failure. The npm form is fine when it works;
the `npx` form is the one to reach for the moment it doesn't.

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

4. **cspell runs in-process via `cspell-lib`, not the CLI (spec §8.2).** No process spawn to
   make Windows-safe, and the issue objects carry the suggestion metadata (`isPreferred`,
   ranked alternatives) that the JSON reporter flattens away — which is what the
   unambiguous-suggestion rule needs.

5. **"Unambiguous suggestion" is defined by edit distance (spec §8.2).** The spec says patch
   when cspell offers "a single unambiguous suggestion" without defining it. cspell's own
   `isPreferred` flag is too narrow: `refacrtor` gets no preferred suggestion even though
   `refactor` is distance 1 and the runner-up is distance 2. Rule implemented: a preferred
   suggestion always wins; otherwise patch only when exactly one suggestion sits at the
   minimum edit distance and that distance is ≤ 2. Everything else flags without a patch.

6. **Phase 1a dependencies only.** `@anthropic-ai/sdk`, `execa`, `octokit`, `lighthouse`,
   `chrome-launcher`, and `@axe-core/cli` are listed in spec §4 but are not installed. Nothing
   in Phase 1a spawns a process, calls an LLM, or touches GitHub. They land with the phases
   that use them, rather than sitting in the lockfile unused. `src/lib/proc.ts` (the execa
   wrapper) likewise arrives with the first activity that spawns anything.

7. **`checkFrontmatter`'s "missing description → block" check cannot fire in practice
   (spec §8.4).** `src/content.config.ts` already makes `description` required, so a post
   without one fails `astro build` — and, as it turns out, fails to load in the content
   collection at all. The check is implemented and unit-tested against a fixture, but no post
   that reaches the Steward can trigger it. See the build log; this is a finding about the
   spec's model of where validation lives, not a bug.

8. **Task-queue routing exists but the heavy queue has no work yet.** The worker registers
   both queues and the workflow declares `HEAVY_ACTIVITY_OPTIONS`, but every Phase 1a activity
   routes to `steward-light`. The split is wired so Phase 1c is a config change, per spec §3.

9. **No `applyPatches` implementation.** The signal is defined and handled; it responds with an
   explicit "not implemented until Phase 1b" message rather than silently ignoring the signal.
   Patches *are* proposed and rendered — they are just applied by hand for now.
