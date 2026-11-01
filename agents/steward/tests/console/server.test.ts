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
let failLoad: Error | null = null;
const events: string[] = [];
const spawned: number[] = [];

before(async () => {
  server = await startConsoleServer({
    port: 0,
    loadFindings: async () => {
      if (failLoad) {
        const err = failLoad;
        failLoad = null;
        throw err;
      }
      return MODEL;
    },
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
    timeZone: 'America/Vancouver',
    webUi: 'https://web.example',
    namespace: 'ns.test',
    commit: 'abc1234',
    behindMaster: true,
    spawnReplacement: (port) => {
      spawned.push(port);
      // The listener is still open when the replacement starts.
      events.push('spawn');
    },
    exitProcess: () => events.push('exit'),
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
    assert.match(res.body, /<h1>Findings<\/h1>/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
  }
});

test('every response sends referrer-policy same-origin, so the page POST carries its own Origin', async () => {
  for (const path of ['/findings', '/nope']) {
    const res = await consoleRequest({ port: server.port, path });
    assert.equal(res.headers['referrer-policy'], 'same-origin', path);
  }
  const refused = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    origin: 'null',
    json: form(),
  });
  assert.equal(refused.headers['referrer-policy'], 'same-origin');
});

test('a POST whose Origin is the console origin and carries the token is accepted', async () => {
  const res = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    origin: origin(),
    json: form(),
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(sent.length, 1);
});

test('a request whose Host is not loopback is refused, on every path', async () => {
  for (const path of ['/findings', '/', '/fonts/jetbrains-mono-latin.woff2', '/nope']) {
    const res = await consoleRequest({ port: server.port, path, host: 'attacker.example:80' });
    assert.equal(res.status, 403, path);
    assert.match(res.body, /Invalid Host/);
  }
  const post = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    host: 'rebound.example',
    origin: 'http://rebound.example',
    json: form(),
  });
  assert.equal(post.status, 403);
  assert.deepEqual(sent, []);
});

test('a POST without the token, or with a wrong one, is refused and sends nothing', async () => {
  const { token: _token, ...noToken } = form();
  const missing = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    origin: origin(),
    json: noToken,
  });
  assert.equal(missing.status, 403);
  assert.match(missing.body, /token/);
  const wrong = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    origin: origin(),
    json: form({ token: `${server.token.slice(0, -1)}x` }),
  });
  assert.equal(wrong.status, 403);
  assert.deepEqual(sent, []);
});

test('a POST with a foreign Origin, or none, is refused even with the token', async () => {
  for (const o of ['https://evil.example', `http://localhost:${server.port}`, 'null', null]) {
    const res = await consoleRequest({
      port: server.port,
      path: '/api/verdict',
      method: 'POST',
      origin: o,
      json: form(),
    });
    assert.equal(res.status, 403, String(o));
    assert.match(res.body, /Origin/);
  }
  assert.deepEqual(sent, []);
});

test('a reject needs a reason; an approve without one takes the console reason', async () => {
  const reject = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    origin: origin(),
    json: form({ reason: '   ' }),
  });
  assert.equal(reject.status, 400);
  assert.match(reject.body, /needs a reason/);
  assert.deepEqual(sent, []);

  const approve = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    origin: origin(),
    json: form({ verdict: 'approved', reason: '' }),
  });
  assert.equal(approve.status, 200, approve.body);
  assert.deepEqual(sent, [
    { site: 'mattpyle-com', key: 'ux-thing--about', status: 'approved', reason: CONSOLE_APPROVE_REASON },
  ]);
  assert.equal(JSON.parse(approve.body).commitSha, 'abc1234');
  assert.match(JSON.parse(approve.body).nextStep, /steward finding fix k/);
});

test('a slug that could traverse, or an unknown verdict, is refused before the sender', async () => {
  const cases: Record<string, string>[] = [{ key: '../../etc' }, { site: 'a/b' }, { verdict: 'maybe' }];
  for (const extra of cases) {
    const res = await consoleRequest({
      port: server.port,
      path: '/api/verdict',
      method: 'POST',
      origin: origin(),
      json: form(extra),
    });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  assert.deepEqual(sent, []);
});

test('a verdict for a finding with no open run comes back as the refusal the CLI prints', async () => {
  refuseNext = 'No open workflow finding/mattpyle-com/ux-thing--about. `steward finding list` shows the open ones.';
  const res = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    origin: origin(),
    json: form(),
  });
  assert.equal(res.status, 409);
  assert.match(res.body, /No open workflow finding\/mattpyle-com\/ux-thing--about/);
});

