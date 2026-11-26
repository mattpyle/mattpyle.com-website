import { createSign } from 'node:crypto';

import { ApplicationFailure } from '@temporalio/activity';

/**
 * Steward's one GitHub REST client, over plain `fetch` — extracted out of
 * `activities/publish.ts` so `activities/scorecard.ts`'s `publishScorecardRun`
 * shares the identical auth/error-handling rather than growing a second copy
 * that quietly drifts (scorecard-audit-spec.md §4.3: "reusing Steward's
 * git/PR libs").
 *
 * `octokit` was not adopted for the same reason `publish.ts` originally
 * skipped it: this makes a handful of REST calls with a bearer token, and
 * `fetch` does that natively.
 *
 * ## Credential: a GitHub App's installation token
 *
 * Steward authenticates as an installed GitHub App. Two values hold the whole
 * credential: `STEWARD_GITHUB_APP_ID` and `STEWARD_GITHUB_APP_PRIVATE_KEY`, the
 * app's PEM as one line of base64 so the same representation works in `.env`,
 * on Railway and in a password manager. The installation id is resolved once
 * from `GET /app/installations` and kept. When the app is installed on more
 * than one account, `STEWARD_GITHUB_APP_INSTALLATION_ID` names the one to use.
 *
 * {@link GitHubAppTokenProvider} signs a ten-minute JWT with Node's `crypto`
 * and exchanges it for an installation token, which lives one hour and is
 * cached until five minutes before it expires. Nothing is written to disk, and
 * neither the key nor a token appears in a log or an error message.
 *
 * **Never log the private key, its base64, or the JWT**, in this file or in a
 * caller. The app id, the slug and the installation id are public identifiers
 * and are the only values that may appear in a log line or an error.
 *
 * The app needs Contents, Pull requests and Issues read and write, and
 * Deployments, Checks and Actions read. Commits, pull requests and issues the
 * calls below create are authored by the app's bot login.
 *
 * `lib/git.ts` carries no token: pushes use the local checkout's credential
 * helper, which this credential does not touch.
 */

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export const APP_ID_ENV = 'STEWARD_GITHUB_APP_ID';
export const APP_KEY_ENV = 'STEWARD_GITHUB_APP_PRIVATE_KEY';
/** Optional: which installation to use when the app has more than one. */
export const INSTALLATION_ID_ENV = 'STEWARD_GITHUB_APP_INSTALLATION_ID';

/** The JWT is backdated a minute for clock drift, and lives ten minutes from there. */
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 600;

/** A cached token is replaced this long before GitHub would expire it. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export interface GitHubAppIdentity {
  /** The app's slug; its bot login is `<slug>[bot]`. */
  slug: string;
  installationId: number;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function authError(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, 'AuthError');
}

function describeInstallation(installation: any): string {
  return `${installation?.account?.login ?? 'unknown account'} (id ${installation?.id})`;
}

/**
 * How long one GitHub call may take, headers and body together, before it is
 * aborted. No findings activity heartbeats and the findings queue has two
 * slots, so a connection that hangs would otherwise hold one until `fetch`
 * gave up on its own. `log` is for {@link ghText} alone: an Actions job log is
 * large and comes from a storage host that can be slow.
 *
 * An object so that a test can shorten the waits.
 */
export const GITHUB_TIMEOUTS = { call: 20_000, log: 45_000 };

/** The shortest and the longest wait a `RateLimited` failure asks Temporal for. */
export const RATE_LIMIT_MIN_DELAY_MS = 60_000;
export const RATE_LIMIT_MAX_DELAY_MS = 60 * 60_000;

/** How much of a body that is not JSON goes into an error message. */
const SNIPPET_CHARS = 200;

