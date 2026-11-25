import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, type WorkflowHandle } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { ApplicationFailureCategory } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { STOPS_AT_VERDICT, settings } from '../helpers/verdict-measure.js';
import {
  PARKED_ISSUE_REREAD_PATCH,
  SETTINGS_AT_USE_PATCH,
  findingStateQuery,
  findingWorkflow,
  fixSignal,
  verdictSignal,
  verdictUpdate,
  type FindingState,
  type FindingWorkflowInput,
  type FindingWorkflowResult,
} from '../../src/workflows/finding.js';
import type { FindingSettings, FixIssue } from '../../src/activities/findings.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import { DEFECT_FINDING, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * Settings read when a finding run uses them (STW-645), on the real
 * `findingWorkflow` with mocked activities: the stop point, `auto_fix` and
 * the fixer's gate come from `readFindingSettings` at an approved verdict,
 * whatever the start input says, and a run parked at `waiting-fix` with no
 * issue reads them again once a day.
 *
 * Each test has its own time-skipping server and awaits at most one thing
 * through the time-skipping client, a `result()` or one `env.sleep`, for the
 * reason `finding-lifecycle.test.ts` gives. Everything else goes through the
 * plain `client`, in real time.
 */

const FINDINGS = 'steward-findings';
const SITE = 'mattpyle-com';
const SITE_REPO = 'mattpyle/mattpyle.com-website';
const ISSUE = `https://github.com/${SITE_REPO}/issues/101`;
const PR = `https://github.com/${SITE_REPO}/pull/401`;

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

type Handle = WorkflowHandle<typeof findingWorkflow>;

interface Scene {
  /** What the settings read answers now. A test changes it while the run is parked. */
  now: FindingSettings;
  /** How many reads fail first, retryably, as a rejected credential does. */
  failFirst?: number;
  /** What `openFixIssue` does on each call: an issue unless the entry is a failure type. The last entry repeats. */
  issues?: (string | null)[];
  /** The PR wait fails with this type. Absent: the PR opens and the run reaches its merge wait. */
  prFail?: string;
}

function mocks(scene: Scene) {
  const called: string[] = [];
  const note = (name: string) => called.push(name);
  let opens = 0;
  const activities = {
    writeFindingVerdict: async () => (note('writeFindingVerdict'), { findingCommitSha: null, indexCommitSha: null, commitSha: 'c1' }),
    readFindingSettings: async () => {
      note('readFindingSettings');
      if ((scene.failFirst ?? 0) > 0) {
        scene.failFirst = (scene.failFirst ?? 0) - 1;
        throw ApplicationFailure.create({ message: 'GitHub rejected the credential (401).', type: 'AuthError', nonRetryable: false });
      }
      return scene.now;
    },
    // The measurement at the verdict: a finding with no checks, recorded unmeasured.
    readFinding: async () => (note('readFinding'), { text: DEFECT_FINDING, sha: 'f1' }),
    readVerifyBlock: async () => (note('readVerifyBlock'), { handoff: null, hasBlock: false, checks: [], source: 'finding' as const }),
    writeFindingVerdictMeasure: async () => (note('writeFindingVerdictMeasure'), { commitSha: null }),
    readSiteAutoFix: async () => (note('readSiteAutoFix'), true),
    requestFixSlot: async () => (note('requestFixSlot'), { paths: [], dispatched: false }),
    openFixIssue: async (): Promise<FixIssue> => {
      note('openFixIssue');
      const script = scene.issues ?? [null];
      const fail = script[Math.min(opens, script.length - 1)];
      opens++;
      if (fail) throw ApplicationFailure.nonRetryable('the fixer refused it', fail);
      return { repo: SITE_REPO, number: 101, url: ISSUE, reused: false };
    },
    awaitFixPr: async () => {
      note('awaitFixPr');
      if (scene.prFail) throw ApplicationFailure.nonRetryable('the Action opened no PR', scene.prFail);
      return { prUrl: PR, number: 401, branch: 'claude/issue-101-x' };
    },
    writeFindingFix: async () => (note('writeFindingFix'), { findingCommitSha: null, indexCommitSha: null, commitSha: null }),
    // A PR nobody merges: every poll answers "still open", quietly.
    awaitFixPrMerge: async () => {
      throw ApplicationFailure.create({ message: 'still open', type: 'FixPrOpen', nonRetryable: false, category: ApplicationFailureCategory.BENIGN });
    },
  };
  return { activities, called, count: (name: string) => called.filter((c) => c === name).length };
}

