import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { resolveFindingIds } from '../../src/activities/finding-ids.js';
import { QUEUE_FINDINGS } from '../../src/config.js';
import { hostedRegistry } from '../../src/hosted-registry.js';
import { parseFindingRef, type FindingRef } from '../../src/lib/finding-ids.js';
import {
  RESOLVE_FINDING_IDS_ACTIVITY,
  type ResolveFindingIdsInput,
  type ResolvedFindingId,
} from '../../src/lib/finding-resolve-contract.js';
import {
  RESOLVE_SCHEDULE_TO_CLOSE_MS,
  RESOLVE_SCHEDULE_TO_START_MS,
  RESOLVE_START_TO_CLOSE_MS,
  ResolverUnavailable,
  createFindingResolver,
  type ResolverClient,
} from '../../src/discord/finding-resolver.js';

/**
 * The id lookup across the process boundary: the Discord service's resolver
 * starts `resolveFindingIds` as a Standalone Activity, and a worker that holds
 * the GitHub credential answers it. The two server tests run the real client
 * call against a dev server and a real worker, with GitHub faked; the rest
 * call the activity, or the resolver over a fake client.
 */

const REPO = 'mattpyle/argus';

function finding(key: string, short: string, titleShort: string): string {
  return ['---', `key: ${key}`, `key_short: ${short}`, `title_short: "${titleShort}"`, 'status: proposed', '---', '', '# A long title', '', 'The body of the finding, which never leaves the worker.'].join('\n');
}

const SEED: Record<string, string> = {
  'sites/mattpyle-com/config.yaml': 'auto_fix: true\n',
  'sites/mattpyle-com/findings/INDEX.md': '# Findings index\n',
  'sites/mattpyle-com/findings/content-first-post--hello-world.md': finding('content-first-post--hello-world', 'MP-121', 'Hello World description calls it the first post'),
  'sites/mattpyle-com/findings/shared-key--home.md': finding('shared-key--home', 'MP-9', 'Shared on mattpyle.com'),
  'sites/temporal-io/findings/shared-key--home.md': finding('shared-key--home', 'TI-5', 'Shared on temporal.io'),
};

let github: FakeGitHub | undefined;
afterEach(() => {
  github?.restore();
  github = undefined;
});

const refs = (...typed: string[]): FindingRef[] => typed.map((each) => parseFindingRef(each) as FindingRef);

const EXPECTED: ResolvedFindingId[] = [
  {
    id: 'MP-121',
    found: { site: 'mattpyle-com', key: 'content-first-post--hello-world', keyShort: 'MP-121', title: 'Hello World description calls it the first post', autoFix: true },
  },
  { id: 'MP-999', missing: true },
  { id: 'shared-key--home', ambiguous: [{ site: 'mattpyle-com', key: 'shared-key--home' }, { site: 'temporal-io', key: 'shared-key--home' }] },
  { id: 'temporal-io/shared-key--home', found: { site: 'temporal-io', key: 'shared-key--home', keyShort: 'TI-5', title: 'Shared on temporal.io', autoFix: false } },
];

test('the activity answers each id with the named fields, a miss or the candidates, and no file text', async () => {
  github = installFakeGitHub({ seed: SEED, defaultBranch: 'main' });
  const resolved = await resolveFindingIds({ ids: ['MP-121', 'MP-999', 'shared-key--home', 'temporal-io/shared-key--home'] });
  assert.deepEqual(resolved, EXPECTED);
  assert.ok(!JSON.stringify(resolved).includes('never leaves the worker'));
  // Reads only, and only of the worker's own findings repository.
  assert.ok(github.calls.every((call) => call.startsWith('GET /git/')));
  assert.deepEqual([...new Set(github.repos)], [REPO]);
});

test('a string that is not an id reaches no path and is a miss; a malformed request is refused', async () => {
  github = installFakeGitHub({ seed: SEED, defaultBranch: 'main' });
  const resolved = await resolveFindingIds({ ids: ['../../secrets', 'mp121', 'sites/x/findings/y.md'] });
  assert.deepEqual(resolved.map((each) => ('found' in each ? each.found.keyShort : 'missing')), ['missing', 'MP-121', 'missing']);
  const before = github.calls.length;
  assert.deepEqual(await resolveFindingIds({ ids: ['not an id'] }), [{ id: 'not an id', missing: true }]);
  assert.equal(github.calls.length, before, 'nothing was read for a request with no id in it');
  await assert.rejects(resolveFindingIds({ ids: Array.from({ length: 26 }, (_, i) => `MP-${i}`) }), /up to 25 ids/);
  await assert.rejects(resolveFindingIds({ ids: 'MP-121' } as unknown as ResolveFindingIdsInput), /up to 25 ids/);
  await assert.rejects(resolveFindingIds({ repo: 'someone/else' } as unknown as ResolveFindingIdsInput), /up to 25 ids/);
});