/** One answer from GitHub, read to the end. */
export interface GitHubAnswer {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

/**
 * `fetch`, with the body read inside the same time limit. A call that runs out
 * of time throws a plain `Error`, so the retry policy applies. `what` names the
 * call in that message, and must never be a URL that carries a token.
 */
export async function fetchGitHub(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number = GITHUB_TIMEOUTS.call,
): Promise<GitHubAnswer> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  } catch (err) {
    if (!signal.aborted) throw err;
    throw new Error(`GitHub call timed out after ${timeoutMs / 1000} s: ${what}`, { cause: err });
  }
}

/** A body that may not be JSON: what it parses to, and the words to put in a message. */
function readBody(text: string): { json: boolean; body: any; message: string } {
  try {
    const body = text ? JSON.parse(text) : {};
    return { json: true, body, message: String(body?.message ?? text) };
  } catch {
    const flat = text.replace(/\s+/g, ' ').trim();
    const message = flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}...` : flat;
    return { json: false, body: { message }, message };
  }
}

/**
 * The `RateLimited` failure for a 403 or 429 that is GitHub saying "slow
 * down", or undefined for anything else. Tested in this order:
 *
 * 1. `retry-after` (secondary limit): wait that many seconds.
 * 2. `x-ratelimit-remaining: 0` (primary limit): wait until `x-ratelimit-reset`,
 *    which is in epoch seconds.
 * 3. A 403 whose message names a secondary rate limit, and any other 429: wait
 *    one minute.
 *
 * The failure is retryable by itself and no workflow names its type.
 * `nextRetryDelay` replaces the policy's interval, because requests made while
 * limited can get an integration banned. It is held between one minute and one
 * hour, which also covers a header that does not parse.
 */
export function rateLimitFailure(
  answer: GitHubAnswer,
  what: string,
  now: number = Date.now(),
): ApplicationFailure | undefined {
  const { status, headers } = answer;
  if (status !== 403 && status !== 429) return undefined;
  const { message } = readBody(answer.text);
  const retryAfter = headers.get('retry-after');
  let kind: string;
  let asked = RATE_LIMIT_MIN_DELAY_MS;
  if (retryAfter !== null) {
    kind = `secondary, ${status}`;
    asked = Number(retryAfter) * 1000;
  } else if (headers.get('x-ratelimit-remaining') === '0') {
    kind = `primary, ${status}`;
    asked = Number(headers.get('x-ratelimit-reset') ?? Number.NaN) * 1000 - now;
  } else if (/secondary rate limit/i.test(message)) {
    kind = `secondary, ${status}`;
  } else if (status === 429) {
    kind = '429';
  } else {
    return undefined;
  }
  const delay = Number.isFinite(asked)
    ? Math.min(RATE_LIMIT_MAX_DELAY_MS, Math.max(RATE_LIMIT_MIN_DELAY_MS, Math.ceil(asked)))
    : RATE_LIMIT_MIN_DELAY_MS;
  return ApplicationFailure.create({
    message: `GitHub rate limit (${kind}) for ${what}: ${message}. Retry in ${Math.ceil(delay / 1000)} s.`,
    type: 'RateLimited',
    nonRetryable: false,
    nextRetryDelay: delay,
  });
}

function parseJson(text: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Mints and caches the app's installation token.
 *
 * One instance per (app id, key) pair; {@link installationToken} builds it from
 * the environment. The clock is injectable so a test can move time without a
 * timer. Concurrent callers share one exchange.
 */
export class GitHubAppTokenProvider {
  private readonly pem: string;
  private identity?: GitHubAppIdentity;
  private cached?: { token: string; expiresAt: number };
  private minting?: Promise<string>;

  constructor(
    private readonly appId: string,
    privateKeyBase64: string,
    private readonly now: () => number = Date.now,
    private readonly installationOverride?: string,
  ) {
    this.pem = Buffer.from(privateKeyBase64, 'base64').toString('utf8');
    if (!this.pem.includes('-----BEGIN')) {
      throw authError(`${APP_KEY_ENV} is not the base64 of a PEM private key.`);
    }
  }

  /** The RS256 JWT GitHub accepts for `/app/*` calls: `iss` the app id, ten minutes from `iat`. */
  jwt(): string {
    const iat = Math.floor(this.now() / 1000) - JWT_BACKDATE_SECONDS;
    const signingInput =
      `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
      base64Url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_SECONDS, iss: this.appId }));
    let signature: Buffer;
    try {
      signature = createSign('RSA-SHA256').update(signingInput).sign(this.pem);
    } catch {
      // The crypto error can quote key material's shape; say only what is wrong.
      throw authError(`${APP_KEY_ENV} does not hold a usable RSA private key.`);
    }
    return `${signingInput}.${base64Url(signature)}`;
  }

  private async appCall(pathname: string, method: 'GET' | 'POST'): Promise<any> {
    const res = await fetchGitHub(
      `${API}${pathname}`,
      {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.jwt()}`,
          'X-GitHub-Api-Version': API_VERSION,
        },
      },
      `${method} ${pathname}`,
    );
    const limited = rateLimitFailure(res, pathname);
    if (limited) throw limited;
    const body = parseJson(res.text);
    if (res.ok) return body;
    const text = readBody(res.text).message;
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw authError(
        `GitHub rejected the app credential (${res.status}) for ${pathname}: ${body.message ?? text}. ` +
          `Check that ${APP_ID_ENV} and ${APP_KEY_ENV} belong to the same app and that the app is installed.`,
      );
    }
    throw new Error(`GitHub ${res.status} for ${pathname}: ${body.message ?? text}`);
  }

  /**
   * The installation to act as. With `STEWARD_GITHUB_APP_INSTALLATION_ID` set,
   * that one, without listing installations: only the app's slug is read, from
   * `GET /app`, and a wrong id surfaces as a 404 at the token exchange.
   * Otherwise the app's only installation: Matt installs it once, on the account
   * that owns both repositories. More than one with no override is a setup error
   * worth stopping on rather than guessing between, and the error lists them so
   * the fix is a copy and paste.
   */
  async resolve(): Promise<GitHubAppIdentity> {
    if (this.identity) return this.identity;
    if (this.installationOverride) {
      const app = await this.appCall('/app', 'GET');
      this.identity = { slug: String(app.slug ?? this.appId), installationId: Number(this.installationOverride) };
      return this.identity;
    }
    const installations = await this.appCall('/app/installations?per_page=100', 'GET');
    if (!Array.isArray(installations)) {
      throw authError(`GitHub answered the installation list for app ${this.appId} in a shape Steward cannot read.`);
    }
    const listed = installations.length === 0 ? 'none' : installations.map(describeInstallation).join(', ');
    let installation: any;
    if (installations.length === 1) {
      installation = installations[0];
    } else if (installations.length === 0) {
      throw authError(
        `GitHub app ${this.appId} has no installations. Install it on the account that owns both repositories.`,
      );
    } else {
      throw authError(
        `GitHub app ${this.appId} has ${installations.length} installations (${listed}). Set ${INSTALLATION_ID_ENV} to the one that owns both repositories.`,
      );
    }
    this.identity = { slug: String(installation.app_slug ?? this.appId), installationId: Number(installation.id) };
    return this.identity;
  }

  /** A token with more than the refresh margin left, minted when there is none. */
  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return this.cached.token;
    this.minting ??= this.mint().finally(() => {
      this.minting = undefined;
    });
    return this.minting;
  }

  /** Forget the cached token, so the next {@link token} mints a new one. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async mint(): Promise<string> {
    const { installationId } = await this.resolve();
    const body = await this.appCall(`/app/installations/${installationId}/access_tokens`, 'POST');
    const expiresAt = Date.parse(String(body.expires_at));
    if (typeof body.token !== 'string' || !body.token || Number.isNaN(expiresAt)) {
      throw new Error('GitHub answered the installation token request without a token or an expiry.');
    }
    this.cached = { token: body.token, expiresAt };
    return body.token;
  }
}

let current: { key: string; provider: GitHubAppTokenProvider } | undefined;

/**
 * The provider for the app named in the environment, built on first use and
 * rebuilt if either value changes. Missing values are a non-retryable
 * `AuthError`: a retried attempt would meet the same empty variable.
 */
