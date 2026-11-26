import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApplicationFailure } from '@temporalio/activity';

import {
  GITHUB_TIMEOUTS,
  fetchGitHub,
  gh,
  ghResponse,
  ghText,
  resolveGitHubApp,
  resolveGitHubAppForBoot,
} from '../../src/lib/github.js';
import { readRepoFile } from '../../src/lib/github-contents.js';
import {
  FAKE_APP_SLUG,
  FAKE_INSTALLATION_ID,
  installFakeAppCredentials,
  type FakeAppCredentials,
} from '../helpers/fake-github-app.js';

/**
 * What each GitHub answer becomes: the rate limits that arrive as 403 or 429,
 * the errors that stay as they were, a body that is not JSON, and a connection
 * that hangs.
 */

const realFetch = globalThis.fetch;
const realTimeouts = { ...GITHUB_TIMEOUTS };
let app: FakeAppCredentials | undefined;

function restore(): void {
  globalThis.fetch = realFetch;
  app?.restore();
  app = undefined;
}

afterEach(() => {
  restore();
  Object.assign(GITHUB_TIMEOUTS, realTimeouts);
});

/** A fake app in the environment, with `inner` answering every repository call. */
function withApp(inner: typeof fetch): void {
  restore();
  app = installFakeAppCredentials();
  globalThis.fetch = app.wrap(inner);
}

/** A fake app whose every request, the app's own included, goes to `all`. */
function withEverything(all: typeof fetch): FakeAppCredentials {
  restore();
  app = installFakeAppCredentials();
  globalThis.fetch = all;
  return app;
}

function answering(status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  withApp((async () => new Response(text, { status, headers })) as typeof fetch);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  await promise.then(
    () => assert.fail('expected the call to fail'),
    (err) => {
      caught = err;
    },
  );
  assert.ok(caught instanceof Error, String(caught));
  return caught;
}

async function rateLimited(promise: Promise<unknown>): Promise<{ message: string; delayMs: number }> {
  const err = await failure(promise);
  assert.ok(err instanceof ApplicationFailure, String(err));
  assert.equal(err.type, 'RateLimited');
  assert.equal(err.nonRetryable, false);
  return { message: err.message, delayMs: Number(err.nextRetryDelay) };
}

const inSeconds = (seconds: number) => String(Math.floor(Date.now() / 1000) + seconds);
const SECONDARY = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';

