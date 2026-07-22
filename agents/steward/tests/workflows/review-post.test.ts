import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { DraftSnapshot, PassResult, ReviewReport } from '../../src/lib/report.js';
import {
  reviewPost,
  approve,
  reject,
  rereview,
  applyPatches,
  getReviewState,
} from '../../src/workflows/review-post.js';

/**
 * Workflow-level tests (spec §11). Every activity is mocked, so these assert the
 * orchestration — state sequence, the block refusal, the stale refusal — and
 * nothing about what the real checks find. No network: the time-skipping test
 * server ships with @temporalio/testing.
 */

const workflowsPath = fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url));
const QUEUE = 'steward-light';
const QUEUE_HEAVY = 'steward-heavy';

let env: TestWorkflowEnvironment;

before(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, { timeout: 120_000 });

after(async () => {
  await env?.teardown();
});

const SHA = 'a'.repeat(64);

function snapshot(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    slug: 'fixture-post',
    collection: 'writing',
    file: 'src/content/writing/fixture-post.md',
    contentSha256: SHA,
    frontmatter: { draft: true, title: 't' },
    body: '## body',
    ...overrides,
  };
}

function passResult(overrides: Partial<PassResult> = {}): PassResult {
  return {
    pass: 'cspell',
    verdict: 'pass',
    findings: [],
    patches: [],
    startedAt: '2026-07-18T00:00:00.000Z',
    durationMs: 1,
    ...overrides,
  };
}

interface ApplyPatchesInput {
  report: ReviewReport;
  patchIds: string[];
}

interface MockOverrides {
  snapshotDraft?: () => Promise<DraftSnapshot>;
  currentContentHash?: () => Promise<string | null>;
  runCspell?: () => Promise<PassResult>;
  runVale?: () => Promise<PassResult>;
  checkFrontmatter?: () => Promise<PassResult>;
  editorialPass?: () => Promise<PassResult>;
  applyPatchesActivity?: (
    input: ApplyPatchesInput,
  ) => Promise<{ applied: string[]; file: string; contentSha256: string }>;
  /** Lets a test see the report the workflow handed to the apply activity. */
  synthesizePatches?: () => ReviewReport['patches'];
  publishPost?: (input: {
    report: ReviewReport;
  }) => Promise<{ branch: string; prUrl: string; title: string; committed: boolean }>;
  checkPrChecks?: (branch: string) => Promise<{
    state: 'passing' | 'pending' | 'failing';
    failing: string[];
    pending: string[];
  }>;
  verifyDeploy?: (input: {
    slug: string;
    collection?: string;
    title: string;
  }) => Promise<{ deployVerified: boolean; verification: VerificationRow[] }>;
}

interface VerificationRow {
  check: string;
  url: string;
  ok: boolean;
  detail: string;
}

const OK_ROWS: VerificationRow[] = [
  { check: 'html', url: 'https://example/writing/fixture-post/', ok: true, detail: '200' },
];
const FAIL_ROWS: VerificationRow[] = [
  { check: 'html', url: 'https://example/writing/fixture-post/', ok: false, detail: '404' },
];

