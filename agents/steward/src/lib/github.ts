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
      // The path names the repository, which is not always GITHUB_REPO since the
      // findings store (ARGUS_REPO) shares this client.
      `GitHub returned 404 for ${pathname}. Either the repository or path is wrong, or the token cannot see it.`,
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

/**
 * Runs a GitHub call for a polling wait, where a rejected credential is a
 * retry at the wait's own interval rather than the end of the wait.
 *
 * {@link gh} marks a 401 or 403 `nonRetryable`, and the server honours that
 * flag whatever the workflow's retry policy says, so a wait that should outlast
 * a token rotation has to throw the failure retryable itself. The type and the
 * message are kept: `AuthError` still names what GitHub said, and the
 * workflow's retry policy still decides by that type whether the wait ends.
 * A wait is bounded by its schedule-to-close timeout, so a token that is
 * wrong rather than rotating costs one short read per interval until then.
 *
 * On 2026-10-21 the token was regenerated while the hosted worker held the old
 * one, and every run parked in the merge wait failed on its next poll.
 */
export async function authRetryable<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApplicationFailure && err.type === 'AuthError' && err.nonRetryable) {
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
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.ok) return await res.text();
  if (res.status === 404 || res.status === 410) return null;
  throw new Error(`GitHub ${res.status} for ${pathname}: ${await res.text()}`);
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