function appProvider(): GitHubAppTokenProvider {
  const appId = process.env[APP_ID_ENV];
  const privateKey = process.env[APP_KEY_ENV];
  const missing = [appId ? '' : APP_ID_ENV, privateKey ? '' : APP_KEY_ENV].filter(Boolean);
  if (!appId || !privateKey) {
    throw authError(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. Steward authenticates to GitHub as an installed GitHub App, ` +
        `and the publish leg cannot open a PR without it.`,
    );
  }
  const installationOverride = process.env[INSTALLATION_ID_ENV]?.trim() || undefined;
  if (installationOverride && !/^\d+$/.test(installationOverride)) {
    throw authError(`${INSTALLATION_ID_ENV} must be the installation's numeric id.`);
  }
  const key = `${appId}\n${privateKey}\n${installationOverride ?? ''}`;
  if (current?.key !== key) {
    current = { key, provider: new GitHubAppTokenProvider(appId, privateKey, Date.now, installationOverride) };
  }
  return current.provider;
}

/** An installation token from the cache, or a fresh one. */
export function installationToken(): Promise<string> {
  try {
    return appProvider().token();
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Drops the cached token, so the next call mints a new one. A no-op when no app is configured. */
export function dropInstallationToken(): void {
  current?.provider.invalidate();
}

/**
 * Which app and installation the environment's credential resolves to. The
 * hosted worker calls it at boot, so a wrong id or key stops the deploy rather
 * than the 03:30 run, and names the result in its ready line.
 */
export async function resolveGitHubApp(): Promise<GitHubAppIdentity> {
  return appProvider().resolve();
}

/** What the hosted worker's boot learned about its GitHub credential. */
export interface GitHubBoot {
  appId: string;
  /** Null when GitHub could not be reached or answered 5xx; the first call resolves it. */
  identity: GitHubAppIdentity | null;
  /** Why `identity` is null. Never a credential. */
  unresolvedReason?: string;
}

/**
 * {@link resolveGitHubApp} for a worker's boot, with the one tolerance a boot
 * needs. A rate limit is tolerated too: a worker that restarted in a loop would
 * send more requests. A credential GitHub rejects (an `AuthError`: 401, 403, 404, an unusable
 * key, missing values, the wrong installation count) throws, so the deploy stops
 * where someone sees it. A transport error or a 5xx does not: the worker
 * recycles itself after heavy work, and a GitHub blip at that moment must not
 * leave the audit tier down until the platform restarts it. The worker starts,
 * says so, and the first `gh` call resolves the installation.
 */
export async function resolveGitHubAppForBoot(): Promise<GitHubBoot> {
  const appId = process.env[APP_ID_ENV] ?? '';
  try {
    return { appId, identity: await resolveGitHubApp() };
  } catch (err) {
    if (err instanceof ApplicationFailure && err.type === 'AuthError') throw err;
    return { appId, identity: null, unresolvedReason: err instanceof Error ? err.message : String(err) };
  }
}

/** The ready line's `github` value. */
export function describeGitHubBoot(boot: GitHubBoot): string {
  return boot.identity
    ? `app ${boot.identity.slug} installation ${boot.identity.installationId}`
    : `app ${boot.appId} installation unresolved`;
}

/**
 * One authenticated request. A 401 means the cached token is no longer good
 * (revoked, or the app's permissions changed under it), so it is dropped and
 * the request is made once more with a new one. A second 401 is the caller's
 * to handle.
 */
async function authedFetch(
  pathname: string,
  init: RequestInit,
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<GitHubAnswer> {
  const send = async () => {
    // The token first: its mint has a time limit of its own.
    const token = await installationToken();
    return fetchGitHub(
      `${API}${pathname}`,
      {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...headers,
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
      },
      `${init.method ?? 'GET'} ${pathname}`,
      timeoutMs,
    );
  };
  const first = await send();
  if (first.status !== 401) return first;
  dropInstallationToken();
  return send();
}

/**
 * Permanent vs transient, per the error-handling contract. Getting this
 * backwards is expensive in both directions: a retried auth failure burns ten
 * attempts against a credential that will never work, and a non-retried 502
 * fails a publish that would have succeeded a second later.
 *
 * The status and headers are read before the body. A rate limit
 * ({@link rateLimitFailure}) is tested first, because GitHub sends one as a 403.
 * An error page that is not JSON keeps its status in the message.
 */
export async function gh(pathname: string, init?: RequestInit): Promise<any> {
  const res = await authedFetch(pathname, init ?? {}, { 'Content-Type': 'application/json' });

  const limited = rateLimitFailure(res, pathname);
  if (limited) throw limited;
  const { json, body, message } = readBody(res.text);

  if (res.ok) {
    if (json) return body;
    throw new Error(`GitHub ${res.status} for ${pathname}: the body is not JSON: ${message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw ApplicationFailure.nonRetryable(
      `GitHub rejected the credential (${res.status}): ${message}. Check the GitHub App's permissions (contents, pull requests and issues read and write) and that it is installed on the repository.`,
      'AuthError',
    );
  }
  if (res.status === 404) {
    throw ApplicationFailure.nonRetryable(
      // The path names the repository, which is not always GITHUB_REPO since the
      // findings store (ARGUS_REPO) shares this client.
      `GitHub returned 404 for ${pathname}. Either the repository or path is wrong, or the app's installation cannot see it.`,
      'NotFound',
    );
  }
  if (res.status === 422) {
    throw ApplicationFailure.nonRetryable(
      `GitHub rejected the request as unprocessable (422): ${message}. ${JSON.stringify(body.errors ?? [])}`,
      'UnprocessableRequest',
    );
  }
  // Everything else — 5xx, a 409, transport hiccups — is retryable, and
  // deliberately a plain Error so the default retry policy applies.
  throw new Error(`GitHub ${res.status} for ${pathname}: ${message}`);
}

/**
 * A request whose refusal the caller wants to read, not have thrown: the status
 * and GitHub's own message come back as they were. The merge of a Scorecard
 * run-log pull request uses it, because a ruleset refusal arrives as 403, 405 or
 * 409 and {@link gh} would turn each into an error that hides which. It shares
 * {@link authedFetch}, so the installation token and its one 401 refresh are the
 * same. A second 401, a rate limit and any 5xx still throw, as `gh` throws them:
 * none is a refusal the caller can act on.
 */
export async function ghResponse(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; body: any }> {
  const res = await authedFetch(pathname, init ?? {}, { 'Content-Type': 'application/json' });
  const limited = rateLimitFailure(res, pathname);
  if (limited) throw limited;
  const { body, message } = readBody(res.text);
  if (res.status === 401) {
    throw ApplicationFailure.nonRetryable(
      `GitHub rejected the credential (401): ${message}. Check the GitHub App's permissions and installation.`,
      'AuthError',
    );
  }
  if (res.status >= 500) throw new Error(`GitHub ${res.status} for ${pathname}: ${message}`);
  return { status: res.status, ok: res.ok, body };
}

/**
 * Runs a GitHub call for a polling wait, where a rejected credential is a
 * retry at the wait's own interval rather than the end of the wait.
 *
 * {@link gh} marks a 401 or 403 `nonRetryable`, and the server honours that
 * flag whatever the workflow's retry policy says, so a wait that should outlast
 * a credential change has to throw the failure retryable itself. The type and
 * the message are kept: `AuthError` still names what GitHub said, and the
 * workflow's retry policy still decides by that type whether the wait ends.
 * A wait is bounded by its schedule-to-close timeout, so a credential that is
 * wrong rather than changing costs one short read per interval until then.
 *
 * The cached installation token is dropped on the way out, so the next poll
 * mints a new one even if the failure came from a token the first retry inside
 * {@link gh} had already replaced.
 *
 * On 2026-10-21 the token was regenerated while the hosted worker held the old
 * one, and every run parked in the merge wait failed on its next poll.
 */
export async function authRetryable<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApplicationFailure && err.type === 'AuthError' && err.nonRetryable) {
      dropInstallationToken();
      throw ApplicationFailure.create({ message: err.message, type: err.type, nonRetryable: false });
    }
    throw err;
  }
}

/**
 * A plain-text GitHub read, for the one kind of body that is not JSON: an
 * Actions job log. GitHub answers with a redirect to a short-lived storage URL,
 * which `fetch` follows. Null when there is nothing to read: 404, or 410 for a
 * log past its retention. Any other failure throws, as {@link gh} does.
 */
export async function ghText(pathname: string): Promise<string | null> {
  const res = await authedFetch(pathname, {}, {}, GITHUB_TIMEOUTS.log);
  if (res.ok) return res.text;
  if (res.status === 404 || res.status === 410) return null;
  const limited = rateLimitFailure(res, pathname);
  if (limited) throw limited;
  throw new Error(`GitHub ${res.status} for ${pathname}: ${readBody(res.text).message}`);
}

/**
 * Turns an open PR into a draft. REST has no field for it, so this is GraphQL's
 * `convertPullRequestToDraft`, by the PR's node ID. A PR that is already a
 * draft is left alone, which also makes a retry a no-op. The caller checks
 * that the PR is open: GitHub refuses the mutation on a merged or closed one.
 */
export async function convertPrToDraft(repo: string, number: number): Promise<void> {
  const data = await gh(`/repos/${repo}/pulls/${number}`);
  if (data.draft === true) return;
  const reply = await gh('/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: data.node_id },
    }),
  });
  if (Array.isArray(reply.errors) && reply.errors.length > 0) {
    throw new Error(
      `GitHub refused to make ${repo}#${number} a draft: ${reply.errors.map((e: { message?: string }) => e.message).join('; ')}`,
    );
  }
}

