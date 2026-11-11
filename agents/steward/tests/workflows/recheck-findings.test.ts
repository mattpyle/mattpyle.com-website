import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { bounded, createTestEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { recheckFindingsWorkflow } from '../../src/workflows/recheck-findings.js';
import { readFindingsIndex } from '../../src/activities/findings.js';
import { readRecheckBlock, readSiteHosts, writeFindingRecheck } from '../../src/activities/findings-recheck.js';
import type { RunFindingChecksInput, RunFindingChecksResult } from '../../src/activities/verify-finding.js';
import { findingWorkflowId, parseFindingsIndex, type OpenFindingWorkflow } from '../../src/lib/findings.js';
import { checkUrls } from '../../src/lib/verify-checks.js';
import { summariseRecheck } from '../../src/lib/findings-recheck.js';

/**
 * `recheckFindingsWorkflow` against the real test server, on a fixture store:
 * the fake GitHub holds a site's `config.yaml`, `INDEX.md` and finding files,
 * and the recheck's own activities read and write it for real. The checks and
 * the open-run list are mocked: a check passes when its URL has no `/broken`,
 * and fails to measure when it has `/down`.
 *
 * One test server per test, and one result awaited per test, as
 * `agents/steward/CLAUDE.md` asks. A plain client: nothing here needs time to
 * move past a retry.
 */

const QUEUE = 'steward-findings';
const REPO = 'mattpyle/argus';
const SITE = 'temporal-io';
const DIR = `sites/${SITE}/findings`;
// 03:30 UTC on the 9th is the evening of the 8th in Vancouver: live_on must say the 8th.
const RAN_AT = '2026-11-09T03:30:00.000Z';

let env: TestWorkflowEnvironment;
let client: Client;
let github: FakeGitHub | undefined;

beforeEach(async () => {
  env = await createTestEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  github?.restore();
  github = undefined;
  await env?.teardown();
});

const CONFIG = [
  'site:',
  '  name: temporal.io',
  '  url: https://temporal.io',
  '  hosts:',
  '    - temporal.io',
  '    - docs.temporal.io',
  '  stop_after: verdict',
  '',
].join('\n');

function finding(key: string, short: string, verify: string | null, extra: string[] = []): string {
  return [
    '---',
    `key: ${key}`,
    `key_short: ${short}`,
    'status: approved',
    'importance: low',
    'importance_reason: "why"',
    'evidence: read',
    'lives_in: page',
    ...extra,
    'resolved_run:',
    ...(verify === null ? [] : [verify]),
    '---',
    '',
    `# ${key}`,
    '',
    'Body.',
    '',
  ].join('\n');
}

const status = (url: string) => `verify:\n  - url: "${url}"\n    kind: "status"\n    expect: 200`;

const FILES: Record<string, string> = {
  'fixed-on-site': finding('fixed-on-site', 'TI-1', status('https://temporal.io/llms.txt')),
  'live-on-docs': finding('live-on-docs', 'TI-2', status('https://docs.temporal.io/broken')),
  'no-block': finding('no-block', 'TI-3', null),
  'empty-block': finding('empty-block', 'TI-4', 'verify: []'),
  'off-host': finding('off-host', 'TI-5', status('https://learn.temporal.io/x')),
  'site-down': finding('site-down', 'TI-6', status('https://docs.temporal.io/down')),
  'has-run': finding('has-run', 'TI-7', status('https://temporal.io/broken')),
  'already-live': finding('already-live', 'TI-8', status('https://temporal.io/broken'), ['live_on: 2026-11-08', 'live_by: check']),
  // Argus's verify labelled this one `review` on an earlier day; a failing recheck takes the label over.
  'review-labelled': finding('review-labelled', 'TI-9', status('https://temporal.io/broken'), ['live_on: 2026-11-07', 'live_by: review']),
};

function seed(keys: string[] = Object.keys(FILES)): Record<string, string> {
  const lines = keys.map((key) => `${key} | approved | defect | s | title | reason`);
  lines.push('still-proposed | proposed | defect | s | title |');
  const index = ['# Findings index', '', 'One line per finding: `key | status | kind | scenario | title | verdict reason`.', '', ...lines, ''].join('\n');
  const files: Record<string, string> = { [`sites/${SITE}/config.yaml`]: CONFIG, [`${DIR}/INDEX.md`]: index };
  for (const key of keys) files[`${DIR}/${key}.md`] = FILES[key]!;
  return files;
}

function activities(open: string[] = [], overrides: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const pings: Array<{ signal: string; shape: { ok: boolean; summary: string } }> = [];
  return {
    ran,
    pings,
    activities: {
      reportRunHealth: async (input: { signal: string; shape: { ok: boolean; summary: string } }) => {
        pings.push(input);
        return { signal: input.signal, ok: input.shape.ok, sent: true };
      },
      readSiteHosts,
      readFindingsIndex,
      readRecheckBlock,
      writeFindingRecheck,
      listOpenFindingWorkflows: async (): Promise<OpenFindingWorkflow[]> =>
        open.map((workflowId) => ({ workflowId, step: 'waiting-fix', fixAttempts: 0, issueUrl: null })),
      runFindingChecks: async (input: RunFindingChecksInput): Promise<RunFindingChecksResult> => {
        ran.push(input.key);
        const urls = input.checks.flatMap((check) => checkUrls(check.url));
        if (urls.some((url) => url.includes('/down'))) {
          throw ApplicationFailure.nonRetryable(`${urls[0]} answered 503`, 'CheckUnavailable');
        }
        const results = input.checks.map((check, i) => {
          const pass = !checkUrls(check.url).some((url) => url.includes('/broken'));
          return { n: i + 1, url: check.url, kind: check.kind, pass, expected: 'status 200', measured: pass ? 'status 200' : 'status 404' };
        });
        return { ranAt: RAN_AT, passed: results.every((row) => row.pass), results };
      },
      ...overrides,
    },
  };
}

async function run(acts: Record<string, unknown>) {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    workflowBundle: await workflowBundle(),
    activities: acts,
    taskQueue: QUEUE,
  });
  return worker.runUntil(
    bounded(
      client.workflow.execute(recheckFindingsWorkflow, {
        workflowId: `recheck/${SITE}/test`,
        taskQueue: QUEUE,
        args: [{ repo: REPO, site: SITE }],
      }),
    ),
  );
}

