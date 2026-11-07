import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import {
  SyncError,
  fixOffered,
  syncFindings,
  syncSummary,
  totalCounts,
  verifyOffered,
  type SyncClient,
} from '../../src/lib/finding-actions.js';

/**
 * The shared half of `steward finding sync|fix|verify` and the console's buttons, against fakes: the
 * schedule and its run for sync, and the gates the page uses to offer Fix and Verify.
 */

const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/533';

function fakeClient(opts: { skipped?: boolean; never?: boolean; result?: unknown; resultNever?: boolean }) {
  let taken = 4;
  let skipped = 0;
  const triggers: unknown[] = [];
  const recentActions: { action: { type: string; workflow: { workflowId: string; firstExecutionRunId: string } } }[] = [];
  const client: SyncClient = {
    schedule: {
      getHandle: () => ({
        describe: async () => ({ info: { numActionsTaken: taken, numActionsSkippedOverlap: skipped, recentActions } }),
        trigger: async (overlap) => {
          triggers.push(overlap);
          if (opts.never) return;
          if (opts.skipped) skipped += 1;
          else {
            taken += 1;
            recentActions.push({ action: { type: 'startWorkflow', workflow: { workflowId: 'reconcile-run', firstExecutionRunId: 'run-1' } } });
          }
        },
      }),
    },
    workflow: {
      getHandle: (workflowId, runId) => ({
        result: async () => {
          assert.equal(workflowId, 'reconcile-run');
          assert.equal(runId, 'run-1');
          if (opts.resultNever) return new Promise(() => {});
          return opts.result;
        },
      }),
    },
  };
  return { client, triggers };
}

const COUNTS = { 'mattpyle-com': { started: 1, signalled: 2, fixed: 0, unchanged: 7 }, 'temporal-io': { started: 0, signalled: 1, fixed: 0, unchanged: 3 } };

test('sync triggers with overlap SKIP and answers the counts of the run the trigger started', async () => {
  const { client, triggers } = fakeClient({ result: COUNTS });
  const result = await syncFindings(client, { pollMs: 1 });
  assert.deepEqual(triggers, [ScheduleOverlapPolicy.SKIP]);
  assert.equal(result.triggered, true);
  assert.equal(result.workflowId, 'reconcile-run');
  assert.deepEqual(result.total, { started: 1, signalled: 3, fixed: 0, restarted: 0, closed: 0, unchanged: 10 });
  assert.equal(syncSummary(result), 'Started 1, signalled 3, fixed 0, restarted 0, closed 0, unchanged 10.');
});

test('sync with a reconcile already running starts none and says so', async () => {
  const { client } = fakeClient({ skipped: true });
  const result = await syncFindings(client, { pollMs: 1 });
  assert.equal(result.triggered, false);
  assert.equal(result.sites, null);
  assert.match(syncSummary(result), /already running/);
});

test('sync that cannot see a run on the schedule is an error naming the cause to check', async () => {
  const { client } = fakeClient({ never: true });
  await assert.rejects(() => syncFindings(client, { pickUpMs: 20, pollMs: 5 }), (err: unknown) => err instanceof SyncError && /Paused or missing/i.test(err.message));
});

test('sync that outlasts the wait for the result answers a running reconcile without counts', async () => {
  const { client } = fakeClient({ resultNever: true });
  const result = await syncFindings(client, { pollMs: 1, resultMs: 20 });
  assert.equal(result.triggered, true);
  assert.equal(result.total, null);
  assert.match(syncSummary(result), /has not finished/);
});

test('totalCounts sums every site', () => {
  assert.deepEqual(totalCounts(COUNTS), { started: 1, signalled: 3, fixed: 0, restarted: 0, closed: 0, unchanged: 10 });
});

const defect = { status: 'approved', kind: 'defect' };
const textOf = (cause: boolean, measure: boolean) =>
  [
    '---',
    'status: approved',
    '---',
    '# A title',
    '## What happened',
    cause ? '- Cause: a missing alt attribute.' : '- Seen on /about.',
    ...(measure ? ['## How to measure', 'Open /about and look for an alt attribute.'] : []),
  ].join('\n');

test('Fix is offered for an approved finding with no open run on a site with a fixer that fixRefusal accepts', () => {
  const base = { site: 'mattpyle-com', status: 'approved', runOpen: false, stopAfter: null, data: defect, text: textOf(true, true) };
  assert.equal(fixOffered(base), true);
  assert.equal(fixOffered({ ...base, runOpen: true }), false, 'an open run');
  assert.equal(fixOffered({ ...base, status: 'proposed' }), false, 'not approved');
  assert.equal(fixOffered({ ...base, stopAfter: 'verdict' }), false, 'a site that stops at the verdict');
  assert.equal(fixOffered({ ...base, site: 'temporal-io' }), false, 'a site with no production origin');
  assert.equal(fixOffered({ ...base, text: textOf(false, true) }), false, 'no cause');
  assert.equal(fixOffered({ ...base, text: textOf(true, false) }), false, 'no measure');
  assert.equal(fixOffered({ ...base, data: { status: 'approved', kind: 'direction' } }), false, 'a direction');
});

test('Fix is also offered for a run parked at waiting-fix with no issue, and not for one with an issue or mid-fix', () => {
  const base = { site: 'mattpyle-com', status: 'approved', runOpen: true, runStep: 'waiting-fix', issueUrl: null, stopAfter: null, data: defect, text: textOf(true, true) };
  assert.equal(fixOffered(base), true, 'a parked run the gate accepts');
  assert.equal(fixOffered({ ...base, issueUrl: 'https://github.com/o/r/issues/1' }), false, 'its issue is open or its fix ended: the CLI retries it');
  assert.equal(fixOffered({ ...base, runStep: 'fixing' }), false, 'mid-fix');
  assert.equal(fixOffered({ ...base, runStep: null }), false, 'a run that was not queried');
  assert.equal(fixOffered({ ...base, text: textOf(true, false) }), false, 'a parked run the gate refuses');
});

test('Verify is offered for a fixing finding with a PR that is merged, and the PR is asked about only when the gate accepts', async () => {
  const asked: string[] = [];
  const merged = async (url: string) => (asked.push(url), true);
  const open = async (url: string) => (asked.push(url), false);
  const fixing = { status: 'fixing', links: { pr: PR } };
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: fixing }, merged), true);
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: fixing }, open), false, 'an open PR');
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: { status: 'fixing' } }, merged), false, 'no links.pr');
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: { status: 'resolved', links: { pr: PR } } }, merged), false, 'resolved');
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: { status: 'approved', links: { pr: PR } } }, merged), false, 'approved');
  assert.equal(await verifyOffered({ site: 'temporal-io', data: fixing }, merged), false, 'a site with no production origin');
  assert.deepEqual(asked, [PR, PR]);
});
