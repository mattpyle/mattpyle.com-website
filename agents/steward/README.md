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
| `review <slug> [--skip-build-audit]` | Start `reviewPost`, poll until the fan-out finishes, render the report. Refuses if a review of that slug is currently **running**. |
| `status <slug>` | Render current state, verdict, findings, patches, report path, Web UI deep link. |
| `approve <slug> [--force]` | Send `approve`. Refused if the report has blocking findings (use `--force`) or if the file changed since review. |
| `reject <slug> --reason "<text>"` | Send `reject`. Reason required. Re-archives and completes. |

`apply` and `rereview` are Phase 1b. The `rereview` **signal** exists and works; it has no CLI
command yet (`temporal workflow signal --name rereview` will drive it).

## Operational rules

Four rules that are easy to skip and expensive to skip.

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