/** Real synthesize/archive would touch disk, so both are mocked too. */
function mockActivities(overrides: MockOverrides = {}) {
  const archived: ReviewReport[] = [];
  /** Every call the workflow made, so tests can assert idempotent-resume. */
  const calls: string[] = [];
  const activities = {
    publishPost:
      overrides.publishPost ??
      (async () => {
        calls.push('publishPost');
        return {
          branch: 'steward/publish-fixture-post',
          prUrl: 'https://github.com/o/r/pull/1',
          title: 'Fixture Post',
          committed: true,
        };
      }),
    verifyDeploy:
      overrides.verifyDeploy ??
      (async () => {
        calls.push('verifyDeploy');
        return { deployVerified: true, verification: OK_ROWS };
      }),
    // Defaults to "no red checks", so the existing wait/park tests exercise the
    // path they were written for. A test that wants the fast-fail path overrides
    // this with `state: 'failing'`.
    checkPrChecks:
      overrides.checkPrChecks ??
      (async () => ({ state: 'pending' as const, failing: [], pending: [] })),
    snapshotDraft: overrides.snapshotDraft ?? (async () => snapshot()),
    currentContentHash: overrides.currentContentHash ?? (async () => SHA),
    runCspell: overrides.runCspell ?? (async () => passResult()),
    runVale: overrides.runVale ?? (async () => passResult({ pass: 'vale' })),
    checkFrontmatter:
      overrides.checkFrontmatter ?? (async () => passResult({ pass: 'frontmatter' })),
    editorialPass:
      overrides.editorialPass ?? (async () => passResult({ pass: 'claims_structure' })),
    applyPatchesActivity:
      overrides.applyPatchesActivity ??
      (async (input: ApplyPatchesInput) => ({
        applied: input.patchIds,
        file: input.report.file,
        contentSha256: 'b'.repeat(64),
      })),
    synthesizeReport: async (input: {
      snapshot: DraftSnapshot;
      passes: PassResult[];
      workflowId: string;
      runId: string;
      mode?: 'gate' | 'audit';
    }): Promise<ReviewReport> => {
      const worst = input.passes.some((p) => p.verdict === 'block')
        ? 'block'
        : input.passes.some((p) => p.verdict === 'flag')
          ? 'flag'
          : 'pass';
      return {
        schemaVersion: 1,
        slug: input.snapshot.slug,
        collection: input.snapshot.collection ?? 'writing',
        mode: input.mode ?? 'gate',
        file: input.snapshot.file,
        contentSha256: input.snapshot.contentSha256,
        reviewedAt: '2026-07-18T00:00:00.000Z',
        workflowId: input.workflowId,
        runId: input.runId,
        passes: input.passes,
        patches: overrides.synthesizePatches?.() ?? [],
        overall: worst,
        summary: `${worst.toUpperCase()} — mocked summary.`,
        human: {},
        publish: {},
      };
    },
    archiveReport: async (report: ReviewReport) => {
      archived.push(structuredClone(report));
      return {
        reportPath: `agents/steward/reviews/${report.slug}/${report.contentSha256.slice(0, 12)}.json`,
        latestPath: `agents/steward/reviews/${report.slug}/latest.json`,
      };
    },
  };
  return { activities, archived, calls };
}

async function withWorker<T>(
  activities: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const common = {
    connection: env.nativeConnection,
    workflowsPath,
    activities,
    bundlerOptions: {},
  };
  const light = await Worker.create({ ...common, taskQueue: QUEUE });
  const heavy = await Worker.create({ ...common, taskQueue: QUEUE_HEAVY });
  return await light.runUntil(heavy.runUntil(fn()));
}

function start(id: string) {
  return env.client.workflow.start(reviewPost, {
    workflowId: id,
    taskQueue: QUEUE,
    args: [{ slug: 'fixture-post', collection: 'writing' as const, skipBuildAudit: true }],
  });
}

/** An audit-mode run, optionally against another collection. */
function startAudit(id: string, collection: 'writing' | 'changelog' = 'changelog') {
  return env.client.workflow.start(reviewPost, {
    workflowId: id,
    taskQueue: QUEUE,
    args: [{ slug: 'fixture-post', collection, mode: 'audit' as const, skipBuildAudit: true }],
  });
}

