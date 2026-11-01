import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { consoleRequest } from '../helpers/console-request.js';
import { CONSOLE_RESTART_STUBS } from '../helpers/console-options.js';
import { startConsoleServer, type ConsoleServer } from '../../src/console/server.js';
import { FixRefused } from '../../src/lib/finding-fix.js';
import { VerifyRefused } from '../../src/lib/finding-verify.js';
import type { FindingsModel } from '../../src/console/findings-model.js';

/**
 * `POST /api/run/sync|fix|verify` over real sockets with recording doubles for the three functions the
 * CLI shares: the guards run first and a refused request never reaches a verb; sync answers counts, fix
 * and verify answer the workflow id, and a refusal the CLI would print comes back as 409.
 */

const MODEL: FindingsModel = {
  generatedAt: '2026-11-01T12:00:00.000Z',
  repo: 'test/argus',
  sites: [],
  failedVerifies: [],
  cost: { treeCalls: 0, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
};

const calls: string[] = [];
let refuse: Error | null = null;
let server: ConsoleServer;

before(async () => {
  server = await startConsoleServer({
    port: 0,
    ...CONSOLE_RESTART_STUBS,
    loadFindings: async () => MODEL,
    sendVerdict: async () => {
      throw new Error('no verdict in this test');
    },
    runSync: async () => {
      calls.push('sync');
      if (refuse) throw refuse;
      return {
        triggered: true,
        workflowId: 'steward-findings-reconcile-scheduled-2026-11-01',
        sites: { 'mattpyle-com': { started: 1, signalled: 2, fixed: 0, unchanged: 7 } },
        total: { started: 1, signalled: 2, fixed: 0, unchanged: 7 },
      };
    },
    runFix: async (site, key) => {
      calls.push(`fix ${site}/${key}`);
      if (refuse) throw refuse;
      return { workflowId: `finding/${site}/${key}`, webUrl: 'https://web.example/x', nextStep: 'It opens an issue.' };
    },
    runVerify: async (site, key) => {
      calls.push(`verify ${site}/${key}`);
      if (refuse) throw refuse;
      return { workflowId: `verify/${site}/${key}/stamp`, webUrl: 'https://web.example/y', nextStep: 'Production is being measured.' };
    },
    timeZone: 'America/Vancouver',
    webUi: 'https://web.example',
    namespace: 'ns.test',
  });
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  calls.length = 0;
  refuse = null;
});

const origin = () => `http://127.0.0.1:${server.port}`;
const post = (verb: string, json: Record<string, unknown>, extra: { origin?: string | null } = {}) =>
  consoleRequest({
    port: server.port,
    path: `/api/run/${verb}`,
    method: 'POST',
    origin: extra.origin === undefined ? origin() : extra.origin,
    json,
  });
const FIELDS = { site: 'mattpyle-com', key: 'ux-thing--about' };

test('each run route refuses a foreign Origin, a missing Origin and a missing or wrong token, before the verb runs', async () => {
  for (const verb of ['sync', 'fix', 'verify']) {
    const foreign = await post(verb, { token: server.token, ...FIELDS }, { origin: 'http://evil.example' });
    assert.equal(foreign.status, 403, verb);
    const none = await post(verb, { token: server.token, ...FIELDS }, { origin: null });
    assert.equal(none.status, 403, verb);
    const noToken = await post(verb, { ...FIELDS });
    assert.equal(noToken.status, 403, verb);
    const wrong = await post(verb, { token: 'nope', ...FIELDS });
    assert.equal(wrong.status, 403, verb);
  }
  assert.deepEqual(calls, []);
});

test('a run route takes POST only, and JSON only', async () => {
  const get = await consoleRequest({ port: server.port, path: '/api/run/sync' });
  assert.equal(get.status, 405);
  const form = await consoleRequest({ port: server.port, path: '/api/run/sync', method: 'POST', origin: origin(), form: { token: server.token } });
  assert.equal(form.status, 415);
  assert.deepEqual(calls, []);
});

test('sync answers the reconcile counts and a one-line summary', async () => {
  const res = await post('sync', { token: server.token });
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.total, { started: 1, signalled: 2, fixed: 0, unchanged: 7 });
  assert.equal(body.sites['mattpyle-com'].signalled, 2);
  assert.equal(body.summary, 'Started 1, signalled 2, fixed 0, unchanged 7.');
  assert.deepEqual(calls, ['sync']);
});

test('fix and verify answer the workflow id and the next step', async () => {
  const fix = JSON.parse((await post('fix', { token: server.token, ...FIELDS })).body);
  assert.equal(fix.workflowId, 'finding/mattpyle-com/ux-thing--about');
  assert.equal(fix.nextStep, 'It opens an issue.');
  const verify = JSON.parse((await post('verify', { token: server.token, ...FIELDS })).body);
  assert.equal(verify.workflowId, 'verify/mattpyle-com/ux-thing--about/stamp');
  assert.deepEqual(calls, ['fix mattpyle-com/ux-thing--about', 'verify mattpyle-com/ux-thing--about']);
});

test('a refusal the CLI would print comes back as 409 with its message', async () => {
  refuse = new FixRefused('ux-thing--about is fixing and the PR is still open. Merge or close it first.');
  const fix = await post('fix', { token: server.token, ...FIELDS });
  assert.equal(fix.status, 409);
  assert.equal(JSON.parse(fix.body).error, 'ux-thing--about is fixing and the PR is still open. Merge or close it first.');
  refuse = new VerifyRefused('https://github.com/x/y/pull/1 is open, not merged, so its fix is not on production.');
  const verify = await post('verify', { token: server.token, ...FIELDS });
  assert.equal(verify.status, 409);
  assert.match(JSON.parse(verify.body).error, /not merged/);
});

test('fix and verify refuse a site or key that is not a finding slug, and an unexpected failure is a fixed sentence', async () => {
  const bad = await post('fix', { token: server.token, site: 'mattpyle-com', key: '../etc' });
  assert.equal(bad.status, 400);
  const missing = await post('verify', { token: server.token });
  assert.equal(missing.status, 400);
  assert.deepEqual(calls, []);
  refuse = new Error('Temporal is down: secret detail');
  const failed = await post('sync', { token: server.token });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(failed.body, /secret detail/);
});