for (const status of [403, 429]) {
  test(`a primary rate limit (${status}) waits until x-ratelimit-reset`, async () => {
    answering(status, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': inSeconds(600) });
    const err = await rateLimited(gh('/repos/o/r'));
    assert.ok(err.delayMs > 590_000 && err.delayMs <= 600_000, String(err.delayMs));
    assert.match(err.message, new RegExp(`primary, ${status}`));
  });

  test(`a secondary rate limit (${status}) with retry-after waits that long`, async () => {
    answering(status, { message: 'slow down' }, { 'retry-after': '120' });
    assert.equal((await rateLimited(gh('/repos/o/r'))).delayMs, 120_000);
  });

  test(`a secondary rate limit (${status}) known by its message waits a minute`, async () => {
    answering(status, { message: SECONDARY });
    assert.equal((await rateLimited(gh('/repos/o/r'))).delayMs, 60_000);
  });
}

test('retry-after wins over a spent primary budget', async () => {
  answering(403, { message: 'x' }, { 'retry-after': '90', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': inSeconds(900) });
  assert.equal((await rateLimited(gh('/repos/o/r'))).delayMs, 90_000);
});

test('a bare 429 is rate limited for a minute', async () => {
  answering(429, { message: 'Too Many Requests' });
  assert.equal((await rateLimited(gh('/repos/o/r'))).delayMs, 60_000);
});

test('the delay is held between one minute and one hour, and a header that does not parse is a minute', async () => {
  const cases: Array<[Record<string, string>, number]> = [
    [{ 'retry-after': '1' }, 60_000],
    [{ 'retry-after': '86400' }, 3_600_000],
    [{ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, 60_000],
    [{ 'x-ratelimit-remaining': '0' }, 60_000],
    [{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': inSeconds(-30) }, 60_000],
    [{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': inSeconds(36_000) }, 3_600_000],
  ];
  for (const [headers, delay] of cases) {
    answering(403, { message: 'x' }, headers);
    assert.equal((await rateLimited(gh('/repos/o/r'))).delayMs, delay, JSON.stringify(headers));
  }
});

test('every other answer keeps its type', async () => {
  const cases: Array<[number, string | null, boolean]> = [
    [401, 'AuthError', true],
    [403, 'AuthError', true],
    [404, 'NotFound', true],
    [422, 'UnprocessableRequest', true],
    [409, null, false],
    [500, null, false],
    [502, null, false],
    [503, null, false],
  ];
  for (const [status, type, permanent] of cases) {
    // A 403 with budget left is a permission refusal, not a limit.
    answering(status, { message: 'Resource not accessible by integration' }, { 'x-ratelimit-remaining': '4999' });
    const err = await failure(gh('/repos/o/r'));
    if (type === null) {
      assert.ok(!(err instanceof ApplicationFailure), `${status}: ${String(err)}`);
      assert.match(err.message, new RegExp(`GitHub ${status} for /repos/o/r`));
    } else {
      assert.ok(err instanceof ApplicationFailure, `${status}: ${String(err)}`);
      assert.equal(err.type, type, String(status));
      assert.equal(err.nonRetryable, permanent, String(status));
    }
  }
});

test('a body that is not JSON keeps the status in the message', async () => {
  answering(502, `<html>\n<body>${'Bad gateway. '.repeat(100)}</body></html>`);
  const bad = await failure(gh('/repos/o/r'));
  assert.ok(!(bad instanceof SyntaxError));
  assert.match(bad.message, /^GitHub 502 for \/repos\/o\/r: <html> <body>Bad gateway\./);
  assert.ok(bad.message.length < 300, 'the page is cut short');

  answering(403, '<html>blocked</html>');
  const forbidden = await failure(gh('/repos/o/r'));
  assert.ok(forbidden instanceof ApplicationFailure && forbidden.type === 'AuthError');
  assert.match(forbidden.message, /\(403\): <html>blocked<\/html>/);

  answering(200, '<html>maintenance</html>');
  const ok = await failure(gh('/repos/o/r'));
  assert.ok(!(ok instanceof SyntaxError) && !(ok instanceof ApplicationFailure));
  assert.match(ok.message, /GitHub 200 for \/repos\/o\/r: the body is not JSON/);
});

test('ghResponse and ghText throw a rate limit rather than answer it', async () => {
  answering(403, { message: SECONDARY });
  await rateLimited(ghResponse('/repos/o/r/pulls/1/merge', { method: 'PUT' }));
  await rateLimited(ghText('/repos/o/r/actions/jobs/1/logs'));

  answering(403, { message: 'Required status check is expected' });
  const refused = await ghResponse('/repos/o/r/pulls/1/merge', { method: 'PUT' });
  assert.equal(refused.status, 403);
});

/**
 * A file too large to be inlined, served by `download`. That request carries no
 * token, so it goes round the fake app, which answers 401 to one that has none.
 */
function withDownload(download: typeof fetch): void {
  withApp((async () =>
    new Response(
      JSON.stringify({ encoding: 'none', sha: 's', download_url: 'https://example.invalid/f?token=t' }),
    )) as typeof fetch);
  const api = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith('https://example.invalid/') ? download(input, init) : api(input, init)) as typeof fetch;
}

test('a rate-limited download_url is rate limited', async () => {
  withDownload((async () => new Response('', { status: 429 })) as typeof fetch);
  await rateLimited(readRepoFile('big.json', 'master', 'o/r'));
});

test('a rate-limited token mint: the boot goes on unresolved, and the next call resolves the installation', async () => {
  const fake = withEverything(
    (async () => new Response(JSON.stringify({ message: SECONDARY }), { status: 403 })) as typeof fetch,
  );
  await rateLimited(resolveGitHubApp());
  const boot = await resolveGitHubAppForBoot();
  assert.equal(boot.identity, null);
  assert.match(boot.unresolvedReason ?? '', /GitHub rate limit/);

  globalThis.fetch = fake.wrap((async () => new Response('{"ok":true}')) as typeof fetch);
  assert.deepEqual(await gh('/repos/o/r'), { ok: true });
  assert.ok(fake.appCalls.includes('GET /app/installations'), 'the call resolved the installation');
  assert.deepEqual(await resolveGitHubApp(), { slug: FAKE_APP_SLUG, installationId: FAKE_INSTALLATION_ID });
});

// ---------------------------------------------------------------------------
// A connection that hangs
// ---------------------------------------------------------------------------

test('a call may take 20 seconds, and the job log read 45', () => {
  assert.deepEqual(realTimeouts, { call: 20_000, log: 45_000 });
});

/** A `fetch` that answers after `ms`, and honours the abort signal as the real one does. */
function slow(ms = 30_000): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      // The timer also holds the process open: `AbortSignal.timeout`'s own does not.
      const timer = setTimeout(() => resolve(new Response('log text')), ms);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    })) as typeof fetch;
}

function assertTimedOut(err: Error, what: RegExp): void {
  assert.ok(!(err instanceof ApplicationFailure), 'retryable by the policy');
  assert.match(err.message, /^GitHub call timed out after 0\.05 s: /);
  assert.match(err.message, what);
}

test('a hung repository call, token mint and download_url each end as a timeout', async () => {
  GITHUB_TIMEOUTS.call = 50;

  withApp(slow());
  assertTimedOut(await failure(gh('/repos/o/r')), /GET \/repos\/o\/r$/);

  withEverything(slow());
  assertTimedOut(await failure(resolveGitHubApp()), /GET \/app\/installations/);

  withDownload(slow());
  assertTimedOut(await failure(readRepoFile('big.json', 'master', 'o/r')), /big\.json at master from download_url$/);
});

test('ghText has the longer limit', async () => {
  GITHUB_TIMEOUTS.call = 10;
  GITHUB_TIMEOUTS.log = 5_000;
  withApp(slow(100));
  assert.equal(await ghText('/repos/o/r/actions/jobs/1/logs'), 'log text');
});

test('the real fetch is cut off when the headers or the body never arrive', async () => {
  const server: Server = createServer((req, res) => {
    if (req.url === '/body') {
      res.writeHead(200);
      res.write('half');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ['/headers', '/body']) {
      const err = await failure(fetchGitHub(`${base}${path}`, {}, path, 100));
      assert.equal(err.message, `GitHub call timed out after 0.1 s: ${path}`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
