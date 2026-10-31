import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { consoleRequest } from '../helpers/console-request.js';
import { startConsoleServer, type ConsoleServer } from '../../src/console/server.js';
import {
  CONSOLE_APPROVE_REASON,
  FindingVerdictError,
  buildFindingVerdict,
  type FindingVerdictRequest,
} from '../../src/lib/finding-verdict.js';
import type { FindingsModel } from '../../src/console/findings-model.js';

/**
 * The console's guards over real sockets, with no Temporal and no GitHub: the
 * page loader returns an empty model, and the verdict sender records what it
 * was asked. A refused request must never reach the sender.
 */

const MODEL: FindingsModel = {
  generatedAt: '2026-10-31T12:00:00.000Z',
  repo: 'test/argus',
  sites: [],
  failedVerifies: [],
  cost: { treeCalls: 1, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
};

let server: ConsoleServer;
let sent: FindingVerdictRequest[] = [];
let refuseNext: string | null = null;

before(async () => {
  server = await startConsoleServer({
    port: 0,
    loadFindings: async () => MODEL,
    sendVerdict: async (request) => {
      if (refuseNext) {
        const message = refuseNext;
        refuseNext = null;
        throw new FindingVerdictError('no-run', message);
      }
      sent.push(request);
      return {
        workflowId: `finding/${request.site}/${request.key}`,
        sent: buildFindingVerdict(request.status, request.reason),
        recorded: buildFindingVerdict(request.status, request.reason),
        commitSha: 'abc1234',
        nextStep: request.status === 'approved' ? 'The workflow waits for `steward finding fix k`.' : null,
        nextStepError: null,
        webUrl: 'https://cloud.temporal.io/namespaces/x/workflows/y',
      };
    },
    page: { timeZone: 'America/Vancouver', webUi: 'https://cloud.temporal.io', namespace: 'x' },
  });
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  sent = [];
});

const origin = () => `http://127.0.0.1:${server.port}`;
const form = (extra: Record<string, string> = {}) => ({
  token: server.token,
  site: 'mattpyle-com',
  key: 'ux-thing--about',
  verdict: 'rejected',
  reason: 'Duplicate of another finding.',
  ...extra,
});

test('the listener is on 127.0.0.1 and the page renders for a loopback Host', async () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/findings$/);
  for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
    const res = await consoleRequest({ port: server.port, path: '/findings', host });
    assert.equal(res.status, 200, host);
    assert.match(res.body, /Steward console/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
  }
});

test('a request whose Host is not loopback is refused, on every path', async () => {
  for (const path of ['/findings', '/', '/fonts/jetbrains-mono-latin.woff2', '/nope']) {
    const res = await consoleRequest({ port: server.port, path, host: 'attacker.example:80' });
    assert.equal(res.status, 403, path);
    assert.match(res.body, /Invalid Host/);
  }
  const post = await consoleRequest({
    port: server.port,
    path: '/findings/verdict',
    method: 'POST',
    host: 'rebound.example',
    origin: 'http://rebound.example',
    form: form(),
  });
  assert.equal(post.status, 403);
  assert.deepEqual(sent, []);
});

test('a POST without the token, or with a wrong one, is refused and sends nothing', async () => {
  const { token: _token, ...noToken } = form();
  const missing = await consoleRequest({
    port: server.port,
    path: '/findings/verdict',
    method: 'POST',
    origin: origin(),
    form: noToken,
  });
  assert.equal(missing.status, 403);
  assert.match(missing.body, /token/);
  const wrong = await consoleRequest({
    port: server.port,
    path: '/findings/verdict',
    method: 'POST',
    origin: origin(),
    form: form({ token: `${server.token.slice(0, -1)}x` }),
  });
  assert.equal(wrong.status, 403);
  assert.deepEqual(sent, []);
});

test('a POST with a foreign Origin, or none, is refused even with the token', async () => {
  for (const o of ['https://evil.example', `http://localhost:${server.port}`, 'null', null]) {
    const res = await consoleRequest({
      port: server.port,
      path: '/findings/verdict',
      method: 'POST',
      origin: o,
      form: form(),
    });
    assert.equal(res.status, 403, String(o));
    assert.match(res.body, /Origin/);
  }
  assert.deepEqual(sent, []);
});

test('a reject needs a reason; an approve without one takes the console reason', async () => {
  const reject = await consoleRequest({
    port: server.port,
    path: '/findings/verdict',
    method: 'POST',
    origin: origin(),
    form: form({ reason: '   ' }),
  });
  assert.equal(reject.status, 400);
  assert.match(reject.body, /needs a reason/);
  assert.deepEqual(sent, []);

  const approve = await consoleRequest({
    port: server.port,
    path: '/findings/verdict',
    method: 'POST',
    origin: origin(),
    form: form({ verdict: 'approved', reason: '' }),
  });
  assert.equal(approve.status, 200, approve.body);
  assert.deepEqual(sent, [
    { site: 'mattpyle-com', key: 'ux-thing--about', status: 'approved', reason: CONSOLE_APPROVE_REASON },
  ]);
  assert.match(approve.body, /commit: <code>abc1234<\/code>/);
  assert.match(approve.body, /steward finding fix k/);
});

test('a slug that could traverse, or an unknown verdict, is refused before the sender', async () => {
  const cases: Record<string, string>[] = [{ key: '../../etc' }, { site: 'a/b' }, { verdict: 'maybe' }];
  for (const extra of cases) {
    const res = await consoleRequest({
      port: server.port,
      path: '/findings/verdict',
      method: 'POST',
      origin: origin(),
      form: form(extra),
    });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  assert.deepEqual(sent, []);
});

test('a verdict for a finding with no open run comes back as the refusal the CLI prints', async () => {
  refuseNext = 'No open workflow finding/mattpyle-com/ux-thing--about. `steward finding list` shows the open ones.';
  const res = await consoleRequest({
    port: server.port,
    path: '/findings/verdict',
    method: 'POST',
    origin: origin(),
    form: form(),
  });
  assert.equal(res.status, 409);
  assert.match(res.body, /No open workflow finding\/mattpyle-com\/ux-thing--about/);
});

test('the verdict endpoint takes POST only, and an unknown path is a 404', async () => {
  assert.equal((await consoleRequest({ port: server.port, path: '/findings/verdict' })).status, 405);
  assert.equal((await consoleRequest({ port: server.port, path: '/fonts/../../.env' })).status, 404);
  assert.equal((await consoleRequest({ port: server.port, path: '/elsewhere' })).status, 404);
});