test('the page, its stylesheet, its script and its icons are served with their types under the CSP', async () => {
  const cases: [string, RegExp][] = [
    ['/findings', /^text\/html; charset=utf-8$/],
    ['/findings.css', /^text\/css; charset=utf-8$/],
    ['/findings.js', /^text\/javascript; charset=utf-8$/],
    ['/icons/steward-console.svg', /^image\/svg\+xml$/],
    ['/icons/temporal-io.svg', /^image\/svg\+xml$/],
    ['/icons/mattpyle-com-16.png', /^image\/png$/],
  ];
  for (const [path, type] of cases) {
    const res = await consoleRequest({ port: server.port, path });
    assert.equal(res.status, 200, path);
    assert.match(String(res.headers['content-type']), type, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/, path);
    assert.equal((await consoleRequest({ port: server.port, path, host: 'evil.example' })).status, 403, path);
  }
  const page = await consoleRequest({ port: server.port, path: '/findings' });
  const csp = String(page.headers['content-security-policy']);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /img-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  // Nothing inline: one stylesheet and one script, both from the console's own paths.
  assert.match(page.body, /<link rel="stylesheet" href="\/findings\.css">/);
  assert.match(page.body, /<script src="\/findings\.js" defer><\/script>/);
  assert.match(page.body, /<link rel="icon" href="\/icons\/steward-console\.svg" type="image\/svg\+xml">/);
  assert.doesNotMatch(page.body, /<style|<script>| style="| on[a-z]+="/i);
  assert.match(page.body, /data-time-zone="America\/Vancouver"/);
  // The phase-one script is gone.
  assert.equal((await consoleRequest({ port: server.port, path: '/console.js' })).status, 404);
  assert.equal((await consoleRequest({ port: server.port, path: '/favicon.svg' })).status, 404);
});

test('/, /finding and /findings/ redirect to /findings', async () => {
  for (const path of ['/', '/finding', '/findings/']) {
    const res = await consoleRequest({ port: server.port, path });
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.location, '/findings', path);
  }
});

test('the verdict form route is gone, and a form body is refused on the JSON route', async () => {
  const gone = await consoleRequest({ port: server.port, path: '/findings/verdict', method: 'POST', origin: origin(), form: form() });
  assert.equal(gone.status, 404);
  const asForm = await consoleRequest({ port: server.port, path: '/api/verdict', method: 'POST', origin: origin(), form: form() });
  assert.equal(asForm.status, 415);
  assert.deepEqual(sent, []);
});

test('the page carries the zone, the Web UI and the namespace for the script', async () => {
  const page = await consoleRequest({ port: server.port, path: '/findings' });
  assert.match(page.body, /data-web-ui="https:\/\/web\.example"/);
  assert.match(page.body, /data-namespace="ns\.test"/);
  assert.doesNotMatch(page.body, /\{\{/);
});

test('an unexpected failure on an API route answers a fixed sentence and logs the real error', async () => {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args);
  failLoad = new Error('boom: secret detail from GitHub');
  try {
    const res = await consoleRequest({ port: server.port, path: '/api/findings' });
    assert.equal(res.status, 502);
    assert.doesNotMatch(res.body, /boom|secret/);
    assert.match(JSON.parse(res.body).error, /could not complete the request/);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(String(lines[0].at(-1)), /boom: secret detail/);
  // A refusal still passes its own message through.
  const refused = await consoleRequest({ port: server.port, path: '/api/findings', method: 'POST' });
  assert.equal(refused.status, 405);
  assert.match(JSON.parse(refused.body).error, /GET only/);
});

test('the verdict endpoint takes POST only, and an unknown path is a 404', async () => {
  assert.equal((await consoleRequest({ port: server.port, path: '/api/verdict' })).status, 405);
  assert.equal((await consoleRequest({ port: server.port, path: '/fonts/../../.env' })).status, 404);
  assert.equal((await consoleRequest({ port: server.port, path: '/elsewhere' })).status, 404);
});

test('GET /api/findings serves the running commit and whether master has moved on', async () => {
  const res = await consoleRequest({ port: server.port, path: '/api/findings' });
  const body = JSON.parse(res.body);
  assert.equal(body.commit, 'abc1234');
  assert.equal(body.behindMaster, true);
});

test('the page has one menu button beside Refresh and loads nothing else new', async () => {
  const res = await consoleRequest({ port: server.port, path: '/findings' });
  assert.match(res.body, /class="menu-btn"[^>]*aria-haspopup="menu"/);
  assert.match(res.body, /class="head-tools"/);
});

test('POST /api/restart refuses GET, a foreign Origin, a missing Origin and a missing token, and starts nothing', async () => {
  const restart = (extra: Omit<Parameters<typeof consoleRequest>[0], 'port' | 'path'>) => consoleRequest({ port: server.port, path: '/api/restart', ...extra });
  assert.equal((await restart({})).status, 405);
  assert.equal((await restart({ method: 'POST', origin: 'http://evil.example', json: { token: server.token } })).status, 403);
  assert.equal((await restart({ method: 'POST', json: { token: server.token } })).status, 403);
  assert.equal((await restart({ method: 'POST', origin: origin(), json: {} })).status, 403);
  assert.equal((await restart({ method: 'POST', origin: origin(), json: { token: 'wrong' } })).status, 403);
  assert.deepEqual(spawned, []);
  assert.deepEqual(events, []);
  // The console is still up.
  assert.equal((await consoleRequest({ port: server.port, path: '/api/findings' })).status, 200);
});
