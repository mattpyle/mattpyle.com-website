import { createPublicKey, createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';

/**
 * A stand-in for the GitHub App half of the API: `GET /app/installations` and
 * `POST /app/installations/{id}/access_tokens`.
 *
 * `lib/github.ts` mints an installation token from `STEWARD_GITHUB_APP_ID` and
 * `STEWARD_GITHUB_APP_PRIVATE_KEY` before its first call. A test that fakes
 * `fetch` therefore needs two things: those variables set to a real key pair, and
 * the two app routes answered. {@link installFakeAppCredentials} does the first and
 * hands back the second as `handle`.
 *
 * `installFakeGitHub` uses it inside its own `fetch`. A test that scripts `fetch`
 * by hand wraps its script in `app.wrap(...)`, so the script sees only the
 * repository calls it names and its call list stays exactly what it was.
 *
 * The key pair is generated once per process, at run time: a PEM written into a
 * test would trip the gitleaks scan. The JWT is checked for real (RS256 against
 * the public half, `iss` and expiry), so a provider that signs wrongly fails here.
 */

export const FAKE_INSTALLATION_TOKEN = 'fake-installation-token';
export const FAKE_APP_SLUG = 'steward-test';
export const FAKE_INSTALLATION_ID = 424242;

let keyPair: { privateKeyBase64: string; publicKey: KeyObject } | undefined;
let appSeq = 0;

function testKey(): { privateKeyBase64: string; publicKey: KeyObject } {
  if (!keyPair) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    keyPair = {
      privateKeyBase64: Buffer.from(privateKey).toString('base64'),
      publicKey: createPublicKey(publicKey),
    };
  }
  return keyPair;
}

/** The generated key, as the environment variable holds it. For tests that build a provider directly. */
export function testPrivateKeyBase64(): string {
  return testKey().privateKeyBase64;
}

/** Checks an RS256 JWT against the test key and returns its claims; throws when it does not verify. */
export function verifyAppJwt(jwt: string): { iat: number; exp: number; iss: string } {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('the app JWT does not have three parts');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error(`the app JWT is signed ${header.alg}, not RS256`);
  const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(testKey().publicKey, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('the app JWT signature does not verify');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function authorization(init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization ?? '';
}

export interface FakeAppCredentials {
  appId: string;
  /** App-route requests served, as `METHOD path`. */
  appCalls: string[];
  /** Installation tokens handed out. */
  minted: number;
  /** Answers an app route, or undefined for any other request. */
  handle(input: string | URL | Request, init?: RequestInit): Response | undefined;
  /** `fetch` that serves the app routes, rejects a repository call without the installation token, and passes the rest to `inner`. */
  wrap(inner: typeof fetch): typeof fetch;
  restore(): void;
}

/**
 * Points the environment at a fresh fake app. Each call uses a new app id, so
 * the provider in `lib/github.ts` starts with an empty cache.
 */
export function installFakeAppCredentials(): FakeAppCredentials {
  const previousId = process.env.STEWARD_GITHUB_APP_ID;
  const previousKey = process.env.STEWARD_GITHUB_APP_PRIVATE_KEY;
  const appId = String(910000 + ++appSeq);
  process.env.STEWARD_GITHUB_APP_ID = appId;
  process.env.STEWARD_GITHUB_APP_PRIVATE_KEY = testKey().privateKeyBase64;

  const state: FakeAppCredentials = {
    appId,
    appCalls: [],
    minted: 0,
    handle(input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.host !== 'api.github.com' || !(url.pathname === '/app' || url.pathname.startsWith('/app/'))) return undefined;
      const method = (init?.method ?? 'GET').toUpperCase();
      state.appCalls.push(`${method} ${url.pathname}`);
      const bearer = /^Bearer (.+)$/.exec(authorization(init));
      if (!bearer) return json(401, { message: 'A JSON web token could not be decoded' });
      let claims: ReturnType<typeof verifyAppJwt>;
      try {
        claims = verifyAppJwt(bearer[1]);
      } catch (err) {
        return json(401, { message: (err as Error).message });
      }
      if (claims.iss !== appId) return json(401, { message: 'Issuer does not match the app' });
      if (claims.exp * 1000 <= Date.now()) return json(401, { message: 'Expiration time is in the past' });
      if (method === 'GET' && url.pathname === '/app') return json(200, { id: Number(appId), slug: FAKE_APP_SLUG });
      if (method === 'GET' && url.pathname === '/app/installations') {
        return json(200, [{ id: FAKE_INSTALLATION_ID, app_slug: FAKE_APP_SLUG }]);
      }
      if (method === 'POST' && url.pathname === `/app/installations/${FAKE_INSTALLATION_ID}/access_tokens`) {
        state.minted++;
        return json(201, { token: FAKE_INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      return json(404, { message: 'Not Found' });
    },
    wrap(inner) {
      return (async (input: any, init?: RequestInit) => {
        const served = state.handle(input, init);
        if (served) return served;
        if (authorization(init) !== `Bearer ${FAKE_INSTALLATION_TOKEN}`) {
          return json(401, { message: 'Bad credentials' });
        }
        return inner(input, init);
      }) as typeof fetch;
    },
    restore() {
      if (previousId === undefined) delete process.env.STEWARD_GITHUB_APP_ID;
      else process.env.STEWARD_GITHUB_APP_ID = previousId;
      if (previousKey === undefined) delete process.env.STEWARD_GITHUB_APP_PRIVATE_KEY;
      else process.env.STEWARD_GITHUB_APP_PRIVATE_KEY = previousKey;
    },
  };
  return state;
}