/** The query only reports `awaiting_verdict` once the fan-out has archived. */
async function waitForState(
  handle: { query: typeof getReviewState extends never ? never : any },
  wanted: string,
  // The publish leg's park needs a far larger budget than the fan-out states:
  // reaching it means ten real verifyDeploy activity round-trips separated by
  // nine 90-second sleeps. Time-skipping collapses the *sleeps* to nothing, but
  // the activity invocations and the workflow-task turnarounds between them are
  // real work against the test server.
  attempts = 200,
) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    const state = await handle.query(getReviewState);
    last = state.state;
    if (state.state === wanted) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never reached ${wanted} (last seen: ${last})`);
}

/**
 * Waits for a state that lies on the far side of the publish leg's sleep/retry
 * loop, advancing the test clock explicitly between checks.
 *
 * **`waitForState` cannot be used here, and the reason is worth recording.**
 * Time-skipping only advances the clock when the environment is *idle*, and a
 * query is itself a workflow task. Polling every 25ms therefore keeps the
 * environment permanently busy and the clock permanently still — so the nine
 * 90-second sleeps in the verification loop elapse in **real time**. The symptom
 * is not a fast failure but a test that hangs for its full wall-clock duration
 * (observed: 128 seconds, then a timeout) and looks for all the world like a
 * deadlock in the workflow.
 *
 * The tell that it was the harness rather than the workflow: the deploy-wait
 * test passes in ~1s with three of the same sleeps, because it stops querying
 * once the workflow completes and lets the environment go idle.
 */
async function waitForStateSkipping(
  handle: { query: (q: typeof getReviewState) => Promise<any> },
  wanted: string,
  rounds = 30,
) {
  let last = '';
  for (let i = 0; i < rounds; i++) {
    const state = await handle.query(getReviewState);
    last = state.state;
    if (state.state === wanted) return state;
    // Advance past one interval of the verification loop. Between calls the
    // environment goes idle, which is what lets the skip actually happen.
    await env.sleep(90_000);
  }
  throw new Error(`never reached ${wanted} (last seen: ${last})`);
}

test('happy path: clean passes → awaiting_verdict → approve → approved', async () => {
  const { activities, archived } = mockActivities();
  await withWorker(activities, async () => {
    const handle = await start('wf-happy');
    const parked = await waitForState(handle, 'awaiting_verdict');

    assert.equal(parked.overall, 'pass');
    assert.match(parked.summary!, /^PASS/);
    assert.ok(parked.reportPath, 'the report is archived at verdict time, before any decision');

    await handle.signal(approve, false);
    const report = await handle.result();

    assert.equal(report.human.decision, 'approved');
    assert.ok(report.human.decidedAt, 'the decision is timestamped');
    // Phase 1a: the publish leg is off, so nothing was published.
    assert.deepEqual(report.publish, {});
    // Archived twice: once at verdict time, once with the decision recorded.
    assert.equal(archived.length, 2);
    assert.equal(archived[0].human.decision, undefined);
    assert.equal(archived[1].human.decision, 'approved');
  });
});

test('block path: approve is refused without --force, accepted with it', async () => {
  const { activities, archived } = mockActivities({
    runCspell: async () =>
      passResult({
        verdict: 'block',
        findings: [{ id: 'cspell-1', pass: 'cspell', severity: 'block', message: 'typo' }],
      }),
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-block');
    const parked = await waitForState(handle, 'awaiting_verdict');
    assert.equal(parked.overall, 'block');

    await handle.signal(approve, false);

    // The refusal is surfaced, the state does not move, and the workflow is
    // still running and still signalable.
    let refused = await handle.query(getReviewState);
    for (let i = 0; i < 200 && !refused.staleReason; i++) {
      await new Promise((r) => setTimeout(r, 25));
      refused = await handle.query(getReviewState);
    }
    assert.equal(refused.state, 'awaiting_verdict', 'a refused approve must not advance the state');
    assert.match(refused.staleReason!, /blocking findings/);
    assert.equal(archived.length, 1, 'a refused approve archives nothing new');

    await handle.signal(approve, true);
    const report = await handle.result();
    assert.equal(report.human.decision, 'approved_force');
  });
});

test('stale path: a changed file refuses approve; rereview produces a fresh report', async () => {
  const NEW_SHA = 'b'.repeat(64);
  let diskHash = SHA;
  let snapHash = SHA;

  const { activities } = mockActivities({
    snapshotDraft: async () => snapshot({ contentSha256: snapHash }),
    currentContentHash: async () => diskHash,
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-stale');
    await waitForState(handle, 'awaiting_verdict');

    // The human edits the file after the review was pinned.
    diskHash = NEW_SHA;
    await handle.signal(approve, false);

    const stale = await waitForState(handle, 'stale');
    assert.match(stale.staleReason!, /changed since it was reviewed/);
    assert.match(stale.staleReason!, new RegExp(NEW_SHA.slice(0, 12)));

    // Re-running the fan-out against the new bytes clears it.
    snapHash = NEW_SHA;
    await handle.signal(rereview);
    const fresh = await waitForState(handle, 'awaiting_verdict');
    assert.equal(fresh.staleReason, undefined);
    assert.ok(fresh.reportPath!.includes(NEW_SHA.slice(0, 12)), 'the new report is keyed by the new hash');

    await handle.signal(approve, false);
    const report = await handle.result();
    assert.equal(report.contentSha256, NEW_SHA);
    assert.equal(report.human.decision, 'approved');
  });
});

test('reject records the reason, re-archives, and completes', async () => {
  const { activities, archived } = mockActivities();
  await withWorker(activities, async () => {
    const handle = await start('wf-reject');
    await waitForState(handle, 'awaiting_verdict');

    await handle.signal(reject, 'the lede is buried');
    const report = await handle.result();

    assert.equal(report.human.decision, 'rejected');
    assert.equal(report.human.reason, 'the lede is buried');
    assert.equal(archived.at(-1)!.human.decision, 'rejected', 'rejected reviews are data too');
  });
});

test('a failing check flags rather than failing the workflow or passing silently', async () => {
  const { activities } = mockActivities({
    runCspell: async () => {
      throw new Error('cspell exploded');
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-toolfail');
    const parked = await waitForState(handle, 'awaiting_verdict');
    assert.equal(parked.overall, 'flag', 'a broken linter must not produce a cleaner report');
    await handle.signal(approve, false);
    const report = await handle.result();
    const failed = report.passes.find((p) => p.pass === 'cspell');
    assert.equal(failed!.verdict, 'flag');
    assert.match(failed!.findings[0].message, /cspell exploded/);
  });
});

test('two signals in quick succession are both processed, in order', async () => {
  // The regression this guards: `pending` used to be a single slot that every
  // handler assigned to, so a signal arriving before the loop drained the
  // previous one was silently overwritten and never processed.
  //
  // Delivery is made deterministic by holding the workflow inside the fan-out
  // (a slow `snapshotDraft`) while both signals arrive. Both handlers therefore
  // run before the decision loop gets a turn, which is exactly the condition
  // that lost a signal.
  //
  // Note on direction: `applyPatches`-then-`approve` does NOT distinguish the
  // two implementations — a dropped non-terminal signal leaves no trace once
  // the terminal one lands, so both versions finish `approved`. The order that
  // proves the fix is `approve`-then-`applyPatches`: under the old code the
  // approve was overwritten and the workflow parked forever. Both orders are
  // asserted below.
  const slowSnapshot = (ms: number) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return snapshot();
  };

  // Direction A — the first signal must not be dropped by the second.
  {
    const { activities } = mockActivities({ snapshotDraft: slowSnapshot(1500) });
    await withWorker(activities, async () => {
      const handle = await start('wf-fifo-first-wins');
      await handle.signal(approve, false);
      await handle.signal(applyPatches, ['p1']);

      // Old code: the approve is overwritten, this never resolves.
      const report = await handle.result();
      assert.equal(report.human.decision, 'approved', 'the first signal must survive the second');
    });
  }

  // Direction B — the second signal must not be dropped either, and the
  // non-terminal first one must be processed before it.
  {
    const { activities } = mockActivities({ snapshotDraft: slowSnapshot(1500) });
    await withWorker(activities, async () => {
      const handle = await start('wf-fifo-both-drain');
      await handle.signal(applyPatches, ['p1']);
      await handle.signal(approve, false);

      const report = await handle.result();
      assert.equal(report.human.decision, 'approved', 'the queued approve must still be processed');
    });
  }
});

// ---------------------------------------------------------------------------
// Spec §11 test 4 — the patch cycle: applyPatches → stale → rereview → approve.
// ---------------------------------------------------------------------------

test('patch path: applyPatches → stale → rereview → approve', async () => {
  const NEW_SHA = 'b'.repeat(64);
  let diskHash = SHA;
  let snapHash = SHA;
  const applyCalls: ApplyPatchesInput[] = [];

  const { activities, archived } = mockActivities({
    snapshotDraft: async () => snapshot({ contentSha256: snapHash }),
    currentContentHash: async () => diskHash,
    synthesizePatches: () =>
      snapHash === SHA
        ? [
            {
              id: 'patch-1',
              findingId: 'cspell-1',
              file: 'src/content/writing/fixture-post.md',
              oldText: 'damanging',
              newText: 'damaging',
              rationale: 'typo',
              source: 'mechanical' as const,
            },
          ]
        : [],
    applyPatchesActivity: async (input) => {
      applyCalls.push(structuredClone(input));
      // Applying really does change the file, so the mock moves the disk hash
      // exactly as the real activity would.
      diskHash = NEW_SHA;
      return { applied: input.patchIds, file: input.report.file, contentSha256: NEW_SHA };
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-patch-cycle');
    const parked = await waitForState(handle, 'awaiting_verdict');
    assert.deepEqual(
      (parked.pendingPatches as { id: string }[] | undefined)?.map((p) => p.id),
      ['patch-1'],
      'the patch is offered to the human by ID',
    );

    // 1. Apply the human-selected patch.
    await handle.signal(applyPatches, ['patch-1']);

    // 2. The workflow must go stale on its own — not wait for an approve to
    //    discover the file moved.
    const stale = await waitForState(handle, 'stale');
    assert.match(stale.staleReason!, /Applied patch-1/);
    assert.match(stale.staleReason!, /rereview/);

    // The activity was handed the whole report and only the selected ID.
    assert.equal(applyCalls.length, 1);
    assert.deepEqual(applyCalls[0].patchIds, ['patch-1']);

    // 3. Approve must still be refused while stale — the review is pinned to
    //    bytes that no longer exist.
    await handle.signal(approve, false);
    const stillStale = await waitForState(handle, 'stale');
    assert.match(stillStale.staleReason!, /changed since it was reviewed|Applied patch-1/);

    // 4. Rereview against the new bytes.
    snapHash = NEW_SHA;
    await handle.signal(rereview);
    const fresh = await waitForState(handle, 'awaiting_verdict');
    assert.equal(fresh.staleReason, undefined);
    assert.deepEqual(
      fresh.pendingPatches as { id: string }[],
      [],
      'the fixed typo no longer proposes a patch',
    );

    // 5. Approve now succeeds.
    await handle.signal(approve, false);
    const report = await handle.result();

    assert.equal(report.contentSha256, NEW_SHA);
    assert.equal(report.human.decision, 'approved');
    assert.deepEqual(
      report.human.patchesApplied,
      ['patch-1'],
      'the record of what was written to the file survives the rereview',
    );
    assert.ok(archived.length >= 3, 'each verdict-time report is archived');
  });
});

test('patch path: a signal arriving DURING the rereview fan-out is not dropped', async () => {
  // The condition the single-slot signal bug broke: a signal delivered while the
  // workflow sits inside a multi-second fan-out. Parked-only tests never hit it.
  let snapHash = SHA;
  let slow = false;

  const { activities } = mockActivities({
    snapshotDraft: async () => {
      if (slow) await new Promise((r) => setTimeout(r, 1500));
      return snapshot({ contentSha256: snapHash });
    },
    currentContentHash: async () => snapHash,
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-patch-signal-midflight');
    await waitForState(handle, 'awaiting_verdict');

    slow = true;
    await handle.signal(rereview);
    // Land the approve while the rereview fan-out is still in flight.
    await new Promise((r) => setTimeout(r, 300));
    await handle.signal(approve, false);

    const report = await handle.result();
    assert.equal(
      report.human.decision,
      'approved',
      'an approve delivered mid-fan-out must be queued, not lost',
    );
  });
});

test('patch path: a refused patch parks back on the verdict instead of failing the workflow', async () => {
  const { activities } = mockActivities({
    synthesizePatches: () => [
      {
        id: 'patch-1',
        findingId: 'cspell-1',
        file: 'src/content/writing/fixture-post.md',
        oldText: 'gone',
        newText: 'x',
        rationale: 'typo',
        source: 'mechanical' as const,
      },
    ],
    applyPatchesActivity: async () => {
      // The uniqueness guard refusing to guess is a correct outcome, not a crash.
      throw new Error('patch-1: the text to replace occurs 3 times in the file');
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-patch-refused');
    await waitForState(handle, 'awaiting_verdict');

    await handle.signal(applyPatches, ['patch-1']);

    let state = await handle.query(getReviewState);
    for (let i = 0; i < 200 && !state.staleReason; i++) {
      await new Promise((r) => setTimeout(r, 25));
      state = await handle.query(getReviewState);
    }

    assert.equal(state.state, 'awaiting_verdict', 'a failed apply must not strand the workflow');
    assert.match(state.staleReason!, /nothing was written/);
    assert.match(state.staleReason!, /occurs 3 times/, 'the real reason reaches the human');

    // Still signalable and still completable.
    await handle.signal(approve, false);
    const report = await handle.result();
    assert.equal(report.human.decision, 'approved');
  });
});

// ---------------------------------------------------------------------------
// Spec §11 test 5 — the tool-failure path, for Vale specifically.
// ---------------------------------------------------------------------------

test('tool-failure path: a dead Vale still reaches awaiting_verdict with a synthetic flag', async () => {
  const { activities } = mockActivities({
    runVale: async () => {
      throw new Error('vale exited 2 with no output: cannot find style "write-good"');
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-vale-dead');
    const parked = await waitForState(handle, 'awaiting_verdict');

    // A broken linter must not produce a cleaner report than a working one.
    assert.equal(parked.overall, 'flag');

    await handle.signal(approve, false);
    const report = await handle.result();

    const vale = report.passes.find((p) => p.pass === 'vale');
    assert.ok(vale, 'the failed pass still appears in the report');
    assert.equal(vale!.verdict, 'flag');
    assert.equal(vale!.findings.length, 1);
    // The real cause must survive, not the useless "Activity task failed" wrapper.
    assert.match(vale!.findings[0].message, /cannot find style "write-good"/);
    assert.match(vale!.findings[0].message, /not a clean bill of health/);

    // The other passes are unaffected — one dead tool does not poison the rest.
    assert.equal(report.passes.find((p) => p.pass === 'cspell')!.verdict, 'pass');
    assert.equal(report.passes.find((p) => p.pass === 'claims_structure')!.verdict, 'pass');
  });
});

test('tool-failure path: a dead editorial pass degrades the same way', async () => {
  const { activities } = mockActivities({
    editorialPass: async () => {
      throw new Error('The claims-structure rubric returned an invalid response twice.');
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-editorial-dead');
    const parked = await waitForState(handle, 'awaiting_verdict');
    assert.equal(parked.overall, 'flag');

    await handle.signal(approve, false);
    const report = await handle.result();
    const editorial = report.passes.find((p) => p.pass === 'claims_structure');
    assert.equal(editorial!.verdict, 'flag');
    assert.match(editorial!.findings[0].message, /invalid response twice/);
  });
});

test('a published post is refused outright', async () => {
  const { activities } = mockActivities({
    snapshotDraft: async () => snapshot({ frontmatter: { draft: false, title: 't' } }),
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-notdraft');
    // The workflow failure arrives wrapped; the reason lives on the cause chain.
    await assert.rejects(
      () => handle.result(),
      (err: Error) => {
        const chain: string[] = [];
        for (let e: unknown = err, i = 0; e instanceof Error && i < 5; i++, e = e.cause) {
          chain.push(e.message);
        }
        assert.ok(
          chain.some((m) => /only reviews drafts/.test(m)),
          `expected a "only reviews drafts" failure, got: ${chain.join(' <- ')}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Audit mode — reviewing already-published content.
