import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';

import {
  GitHubAppTokenProvider,
  TOKEN_REFRESH_MARGIN_MS,
  authRetryable,
  gh,
  ghText,
  installationToken,
  resolveGitHubApp,
} from '../../src/lib/github.js';
import {
  FAKE_APP_SLUG,
  FAKE_INSTALLATION_ID,
  FAKE_INSTALLATION_TOKEN,
  installFakeAppCredentials,
  testPrivateKeyBase64,
  verifyAppJwt,
  type FakeAppCredentials,
} from '../helpers/fake-github-app.js';

/**
 * The GitHub App token provider in `lib/github.ts`: the JWT it signs, the
 * installation it resolves, the token it caches and the 401 it recovers from.
 *
 * Every key here is generated at run time (`helpers/fake-github-app.ts`), never
 * written into a file: the gitleaks job scans full history.
 */

const realFetch = globalThis.fetch;
let app: FakeAppCredentials | undefined;

afterEach(() => {
  globalThis.fetch = realFetch;
  app?.restore();
  app = undefined;
});

/** A fake app in the environment, with `fetch` serving the app routes and `inner` answering the rest. */
function withApp(inner: typeof fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch): FakeAppCredentials {
  app = installFakeAppCredentials();
  globalThis.fetch = app.wrap(inner);
  return app;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function rejectsAuth(promise: Promise<unknown>): Promise<ApplicationFailure> {
  let caught: unknown;
  await promise.catch((err) => {
    caught = err;
  });
  assert.ok(caught instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(caught)}`);
  assert.equal(caught.type, 'AuthError');
  return caught;
}

test('the JWT is RS256, names the app as issuer, and lives ten minutes from a backdated iat', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  const provider = new GitHubAppTokenProvider('12345', testPrivateKeyBase64(), () => now);
  const claims = verifyAppJwt(provider.jwt());
  assert.equal(claims.iss, '12345');
  assert.equal(claims.iat, now / 1000 - 60, 'backdated a minute for clock drift');
  assert.equal(claims.exp - claims.iat, 600, 'GitHub allows ten minutes at most');
  assert.ok(claims.exp * 1000 - now <= 10 * 60_000, 'still inside the ten minutes from now');
});

test('a key that is not a base64 PEM is a non-retryable AuthError that does not echo the value', () => {
  const secret = ['not', 'a', 'pem'].join('-');
  assert.throws(
    () => new GitHubAppTokenProvider('12345', Buffer.from(secret).toString('base64')),
    (err: unknown) => err instanceof ApplicationFailure && err.nonRetryable && !err.message.includes(secret),
  );
});

test('the app is resolved once and the installation token is cached across calls', async () => {
  const fake = withApp();
  assert.deepEqual(await resolveGitHubApp(), { slug: FAKE_APP_SLUG, installationId: FAKE_INSTALLATION_ID });
  assert.equal(await installationToken(), FAKE_INSTALLATION_TOKEN);
  assert.equal(await installationToken(), FAKE_INSTALLATION_TOKEN);
  assert.deepEqual(fake.appCalls, ['GET /app/installations', `POST /app/installations/${FAKE_INSTALLATION_ID}/access_tokens`]);
  assert.equal(fake.minted, 1);
});

test('concurrent callers share one exchange', async () => {
  const fake = withApp();
  await Promise.all([installationToken(), installationToken(), installationToken()]);
  assert.equal(fake.minted, 1);
});

test('the token is replaced once it is within five minutes of expiry, and not before', async () => {
  const fake = withApp();
  const start = Date.now();
  let clock = start;
  const provider = new GitHubAppTokenProvider(fake.appId, testPrivateKeyBase64(), () => clock);

  await provider.token();
  assert.equal(fake.minted, 1);

  clock = start + 3_600_000 - TOKEN_REFRESH_MARGIN_MS - 60_000;
  await provider.token();
  assert.equal(fake.minted, 1, 'six minutes of life left: still cached');

  clock = start + 3_600_000 - TOKEN_REFRESH_MARGIN_MS + 60_000;
  await provider.token();
  assert.equal(fake.minted, 2, 'four minutes of life left: replaced');
  assert.equal(fake.appCalls.filter((c) => c === 'GET /app/installations').length, 1, 'the installation is not looked up again');
});

test('a request that meets a 401 mints a new token and is made once more', async () => {
  let repoCalls = 0;
  const fake = withApp((async () => {
    repoCalls++;
    return repoCalls === 1 ? json(401, { message: 'Bad credentials' }) : json(200, { ok: true });
  }) as typeof fetch);
  assert.deepEqual(await gh('/repos/o/r'), { ok: true });
  assert.equal(repoCalls, 2);
  assert.equal(fake.minted, 2, 'the cached token was dropped before the second attempt');
});

test('a second 401 is a non-retryable AuthError, after exactly one refresh', async () => {
  let repoCalls = 0;
  const fake = withApp((async () => {
    repoCalls++;
    return json(401, { message: 'Bad credentials' });
  }) as typeof fetch);
  const err = await rejectsAuth(gh('/repos/o/r'));
  assert.equal(err.nonRetryable, true);
  assert.match(err.message, /GitHub rejected the credential \(401\): Bad credentials/);
  assert.equal(repoCalls, 2);
  assert.equal(fake.minted, 2);
});

test('a plain-text read refreshes on a 401 the same way', async () => {
  let repoCalls = 0;
  const fake = withApp((async () => {
    repoCalls++;
    return repoCalls === 1 ? json(401, { message: 'Bad credentials' }) : new Response('log text', { status: 200 });
  }) as typeof fetch);
  assert.equal(await ghText('/repos/o/r/actions/jobs/1/logs'), 'log text');
  assert.equal(fake.minted, 2);
});

test('a 403 is not retried: a fresh token would not change the permissions', async () => {
  let repoCalls = 0;
  const fake = withApp((async () => {
    repoCalls++;
    return json(403, { message: 'Resource not accessible by integration' });
  }) as typeof fetch);
  const err = await rejectsAuth(gh('/repos/o/r'));
  assert.match(err.message, /permissions \(contents, pull requests and issues read and write\)/);
  assert.equal(repoCalls, 1);
  assert.equal(fake.minted, 1);
});

test('authRetryable makes the failure retryable and drops the cached token for the next poll', async () => {
  const fake = withApp((async () => json(401, { message: 'Bad credentials' })) as typeof fetch);
  const err = await rejectsAuth(authRetryable(() => gh('/repos/o/r')));
  assert.equal(err.nonRetryable, false);
  const mintedBefore = fake.minted;
  await installationToken();
  assert.equal(fake.minted, mintedBefore + 1, 'the next call mints instead of reusing the rejected token');
});

test('an app with no installation, or with two, stops with an AuthError that counts them', async () => {
  for (const installations of [[], [{ id: 1, app_slug: 'a' }, { id: 2, app_slug: 'a' }]]) {
    app = installFakeAppCredentials();
    globalThis.fetch = (async () => json(200, installations)) as typeof fetch;
    const err = await rejectsAuth(resolveGitHubApp());
    assert.match(err.message, new RegExp(`has ${installations.length} installations; Steward expects exactly one`));
    app.restore();
  }
});

test('GitHub refusing the app JWT is a non-retryable AuthError that names both variables', async () => {
  app = installFakeAppCredentials();
  globalThis.fetch = (async () => json(401, { message: 'A JSON web token could not be decoded' })) as typeof fetch;
  const err = await rejectsAuth(resolveGitHubApp());
  assert.equal(err.nonRetryable, true);
  assert.match(err.message, /STEWARD_GITHUB_APP_ID and STEWARD_GITHUB_APP_PRIVATE_KEY belong to the same app/);
});

test('a 5xx from the token exchange is retryable', async () => {
  app = installFakeAppCredentials();
  globalThis.fetch = (async () => json(502, { message: 'Bad Gateway' })) as typeof fetch;
  await assert.rejects(installationToken(), (err: unknown) => !(err instanceof ApplicationFailure) && /GitHub 502/.test(String(err)));
});

test('one missing variable is named, and the message does not include the other value', async () => {
  app = installFakeAppCredentials();
  process.env.STEWARD_GITHUB_APP_ID = '';
  const err = await rejectsAuth(installationToken());
  assert.match(err.message, /^STEWARD_GITHUB_APP_ID is not set/);
  assert.ok(!err.message.includes(testPrivateKeyBase64()));
});