const file = (key: string) => github!.branches.get('main')!.get(`${DIR}/${key}.md`)!.text;

test('each approved finding gets one outcome, and only a still-present or fixed one is written', async () => {
  github = installFakeGitHub({ seed: seed(), defaultBranch: 'main' });
  const { activities: acts, ran, pings } = activities([findingWorkflowId(SITE, 'has-run')]);
  const result = await run(acts);

  const outcomes = Object.fromEntries(result.rows.map((row) => [row.key, row.outcome]));
  assert.deepEqual(outcomes, {
    'fixed-on-site': 'resolved',
    'live-on-docs': 'still present',
    'no-block': 'no checks',
    'empty-block': 'no checks',
    'off-host': 'could not measure',
    'site-down': 'could not measure',
    'has-run': 'has an open run',
    'already-live': 'still present',
    'review-labelled': 'still present',
  });
  assert.ok(!('still-proposed' in outcomes), 'a proposed finding is not rechecked');
  assert.equal(result.rows.find((row) => row.key === 'fixed-on-site')?.keyShort, 'TI-1');
  assert.match(result.rows.find((row) => row.key === 'off-host')!.detail!, /refused: .*learn\.temporal\.io/);
  assert.match(result.rows.find((row) => row.key === 'site-down')!.detail!, /answered 503/);

  // Resolved: the file carries the measurement, and the index line agrees.
  const fixed = file('fixed-on-site');
  assert.match(fixed, /^status: resolved$/m);
  assert.match(fixed, /^resolved_run: 2026-11-09T0330Z$/m);
  assert.match(fixed, /## Verification\n\nSteward ran this finding's checks against production at 2026-11-09T03:30:00.000Z\. Outcome: resolved\. Workflow `recheck\/temporal-io\/test`\./);
  assert.match(fixed, /1\. Pass, `status` on https:\/\/temporal\.io\/llms\.txt\. Expected: status 200\. Measured: status 200\./);
  const index = parseFindingsIndex(github.branches.get('main')!.get(`${DIR}/INDEX.md`)!.text);
  assert.equal(index.find((line) => line.key === 'fixed-on-site')?.status, 'resolved');
  assert.equal(index.find((line) => line.key === 'live-on-docs')?.status, 'approved');

  // Still present, on a declared host: live_on is the Vancouver day, after lives_in, with live_by: check after it.
  assert.equal(file('live-on-docs'), FILES['live-on-docs'].replace('lives_in: page\n', 'lives_in: page\nlive_on: 2026-11-08\nlive_by: check\n'));
  // A finding Argus labelled `review` reads `check` afterwards, as the one live_by line.
  assert.equal(
    file('review-labelled'),
    FILES['review-labelled'].replace('live_on: 2026-11-07\nlive_by: review\n', 'live_on: 2026-11-08\nlive_by: check\n'),
  );
  assert.equal(file('review-labelled').match(/^live_by:/gm)!.length, 1);

  // Nothing written for the rest; the open run's finding was never measured.
  for (const key of ['no-block', 'empty-block', 'off-host', 'site-down', 'has-run', 'already-live']) {
    assert.equal(file(key), FILES[key], `${key} is unchanged`);
  }
  assert.ok(!ran.includes('has-run'), 'a finding with an open run is not measured');
  assert.equal(result.rows.find((row) => row.key === 'already-live')?.commitSha, null, 'the same day writes no commit');

  // One commit per changed finding: the resolve and the two live_on writes.
  assert.equal(github.refUpdates.length, 3);
  assert.ok(github.refUpdates.every((update) => update.branch === 'main' && !update.force));

  // The fixture holds two findings production could not be asked about, so the
  // run pings /fail on the site's own check: the summary first, then the rows.
  assert.equal(pings.length, 1);
  assert.equal(pings[0]!.signal, 'findings-recheck:temporal-io');
  assert.equal(pings[0]!.shape.ok, false);
  assert.ok(pings[0]!.shape.summary.startsWith(summariseRecheck(result)));
  assert.match(pings[0]!.shape.summary, /2 of 9 finding\(s\) were not rechecked cleanly: TI-5 could not measure .*; TI-6 could not measure \(.*answered 503/);
});

test('a run whose rows are all resolved, still present, no checks or open pings healthy with the summary', async () => {
  const keys = ['fixed-on-site', 'live-on-docs', 'no-block', 'empty-block', 'has-run'];
  github = installFakeGitHub({ seed: seed(keys), defaultBranch: 'main' });
  const { activities: acts, pings } = activities([findingWorkflowId(SITE, 'has-run')]);
  const result = await run(acts);

  assert.equal(result.rows.length, 5);
  assert.deepEqual(pings, [
    {
      signal: 'findings-recheck:temporal-io',
      shape: { ok: true, summary: summariseRecheck(result) },
    },
  ]);
  assert.match(pings[0]!.shape.summary, /^Findings recheck of temporal-io: 5 approved, /);
});

test('a check that could not be measured pings /fail and names the finding', async () => {
  github = installFakeGitHub({ seed: seed(['fixed-on-site', 'site-down']), defaultBranch: 'main' });
  const { activities: acts, pings } = activities();
  const result = await run(acts);

  assert.deepEqual(result.rows.map((row) => row.outcome), ['resolved', 'could not measure']);
  assert.equal(pings.length, 1);
  assert.equal(pings[0]!.shape.ok, false);
  assert.match(pings[0]!.shape.summary, /^Findings recheck of temporal-io: 2 approved, resolved 1, could not measure 1\. 1 of 2 finding\(s\) were not rechecked cleanly: TI-6 could not measure \(.*answered 503\)/);
});

test('a write that failed pings /fail and names the finding', async () => {
  github = installFakeGitHub({ seed: seed(['fixed-on-site']), defaultBranch: 'main' });
  const { activities: acts, pings } = activities([], {
    writeFindingRecheck: async () => {
      throw ApplicationFailure.nonRetryable('the branch moved', 'FindingMoved');
    },
  });
  const result = await run(acts);

  assert.deepEqual(result.rows.map((row) => row.outcome), ['write failed']);
  assert.equal(pings.length, 1);
  assert.equal(pings[0]!.shape.ok, false);
  assert.match(pings[0]!.shape.summary, /1 of 1 finding\(s\) were not rechecked cleanly: TI-1 write failed \(the branch moved\)/);
});

test('a run that fails pings the failure endpoint with the reason, and still fails', async () => {
  github = installFakeGitHub({ seed: seed(), defaultBranch: 'main' });
  const { activities: acts, pings } = activities([], {
    readFindingsIndex: async () => {
      throw ApplicationFailure.nonRetryable('INDEX.md is unreadable', 'StoreLayout');
    },
  });
  await assert.rejects(run(acts), (err: Error) => err.name === 'WorkflowFailedError');

  assert.equal(pings.length, 1);
  assert.equal(pings[0]!.signal, 'findings-recheck:temporal-io');
  assert.equal(pings[0]!.shape.ok, false);
  assert.match(pings[0]!.shape.summary, /Findings recheck of temporal-io against mattpyle\/argus failed: INDEX\.md is unreadable/);
});

test('a finding with an open finding workflow is reported and left alone, even when its checks would pass', async () => {
  github = installFakeGitHub({ seed: seed(), defaultBranch: 'main' });
  const { activities: acts, ran } = activities([findingWorkflowId(SITE, 'fixed-on-site')]);
  const result = await run(acts);

  const row = result.rows.find((each) => each.key === 'fixed-on-site');
  assert.equal(row?.outcome, 'has an open run');
  assert.match(row!.detail!, /finding\/temporal-io\/fixed-on-site|fixed-on-site/);
  assert.ok(!ran.includes('fixed-on-site'));
  assert.equal(file('fixed-on-site'), FILES['fixed-on-site']);
  const index = parseFindingsIndex(github.branches.get('main')!.get(`${DIR}/INDEX.md`)!.text);
  assert.equal(index.find((line) => line.key === 'fixed-on-site')?.status, 'approved');
});