function input(id: string, over: Partial<FindingWorkflowInput> = {}): FindingWorkflowInput {
  return {
    site: SITE,
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/${SITE}/findings/${DEFECT_KEY}.md`,
    indexPath: `sites/${SITE}/findings/INDEX.md`,
    stopAfter: 'resolved',
    handoffPath: `sites/${SITE}/handoffs/${DEFECT_KEY}.md`,
    branch: `fix/finding-${id}`,
    origin: ORIGIN,
    ...over,
  };
}

/** An input that holds identity only: what a start sends once the earlier fields are dropped. */
function identityOnly(): FindingWorkflowInput {
  return {
    site: SITE,
    key: DEFECT_KEY,
    repo: 'mattpyle/argus',
    findingPath: `sites/${SITE}/findings/${DEFECT_KEY}.md`,
    indexPath: `sites/${SITE}/findings/INDEX.md`,
  };
}

const APPROVE: FindingVerdict = { status: 'approved', reason: 'In the file.', source: 'file', at: '2026-11-21T09:00:00.000Z' };
const REJECT: FindingVerdict = { ...APPROVE, status: 'rejected', reason: 'By design.' };
const FIX = { source: 'cli' as const, at: '2026-11-21T09:05:00.000Z' };

async function until(handle: Pick<Handle, 'query'>, ready: (state: FindingState) => boolean, what: string): Promise<FindingState> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await handle.query(findingStateQuery);
    if (ready(state)) return state;
    if (Date.now() > deadline) assert.fail(`the run never reached ${what}; it is at ${state.step}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function run<T>(scene: Scene, body: (m: ReturnType<typeof mocks>, start: (id: string, args?: FindingWorkflowInput) => Promise<Handle>) => Promise<T>) {
  const m = mocks(scene);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: m.activities,
    taskQueue: FINDINGS,
  });
  const start = (id: string, args: FindingWorkflowInput = input(id)) =>
    client.workflow.start(findingWorkflow, { workflowId: `finding/${SITE}/at-use-${id}`, taskQueue: FINDINGS, args: [args] });
  const out = await worker.runUntil(bounded(body(m, start)));
  return { ...m, out };
}

/** The test's one time-skipping await when it is a result. */
function skipResult(handle: { workflowId: string }) {
  return env.client.workflow.getHandle<typeof findingWorkflow>(handle.workflowId).result();
}

async function markers(handle: Handle): Promise<string[]> {
  const history = await handle.fetchHistory();
  return (history.events ?? [])
    .map((event) => event.upsertWorkflowSearchAttributesEventAttributes?.searchAttributes?.indexedFields?.TemporalChangeVersion?.data)
    .filter(Boolean)
    .map((data) => Buffer.from(data as Uint8Array).toString('utf8'));
}

test('a run started with waitsForPerson for an opportunity attempts its fix at the verdict when the gate accepts', async () => {
  const scene: Scene = { now: settings({ autoFix: true, kind: 'opportunity' }) };
  const { called, out } = await run(scene, async (_m, start) => {
    const handle = await start('opportunity', input('opportunity', { waitsForPerson: true }));
    await handle.signal(verdictSignal, APPROVE);
    const state = await until(handle, (s) => s.step === 'waiting-merge', 'the merge wait');
    const seen = await markers(handle);
    await handle.terminate('test over');
    return { state, seen };
  });
  assert.equal(out.state.fixAttempts, 1);
  assert.equal(out.state.issueUrl, ISSUE);
  assert.equal(out.state.waitsForPerson, false);
  // No `fix` signal, and no wait for one: the stop point, the measurement, the decision, the attempt.
  assert.deepEqual(called.slice(0, 7), [
    'readFindingSettings',
    'readFinding',
    'readVerifyBlock',
    'writeFindingVerdictMeasure',
    'readFindingSettings',
    'requestFixSlot',
    'openFixIssue',
  ]);
  assert.ok(!called.includes('readSiteAutoFix'), 'the flag comes from the settings read');
  // The settings marker stands in for the measure marker and the auto-fix marker.
  assert.ok(out.seen.some((list) => list.includes(SETTINGS_AT_USE_PATCH)));
  assert.ok(!out.seen.some((list) => list.includes('verdict-measure') || list.includes('fixer-auto-fix')));
});