//
// The distinguishing property is *absence*: no durable wait, no verdict, no
// publish leg, and no path by which the Steward writes to a published file.
// These tests assert the absences, because an audit that quietly grew a way to
// edit live content would still pass every gate-mode test in this file.
// ---------------------------------------------------------------------------

test('audit mode: reviews published content and completes without a verdict', async () => {
  const { activities, archived } = mockActivities({
    // draft: false — in gate mode this is the hard refusal. Audit mode is the
    // only thing allowed to look at it.
    snapshotDraft: async () =>
      snapshot({ collection: 'changelog', frontmatter: { draft: false, title: 't' } }),
  });

  await withWorker(activities, async () => {
    const handle = await startAudit('wf-audit-happy');
    // No signal is sent. If audit mode parked on a verdict the way gate mode
    // does, this would hang until the test timeout — which is the failure this
    // assertion is really buying.
    const report = await handle.result();

    assert.equal(report.mode, 'audit');
    assert.equal(report.collection, 'changelog');
    // Nobody decided anything, because nobody was asked.
    assert.equal(report.human.decision, undefined);
    assert.equal(report.human.decidedAt, undefined);
    // Archived exactly once: at report time. Gate mode archives a second time
    // when the decision lands, and there is no decision here.
    assert.equal(archived.length, 1);
    assert.equal(archived[0].mode, 'audit');
  });
});

