import { ApplicationFailure } from '@temporalio/activity';
import { GITHUB_REPO } from '../config.js';

/**
 * The Steward's one GitHub REST client, over plain `fetch` — extracted out of
 * `activities/publish.ts` so `activities/scorecard.ts`'s `publishScorecardRun`
 * shares the identical auth/error-handling rather than growing a second copy
 * that quietly drifts (scorecard-audit-spec.md §4.3: "reusing the Steward's
 * git/PR libs").
 *
 * `octokit` was not adopted for the same reason `publish.ts` originally
 * skipped it: this makes a handful of REST calls with a bearer token, and
 * `fetch` does that natively.
 */

export function githubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw ApplicationFailure.nonRetryable(
      'GITHUB_TOKEN is not set. The publish leg cannot open a PR without it.',
      'AuthError',
    );
  }
  return token;
}

/**
 * Permanent vs transient, per the error-handling contract. Getting this
 * backwards is expensive in both directions: a retried auth failure burns ten
 * attempts against a credential that will never work, and a non-retried 502
 * fails a publish that would have succeeded a second later.
 */
export async function gh(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (res.ok) return body;

  if (res.status === 401 || res.status === 403) {
    throw ApplicationFailure.nonRetryable(
      `GitHub rejected the credential (${res.status}): ${body.message ?? text}. Check GITHUB_TOKEN's scopes (contents RW, pull requests RW).`,
      'AuthError',
    );
  }
  if (res.status === 404) {
    throw ApplicationFailure.nonRetryable(
      `GitHub returned 404 for ${pathname}. Either ${GITHUB_REPO} is wrong or the token cannot see it.`,
      'NotFound',
    );
  }
  if (res.status === 422) {
    throw ApplicationFailure.nonRetryable(
      `GitHub rejected the request as unprocessable (422): ${body.message ?? text}. ${JSON.stringify(body.errors ?? [])}`,
      'UnprocessableRequest',
    );
  }
  // Everything else — 5xx, rate limits, transport hiccups — is retryable, and
  // deliberately a plain Error so the default retry policy applies.
  throw new Error(`GitHub ${res.status} for ${pathname}: ${body.message ?? text}`);
}