test('a finding the gate refuses parks with no attempt, no slot request and the reason', async () => {
  const scene: Scene = { now: settings({ autoFix: true, kind: 'opportunity', refusal: 'it names more than one page (/a, /b) in "What would serve them" and no verify check names a page, so no preview test can fail on its fix' }) };
  const { called, out } = await run(scene, async (_m, start) => {
    const handle = await start('refused');
    await handle.signal(verdictSignal, APPROVE);
    const state = await until(handle, (s) => s.step === 'waiting-fix' && Boolean(s.lastFixError), 'the park');
    await handle.terminate('test over');
    return state;
  });
  assert.equal(out.fixAttempts, 0);
  assert.equal(out.lastFixError, `${DEFECT_KEY} does not go to the fixer: it names more than one page (/a, /b) in "What would serve them" and no verify check names a page, so no preview test can fail on its fix.`);
  assert.equal(out.waitsForPerson, false, 'an opportunity is not a finding only a person can take');
  assert.ok(!called.includes('requestFixSlot') && !called.includes('openFixIssue'));
});

test('auto_fix turned on after the park: the daily re-read starts the attempt with no signal', async () => {
  const scene: Scene = { now: settings({ autoFix: false }) };
  const { called, count, out } = await run(scene, async (m, start) => {
    const handle = await start('flag-later');
    await handle.signal(verdictSignal, APPROVE);
    // The read is counted when the activity is called; `waitsForPerson` is set once its result is
    // applied, and only then does the run start the one-day timer the sleep below must find.
    await until(
      handle,
      (s) => s.step === 'waiting-fix' && m.count('readFindingSettings') === 2 && s.waitsForPerson === false,
      'the park',
    );
    assert.equal((await handle.query(findingStateQuery)).lastFixError, null, 'a site without auto_fix is no refusal');
    assert.ok(!m.called.includes('openFixIssue'));
    scene.now = settings({ autoFix: true });
    await env.sleep('25 hours');
    const state = await until(handle, (s) => s.step === 'waiting-merge', 'the merge wait');
    await handle.terminate('test over');
    return state;
  });
  assert.equal(out.fixAttempts, 1);
  assert.equal(count('readFindingSettings'), 3, 'the stop point, the decision, and one re-read a day later');
  assert.equal(count('openFixIssue'), 1);
  assert.ok(called.indexOf('openFixIssue') > called.lastIndexOf('readFindingSettings'));
});

test('a parked run with no issue ends closed when its file is resolved or rejected elsewhere', async () => {
  const scene: Scene = { now: settings({ autoFix: true, kind: 'direction', refusal: 'its kind is direction, not defect or opportunity' }) };
  const { called, out } = await run(scene, async (m, start) => {
    const handle = await start('closed');
    await handle.signal(verdictSignal, APPROVE);
    // The mock counts the read when the activity is called; the run sets `waitsForPerson` only once
    // its result is applied, in a later workflow task. The wait covers the state it asserts.
    const parked = await until(
      handle,
      (s) => s.step === 'waiting-fix' && m.count('readFindingSettings') === 2 && s.waitsForPerson === true,
      'the park',
    );
    assert.equal(parked.waitsForPerson, true, 'a direction waits for a person');
    scene.now = settings({ autoFix: true, status: 'resolved', refusal: 'its status is resolved, not approved' });
    return (await skipResult(handle)) as FindingWorkflowResult;
  });
  assert.equal(out.outcome, 'closed');
  assert.equal(out.note, 'Closed while it waited for a fix: the finding file says resolved.');
  assert.equal(out.fixAttempts, 0);
  assert.equal(out.prUrl, null);
  assert.ok(!called.includes('requestFixSlot') && !called.includes('openFixIssue'));
});