test('audit mode: the gate-mode draft refusal is unchanged', async () => {
  const { activities } = mockActivities({
    snapshotDraft: async () => snapshot({ frontmatter: { draft: false, title: 't' } }),
  });

  await withWorker(activities, async () => {
    // Same published file, gate mode: still refused. Audit mode must widen what
    // the Steward will review without loosening the gate by even a little.
    const handle = await start('wf-audit-gate-still-refuses');
    await assert.rejects(handle.result(), (err: unknown) => {
      // `WorkflowFailedError`'s own message is the constant "Workflow execution
      // failed" — the same wrapping problem `describeActivityError` exists for.
      // Asserting on it would pass against any failure at all, including the
      // gate silently breaking in some unrelated way.
      let current: unknown = err;
      for (let depth = 0; current instanceof Error && depth < 5; depth++) {
        if (/already published/.test(current.message)) return true;
        current = current.cause;
      }
      throw new Error(`expected a NotADraft refusal, got: ${String(err)}`);
    });
  });
});

test('audit mode: applyPatches is refused — nothing is written to published content', async () => {
  let applyCalled = 0;
  const { activities } = mockActivities({
    // Hold the workflow inside the fan-out long enough to land the signal while
    // it is mid-activity. Without this the signal races the workflow's
    // completion and the test would pass vacuously.
    snapshotDraft: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return snapshot({ collection: 'changelog', frontmatter: { draft: false, title: 't' } });
    },
    applyPatchesActivity: async (input) => {
      applyCalled += 1;
      return { applied: input.patchIds, file: input.report.file, contentSha256: 'b'.repeat(64) };
    },
  });

  await withWorker(activities, async () => {
    const handle = await startAudit('wf-audit-apply-refused');
    await handle.signal(applyPatches, ['patch-1']);
    const report = await handle.result();

    assert.equal(applyCalled, 0, 'the apply activity must never run against published content');
    assert.equal(report.human.patchesApplied, undefined);
    assert.equal(report.mode, 'audit');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — the publish leg.
// ---------------------------------------------------------------------------

test('approve without a publish payload records the decision and completes (pre-Phase-2 behaviour)', async () => {
  const { activities, calls } = mockActivities();
  await withWorker(activities, async () => {
    const handle = await start('wf-publish-off');
    await waitForState(handle, 'awaiting_verdict');
    // One argument only — exactly the shape every history written before Phase 2
    // recorded, and the shape the Phase 1b replay fixture carries.
    await handle.signal(approve, false);
    const report = await handle.result();

    assert.equal(report.human.decision, 'approved');
    assert.equal(report.publish.prUrl, undefined);
    assert.deepEqual(calls, [], 'no publish activity may run without an explicit publish payload');
  });
});

test('test 6 — deploy-wait: verifyDeploy fails 3 times then succeeds → published', async () => {
  let attempts = 0;
  const { activities, archived } = mockActivities({
    verifyDeploy: async () => {
      attempts += 1;
      return attempts <= 3
        ? { deployVerified: false, verification: FAIL_ROWS }
        : { deployVerified: true, verification: OK_ROWS };
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-deploy-wait');
    await waitForState(handle, 'awaiting_verdict');
    await handle.signal(approve, false, true);
    const report = await handle.result();

    assert.equal(attempts, 4, 'must retry until production agrees, not give up on the first miss');
    assert.equal(report.publish.deployVerified, true);
    assert.equal(report.publish.prUrl, 'https://github.com/o/r/pull/1');
    assert.equal(report.publish.branch, 'steward/publish-fixture-post');
    assert.deepEqual(report.publish.verification, OK_ROWS);
    // The PR URL is archived as soon as the PR exists, before verification —
    // so a park does not leave it only in workflow memory.
    assert.ok(
      archived.some((r) => r.publish.prUrl && r.publish.deployVerified === undefined),
      'the report must be archived once with a PR URL and no verdict yet',
    );
  });
});

test('verification exhausting parks on the open PR rather than failing the workflow', async () => {
  const { activities } = mockActivities({
    verifyDeploy: async () => ({ deployVerified: false, verification: FAIL_ROWS }),
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-publish-park');
    await waitForState(handle, 'awaiting_verdict');
    await handle.signal(approve, false, true);

    // Back to `publishing` — the PR is open and the publish is genuinely
    // incomplete. Crucially the workflow is still RUNNING and still signalable.
    const state = await waitForStateSkipping(handle, 'publishing');
    assert.match(state.staleReason ?? '', /awaiting merge/i);
    assert.match(state.staleReason ?? '', /pull\/1/);
    assert.match(state.staleReason ?? '', /never merges/i);

    const desc = await handle.describe();
    assert.equal(desc.status.name, 'RUNNING', 'a park must not be a failure');
  });
});

test('a repeat approve after a park is an idempotent resume: it re-verifies and never re-publishes', async () => {
  let verifyCalls = 0;
  let publishCalls = 0;
  const { activities, calls } = mockActivities({
    publishPost: async () => {
      publishCalls += 1;
      return {
        branch: 'steward/publish-fixture-post',
        prUrl: 'https://github.com/o/r/pull/1',
        title: 'Fixture Post',
        committed: true,
      };
    },
    verifyDeploy: async () => {
      verifyCalls += 1;
      // Fail every attempt of the first pass; succeed on the resume.
      return verifyCalls > 10
        ? { deployVerified: true, verification: OK_ROWS }
        : { deployVerified: false, verification: FAIL_ROWS };
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-publish-resume');
    await waitForState(handle, 'awaiting_verdict');
    await handle.signal(approve, false, true);
    await waitForStateSkipping(handle, 'publishing');

    assert.equal(publishCalls, 1);
    assert.equal(verifyCalls, 10, 'the first pass must exhaust its ten attempts');

    // The human merged the PR and re-approves. The payload deliberately says
    // `publish: false` — a resume must NOT read that as "un-publish". That
    // decision was consumed once, at the first approve, and is already in
    // history; there is no un-publish operation and the commit is on the
    // default branch.
    await handle.signal(approve, false, false);
    const report = await handle.result();

    assert.equal(report.publish.deployVerified, true);
    assert.equal(publishCalls, 1, 'a resume must never open a second PR');
    assert.equal(verifyCalls, 11);
    assert.equal(calls.length, 0);
  });
});

test('a blocked report still refuses approve even with the publish leg on', async () => {
  const { activities } = mockActivities({
    runCspell: async () => passResult({ verdict: 'block' }),
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-publish-block');
    await waitForState(handle, 'awaiting_verdict');
    await handle.signal(approve, false, true);

    for (let i = 0; i < 100; i++) {
      const s = await handle.query(getReviewState);
      if (s.staleReason) {
        assert.match(s.staleReason, /blocking findings/i);
        assert.equal(s.state, 'awaiting_verdict', 'a refused approve must not enter publishing');
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('approve was never refused');
  });
});

test('approve --force with the publish leg on publishes and records approved_force', async () => {
  const { activities } = mockActivities({
    runCspell: async () => passResult({ verdict: 'block' }),
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-publish-force');
    await waitForState(handle, 'awaiting_verdict');
    await handle.signal(approve, true, true);
    const report = await handle.result();

    assert.equal(report.human.decision, 'approved_force');
    assert.equal(report.publish.deployVerified, true);
  });
});

test('a stale file refuses approve before anything is published', async () => {
  let publishCalls = 0;
  const { activities } = mockActivities({
    currentContentHash: async () => 'c'.repeat(64),
    publishPost: async () => {
      publishCalls += 1;
      return { branch: 'b', prUrl: 'u', title: 't', committed: true };
    },
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-publish-stale');
    await waitForState(handle, 'awaiting_verdict');
    await handle.signal(approve, false, true);
    const state = await waitForState(handle, 'stale');

    assert.match(state.staleReason ?? '', /changed since it was reviewed/i);
    assert.equal(publishCalls, 0, 'nothing may be published from a stale review');
  });
});

test('a failing PR check parks immediately instead of polling production for 15 minutes', async () => {
  // Regression for the first real publish. A corrupted frontmatter flip broke
  // the Vercel build, and because `verifyDeploy` polls PRODUCTION — which only
  // goes green after a human merges, and nobody merges a red PR — the operator
  // got a silent fifteen-minute wait instead of the failure GitHub already knew
  // about twenty seconds in. A slow success and a guaranteed failure must not
  // look identical.
  const { activities, calls } = mockActivities({
    verifyDeploy: async () => ({ deployVerified: false, verification: FAIL_ROWS }),
    checkPrChecks: async () => ({ state: 'failing', failing: ['Vercel', 'axe'], pending: [] }),
  });

  await withWorker(activities, async () => {
    const handle = await start('wf-publish-ci-red');
    await waitForState(handle, 'awaiting_verdict');
    await handle.signal(approve, false, true);

    const state = await waitForStateSkipping(handle, 'publishing');

    assert.match(state.staleReason ?? '', /CI is FAILING/);
    // The cause is NAMED. "Verification did not pass" was true during the real
    // incident and told the operator nothing.
    assert.match(state.staleReason ?? '', /Vercel/);
    assert.match(state.staleReason ?? '', /axe/);

    // Parked, not failed: a red check is operator-fixable and then resumable.
    const desc = await handle.describe();
    assert.equal(desc.status.name, 'RUNNING', 'a red check must park, not fail');

    // And it stopped early rather than burning all ten attempts.
    const verifyCalls = calls.filter((c) => c === 'verifyDeploy').length;
    assert.ok(verifyCalls < 10, `expected an early stop, got ${verifyCalls} verifyDeploy calls`);
  });
});