/**
 * Marks a draft PR ready for review: GraphQL's `markPullRequestReadyForReview`,
 * the inverse of {@link convertPrToDraft}. A PR that is not a draft is left
 * alone, which makes a retry a no-op. The caller decides whether Steward may
 * clear the draft at all; see {@link lastDraftedBy}.
 */
export async function markPrReady(repo: string, number: number): Promise<void> {
  const data = await gh(`/repos/${repo}/pulls/${number}`);
  if (data.draft !== true) return;
  const reply = await gh('/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: data.node_id },
    }),
  });
  if (Array.isArray(reply.errors) && reply.errors.length > 0) {
    throw new Error(
      `GitHub refused to mark ${repo}#${number} ready: ${reply.errors.map((e: { message?: string }) => e.message).join('; ')}`,
    );
  }
}

/** Timeline pages read before giving up: 1,000 events is far past any fix PR. */
const TIMELINE_PAGES = 10;

/**
 * Who last turned the PR into a draft: the actor of the newest
 * `convert_to_draft` event on its issue timeline, or null when it has none. A
 * PR opened as a draft has no such event, so its draft has no actor Steward
 * can name.
 */
export async function lastDraftedBy(repo: string, number: number): Promise<string | null> {
  let actor: string | null = null;
  for (let page = 1; page <= TIMELINE_PAGES; page++) {
    const events = (await gh(`/repos/${repo}/issues/${number}/timeline?per_page=100&page=${page}`)) as {
      event?: string;
      actor?: { login?: string } | null;
    }[];
    if (!Array.isArray(events)) break;
    for (const e of events) {
      if (e.event === 'convert_to_draft') actor = e.actor?.login ?? null;
    }
    if (events.length < 100) break;
  }
  return actor;
}

/** The bot login GitHub shows for Steward's own writes: `<slug>[bot]`. */
export async function stewardBotLogin(): Promise<string> {
  return `${(await resolveGitHubApp()).slug}[bot]`;
}