test('a parked run that has opened an issue reads its file daily and is never re-attempted by the read', async () => {
  // The Action opened no PR: the run is back at waiting-fix with its issue.
  const scene: Scene = { now: settings({ autoFix: true }), prFail: 'NoPr' };
  const { count, out } = await run(scene, async (m, start) => {
    const handle = await start('has-issue');
    await handle.signal(verdictSignal, APPROVE);
    await until(handle, (s) => s.step === 'waiting-fix' && s.fixAttempts === 1 && Boolean(s.issueUrl), 'waiting-fix with an issue');
    const reads = m.count('readFindingSettings');
    const seen = await markers(handle);
    // The file stays approved and the gate would accept: three daily reads, and no attempt.
    await env.sleep('73 hours');
    await until(handle, () => m.count('readFindingSettings') === reads + 3, 'three daily reads');
    const state = await handle.query(findingStateQuery);
    const status = (await handle.describe()).status.name;
    await handle.terminate('test over');
    return { state, status, reads, seen };
  });
  assert.equal(out.reads, 2, 'no read before the first day is over');
  assert.ok(out.seen.some((marker) => marker.includes(PARKED_ISSUE_REREAD_PATCH)), 'the park records its marker');
  assert.equal(out.status, 'RUNNING', 'an approved file does not close the run');
  assert.equal(out.state.step, 'waiting-fix');
  assert.equal(out.state.issueUrl, ISSUE);
  assert.equal(out.state.fixAttempts, 1);
  assert.equal(count('openFixIssue'), 1, 'no second issue');
});

test('a parked run that has opened an issue ends closed when its file is decided elsewhere, and leaves the issue as it is', async () => {
  const scene: Scene = { now: settings({ autoFix: true }), prFail: 'NoPr' };
  const { called, count, out } = await run(scene, async (m, start) => {
    const handle = await start('has-issue-closed');
    await handle.signal(verdictSignal, APPROVE);
    await until(handle, (s) => s.step === 'waiting-fix' && s.fixAttempts === 1 && Boolean(s.issueUrl), 'waiting-fix with an issue');
    assert.equal(m.count('readFindingSettings'), 2);
    // The inspector's verify resolved the finding in its file.
    scene.now = settings({ autoFix: true, status: 'resolved', refusal: 'its status is resolved, not approved' });
    return (await skipResult(handle)) as FindingWorkflowResult;
  });
  assert.equal(out.outcome, 'closed');
  assert.equal(out.note, `Closed while it waited for a fix: the finding file says resolved. Its fix issue ${ISSUE} is left as it is.`);
  assert.equal(out.fixAttempts, 1);
  assert.equal(count('readFindingSettings'), 3, 'one read, a day after the park');
  assert.equal(count('openFixIssue'), 1);
  // Nothing on GitHub is touched by the close: the last activity is the read.
  assert.equal(called[called.length - 1], 'readFindingSettings');
});

test('a person\'s fix still starts the next attempt of a run parked with an issue, at once', async () => {
  const scene: Scene = { now: settings({ autoFix: true }), prFail: 'NoPr' };
  const { count, out } = await run(scene, async (m, start) => {
    const handle = await start('has-issue-fix');
    await handle.signal(verdictSignal, APPROVE);
    await until(handle, (s) => s.step === 'waiting-fix' && s.fixAttempts === 1 && Boolean(s.issueUrl), 'waiting-fix with an issue');
    await handle.signal(fixSignal, FIX);
    const state = await until(handle, (s) => s.step === 'waiting-fix' && s.fixAttempts === 2, 'the second attempt');
    const reads = m.count('readFindingSettings');
    await handle.terminate('test over');
    return { state, reads };
  });
  assert.equal(count('openFixIssue'), 2);
  assert.equal(out.reads, 2, 'the fix did not wait for a read');
});

