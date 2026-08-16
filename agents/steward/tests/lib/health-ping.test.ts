import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendHealthPing } from '../../src/lib/health-ping.js';

/**
 * The transport, against a real loopback server rather than a stubbed `fetch`.
 *
 * The properties under test are all about what happens when the *other side*
 * misbehaves — a 500, a 404, a socket that never answers — and a stubbed fetch
 * would be a test of the stub. A server on 127.0.0.1 costs milliseconds and
 * exercises the actual request.
 */

interface Received {
  url: string;
  body: string;
  contentType: string | undefined;
}

/** A one-shot server whose responses the test controls per request. */
async function withServer(
  respond: (n: number, res: http.ServerResponse) => void,
  run: (base: string, received: Received[]) => Promise<void>,
): Promise<void> {
  const received: Received[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: req.headers['content-type'],
      });
      respond(n, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}/pingkey`, received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const OK_SHAPE = { ok: true, summary: 'all good' };
const BAD_SHAPE = { ok: false, summary: 'one page could not be audited' };

test('a healthy signal posts the summary to the check slug', async () => {
  await withServer(
    (_n, res) => res.end('OK'),
    async (base, received) => {
      const outcome = await sendHealthPing('nightly-scorecard', OK_SHAPE, base);
      assert.deepEqual(outcome, { signal: 'nightly-scorecard', ok: true, sent: true });
      assert.equal(received[0].url, '/pingkey/steward-nightly-scorecard');
      // The body is what the service quotes into the notification email, so it
      // is the alert a human reads — not a log line.
      assert.equal(received[0].body, 'all good');
      assert.match(received[0].contentType ?? '', /text\/plain/);
    },
  );
});

test('a failed signal posts to /fail under the same slug', async () => {
  await withServer(
    (_n, res) => res.end('OK'),
    async (base, received) => {
      await sendHealthPing('run-shape', BAD_SHAPE, base);
      assert.equal(received[0].url, '/pingkey/steward-run-shape/fail');
      assert.equal(received[0].body, 'one page could not be audited');
    },
  );
});

test('a 500 is retried, and a later attempt that succeeds counts as sent', async () => {
  await withServer(
    (n, res) => {
      if (n < 3) {
        res.statusCode = 500;
        res.end('nope');
        return;
      }
      res.end('OK');
    },
    async (base, received) => {
      const outcome = await sendHealthPing('run-shape', BAD_SHAPE, base);
      assert.equal(outcome.sent, true);
      assert.equal(received.length, 3);
    },
  );
});

test('a 404 is not retried — a missing check is configuration, not an outage', async () => {
  await withServer(
    (_n, res) => {
      res.statusCode = 404;
      res.end('not found');
    },
    async (base, received) => {
      const outcome = await sendHealthPing('run-shape', BAD_SHAPE, base);
      assert.equal(outcome.sent, false);
      assert.equal(received.length, 1);
      assert.match(outcome.reason ?? '', /404/);
      // Names the slug, because the fix is to create a check with that name.
      assert.match(outcome.reason ?? '', /steward-run-shape/);
    },
  );
});

test('a dead service is reported, never thrown', async () => {
  // The load-bearing property: a monitoring outage must not fail a run that
  // measured the site correctly. Port 1 on loopback refuses immediately.
  const outcome = await sendHealthPing('run-shape', BAD_SHAPE, 'http://127.0.0.1:1/key');
  assert.equal(outcome.sent, false);
  assert.ok(outcome.reason);
});

test('an unset base is a silent no-op rather than an error', async () => {
  const outcome = await sendHealthPing('nightly-scorecard', OK_SHAPE, '');
  assert.deepEqual(outcome, {
    signal: 'nightly-scorecard',
    ok: true,
    sent: false,
    reason: 'STEWARD_HEALTHCHECK_BASE is unset',
  });
});

test('a base that is not a URL is refused without a request', async () => {
  const outcome = await sendHealthPing('run-shape', BAD_SHAPE, 'not a url');
  assert.equal(outcome.sent, false);
  assert.ok(outcome.reason);
});

test('a non-http scheme is refused', async () => {
  const outcome = await sendHealthPing('run-shape', BAD_SHAPE, 'file:///tmp/x');
  assert.equal(outcome.sent, false);
  assert.match(outcome.reason ?? '', /http\(s\)/);
});