test('the hosted worker registers the activity on steward-findings, under the name the service calls', () => {
  const findings = hostedRegistry().find((entry) => entry.taskQueue === QUEUE_FINDINGS);
  assert.equal(findings?.activities[RESOLVE_FINDING_IDS_ACTIVITY], resolveFindingIds);
});

test('the resolver starts one standalone activity with short deadlines and a fresh id', async () => {
  const calls: { activity: string; options: Parameters<ResolverClient['activity']['execute']>[1] }[] = [];
  const client: ResolverClient = {
    activity: {
      execute: (async (activity: string, options: Parameters<ResolverClient['activity']['execute']>[1]) => {
        calls.push({ activity, options });
        return options.args[0].ids.map((id) => ({ id, missing: true }));
      }) as ResolverClient['activity']['execute'],
    },
  };
  let n = 0;
  const resolve = createFindingResolver({ client, taskQueue: QUEUE_FINDINGS, newId: () => `id-${++n}` });
  await resolve(refs('mp121', 'TI-5'));
  await resolve(refs('MP-1'));
  assert.equal(calls[0].activity, 'resolveFindingIds');
  assert.deepEqual(calls[0].options, {
    id: 'resolve-finding-ids/id-1',
    taskQueue: 'steward-findings',
    args: [{ ids: ['MP-121', 'TI-5'] }],
    scheduleToStartTimeout: RESOLVE_SCHEDULE_TO_START_MS,
    startToCloseTimeout: RESOLVE_START_TO_CLOSE_MS,
    scheduleToCloseTimeout: RESOLVE_SCHEDULE_TO_CLOSE_MS,
    retry: { maximumAttempts: 2 },
  });
  assert.equal(calls[1].options.id, 'resolve-finding-ids/id-2');
  // Short enough for a person waiting, and well inside the 15 minutes a deferred answer has.
  assert.ok(RESOLVE_SCHEDULE_TO_CLOSE_MS <= 30_000 && RESOLVE_SCHEDULE_TO_START_MS <= 10_000);
});

test('an answer of the wrong shape, or a client that throws, is "could not resolve", not a miss', async () => {
  const wrong: ResolverClient = { activity: { execute: (async () => [{ id: 'MP-1', missing: true }]) as ResolverClient['activity']['execute'] } };
  await assert.rejects(createFindingResolver({ client: wrong, taskQueue: QUEUE_FINDINGS })(refs('MP-1', 'MP-2')), (err: unknown) =>
    err instanceof ResolverUnavailable && err.timedOut === false,
  );
  const down: ResolverClient = { activity: { execute: (async () => Promise.reject(new Error('unavailable'))) as ResolverClient['activity']['execute'] } };
  await assert.rejects(createFindingResolver({ client: down, taskQueue: QUEUE_FINDINGS })(refs('MP-1')), (err: unknown) =>
    err instanceof ResolverUnavailable && err.timedOut === false && (err.cause as Error).message === 'unavailable',
  );
});

// ---------------------------------------------------------------------------
// On a real server
// ---------------------------------------------------------------------------

let env: TestWorkflowEnvironment | undefined;

beforeEach(async () => {
  env = undefined;
});

afterEach(async () => {
  await env?.teardown();
});

test('on a dev server, the resolver gets its answer from a worker through a standalone activity', { timeout: 110_000 }, async () => {
  env = await createLocalEnv();
  github = installFakeGitHub({ seed: SEED, defaultBranch: 'main' });
  const client = new Client({ connection: env.connection, namespace: env.namespace });
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    // The activity as the hosted worker registers it; no workflow bundle is needed to serve it.
    activities: { resolveFindingIds },
    taskQueue: QUEUE_FINDINGS,
  });
  const resolve = createFindingResolver({ client, taskQueue: QUEUE_FINDINGS });
  const resolved = await worker.runUntil(bounded(resolve(refs('mp121', 'MP-999', 'shared-key--home', 'temporal-io/shared-key--home'))));
  assert.deepEqual(resolved, EXPECTED);
});

test('on a dev server with no worker on the queue, the resolver gives up at its deadline and says the worker did not answer', { timeout: 110_000 }, async () => {
  env = await createLocalEnv();
  const client = new Client({ connection: env.connection, namespace: env.namespace });
  const resolve = createFindingResolver({
    client,
    taskQueue: 'nobody-polls-this',
    timeouts: { scheduleToStartMs: 1000, startToCloseMs: 2000, scheduleToCloseMs: 3000 },
  });
  const started = Date.now();
  await assert.rejects(resolve(refs('MP-121')), (err: unknown) => err instanceof ResolverUnavailable && err.timedOut === true);
  assert.ok(Date.now() - started < 15_000);
});