test('a run started with a verdict in its input does not wait at the gate, writes nothing, and keeps it as the first verdict', async () => {
  const scene: Scene = { now: settings({ autoFix: true }) };
  const { called, out } = await run(scene, async (_m, start) => {
    const handle = await start('input-verdict', input('input-verdict', { verdict: APPROVE }));
    // No Signal and no Update: the input is the verdict.
    const state = await until(handle, (s) => s.step === 'waiting-merge', 'the merge wait');
    const again = await handle.executeUpdate(verdictUpdate, { args: [{ ...APPROVE, source: 'cli', reason: 'Again.' }] });
    let refused = '';
    try {
      await handle.executeUpdate(verdictUpdate, { args: [{ ...REJECT, source: 'cli' }] });
    } catch (err) {
      refused = String(((err as Error).cause as Error | undefined)?.message ?? err);
    }
    await handle.terminate('test over');
    return { state, again, refused };
  });
  assert.equal(out.state.verdict?.source, 'file');
  assert.equal(out.state.verdict?.reason, 'In the file.');
  assert.equal(out.state.commitSha, null);
  assert.ok(!called.includes('writeFindingVerdict'), 'the verdict is already in the file');
  assert.equal(out.again.first, false, 'a later verdict of the same status is answered with the first');
  assert.equal(out.again.verdict.reason, 'In the file.');
  assert.match(out.refused, /A verdict is already recorded: approved \(source file\)/);
});

test('a malformed verdict in the input is not a verdict: the run waits at the gate', async () => {
  const scene: Scene = { now: settings() };
  const { out } = await run(scene, async (_m, start) => {
    const bad = { status: 'approved', reason: 'No source.', at: '2026-11-22T09:00:00.000Z' } as unknown as FindingVerdict;
    const handle = await start('input-bad', input('input-bad', { verdict: bad }));
    const state = await until(handle, (s) => s.step === 'waiting-verdict', 'the gate');
    await handle.terminate('test over');
    return state;
  });
  assert.equal(out.verdict, null);
  assert.equal(out.status, 'waiting');
});

test('a run in its merge wait holds a slot and a PR: a decided file does not close it', async () => {
  const scene: Scene = { now: settings({ autoFix: true }) };
  const { count, out } = await run(scene, async (_m, start) => {
    const handle = await start('merge-wait');
    await handle.signal(verdictSignal, APPROVE);
    await until(handle, (s) => s.step === 'waiting-merge', 'the merge wait');
    scene.now = settings({ autoFix: true, status: 'rejected' });
    await env.sleep('3 days');
    const state = await handle.query(findingStateQuery);
    const status = (await handle.describe()).status.name;
    await handle.terminate('test over');
    return { state, status };
  });
  assert.equal(out.status, 'RUNNING');
  assert.equal(out.state.step, 'waiting-merge');
  assert.equal(out.state.prUrl, PR);
  assert.equal(count('readFindingSettings'), 2, 'the settings are read at waiting-fix only');
});

test('an attempt that fails before any issue opens rests a day, then is tried again', async () => {
  const scene: Scene = { now: settings({ autoFix: true }), issues: ['FindingNotFixable', null] };
  const { count, out } = await run(scene, async (m, start) => {
    const handle = await start('retry');
    await handle.signal(verdictSignal, APPROVE);
    const failed = await until(handle, (s) => s.step === 'waiting-fix' && s.fixAttempts === 1, 'the failed attempt');
    assert.equal(failed.lastFixError, 'the fixer refused it');
    assert.equal(failed.issueUrl, null);
    // Real time passes here with no second attempt: the run is in its timer.
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(m.count('openFixIssue'), 1, 'no retry loop');
    assert.equal(m.count('readFindingSettings'), 2, 'no read before the rest');
    await env.sleep('25 hours');
    const state = await until(handle, (s) => s.step === 'waiting-merge', 'the merge wait');
    await handle.terminate('test over');
    return state;
  });
  assert.equal(out.fixAttempts, 2);
  assert.equal(count('openFixIssue'), 2);
});

