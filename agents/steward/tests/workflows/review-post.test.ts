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
}

/** Real synthesize/archive would touch disk, so both are mocked too. */
function mockActivities(overrides: MockOverrides = {}) {
  const archived: ReviewReport[] = [];
  const activities = {
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
    }): Promise<ReviewReport> => {
      const worst = input.passes.some((p) => p.verdict === 'block')
        ? 'block'
        : input.passes.some((p) => p.verdict === 'flag')
          ? 'flag'
          : 'pass';
      return {
        schemaVersion: 1,
        slug: input.snapshot.slug,
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
  return { activities, archived };
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

/** The query only reports `awaiting_verdict` once the fan-out has archived. */
async function waitForState(
  handle: { query: typeof getReviewState extends never ? never : any },
  wanted: string,
) {
  for (let i = 0; i < 200; i++) {
    const state = await handle.query(getReviewState);
    if (state.state === wanted) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never reached ${wanted}`);
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