test('a run started to stop at the verdict goes on when the site fixes findings', async () => {
  const goesOn: Scene = { now: settings() };
  const first = await run(goesOn, async (_m, start) => {
    const handle = await start('verdict-input', {
      site: SITE,
      key: DEFECT_KEY,
      repo: 'mattpyle/argus',
      findingPath: `sites/${SITE}/findings/${DEFECT_KEY}.md`,
      indexPath: `sites/${SITE}/findings/INDEX.md`,
      stopAfter: 'verdict',
    });
    assert.equal((await until(handle, (s) => s.step === 'waiting-verdict', 'the verdict wait')).stopAfter, 'verdict');
    await handle.signal(verdictSignal, APPROVE);
    const state = await until(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    await handle.terminate('test over');
    return state;
  });
  assert.equal(first.out.stopAfter, 'resolved', 'the state names the stop point the run read');
  assert.equal(first.out.verdictMeasure, 'unmeasured: the finding has no checks', 'it measured with the origin it read');
});

test('a site that stops at the verdict ends a resolved-input run there, and its fix signal is ignored', async () => {
  const { called, out } = await run({ now: STOPS_AT_VERDICT }, async (_m, start) => {
    const handle = await start('stops');
    await handle.signal(verdictSignal, APPROVE);
    await handle.signal(fixSignal, FIX);
    return (await skipResult(handle)) as FindingWorkflowResult;
  });
  assert.equal(out.outcome, undefined, 'the result has the shape a verdict-only run always had');
  assert.equal(out.verdict.status, 'approved');
  assert.deepEqual(called, ['readFindingSettings'], 'no measurement, no slot, no issue');
});

test('a rejected verdict reads no settings and records no marker', async () => {
  const { called, out } = await run({ now: settings({ autoFix: true }) }, async (_m, start) => {
    const handle = await start('rejected');
    await handle.signal(verdictSignal, REJECT);
    const result = (await skipResult(handle)) as FindingWorkflowResult;
    return { result, seen: await markers(handle) };
  });
  assert.equal(out.result.outcome, 'rejected');
  assert.deepEqual(called, []);
  assert.deepEqual(out.seen, [], 'no patch marker in the history');
});

test('a settings read that fails is retried, a rejected credential included: the run stays open and makes no attempt meanwhile', async () => {
  const scene: Scene = { now: settings({ autoFix: false }), failFirst: 3 };
  const { count, out } = await run(scene, async (m, start) => {
    const handle = await start('read-fails');
    await handle.signal(verdictSignal, APPROVE);
    const reading = await until(handle, (s) => s.step === 'reading-settings' && m.count('readFindingSettings') >= 1, 'the settings read');
    assert.equal(reading.fixAttempts, 0);
    assert.ok(!m.called.includes('readFinding') && !m.called.includes('openFixIssue'), 'nothing runs on a guess');
    await env.sleep('10 minutes');
    const state = await until(handle, (s) => s.step === 'waiting-fix', 'waiting-fix');
    const status = (await handle.describe()).status.name;
    await handle.terminate('test over');
    return { state, status };
  });
  assert.equal(out.status, 'RUNNING');
  assert.equal(count('readFindingSettings'), 5, 'three failures, the stop point, the decision');
});

test('an input with no stop point is accepted: approved goes on by the settings, rejected ends at the gate', async () => {
  const { out } = await run({ now: settings() }, async (_m, start) => {
    const approved = await start('identity-approved', identityOnly());
    const recorded = await approved.executeUpdate(verdictUpdate, { args: [{ ...APPROVE, source: 'cli' }] });
    const state = await until(approved, (s) => s.step === 'waiting-fix', 'waiting-fix');
    await approved.terminate('test over');

    const rejected = await start('identity-rejected', identityOnly());
    await rejected.signal(verdictSignal, REJECT);
    return { recorded, state, result: (await skipResult(rejected)) as FindingWorkflowResult };
  });
  assert.equal(out.recorded.stopAfter, 'resolved', 'the Update answers before the read, with the start-time value');
  assert.equal(out.state.stopAfter, 'resolved');
  assert.equal(out.result.outcome, 'rejected');
});
