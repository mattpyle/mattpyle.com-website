import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import {
  awaitFixPrMerge,
  closeConflictingFixPr,
  prConflicts,
  recutComment,
  requestFixSlot,
} from '../../src/activities/findings.js';
import { OPPORTUNITY_FINDING, OPPORTUNITY_KEY } from '../helpers/finding-fixtures.js';

/**
 * The dispatcher's activities against a scripted GitHub: the merge wait's
 * conflict read, the conflicting PR's close with its sibling, and a slot
 * request for a finding that names no path, which needs no dispatcher.
 */

const SITE_REPO = 'mattpyle/mattpyle.com-website';
const PR = `https://github.com/${SITE_REPO}/pull/402`;
const SIBLING = `https://github.com/${SITE_REPO}/pull/401`;
const OLDER = `https://github.com/${SITE_REPO}/pull/399`;

const realFetch = globalThis.fetch;
const previousToken = process.env.GITHUB_TOKEN;
let fake: FakeGitHub | undefined;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousToken;
  fake?.restore();
  fake = undefined;
});

interface Call {
  method: string;
  path: string;
  body: any;
}

/** Answers `METHOD /path` keys from a map, a function answer may read the body; anything else fails loudly. */
function scriptGitHub(routes: Record<string, unknown | ((body: any) => unknown)>): Call[] {
  const calls: Call[] = [];
  process.env.GITHUB_TOKEN = 'fake-token-for-tests';
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const path = `${u.pathname}${u.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`no scripted route for ${key}`);
    const answer = routes[key];
    const json = typeof answer === 'function' ? (answer as (b: any) => unknown)(body) : answer;
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

// ---------------------------------------------------------------------------
// The merge wait's conflict read
// ---------------------------------------------------------------------------

test('a conflict is mergeable false with state dirty; null is GitHub still computing', () => {
  assert.equal(prConflicts({ mergeable: false, mergeable_state: 'dirty' }), true);
  assert.equal(prConflicts({ mergeable: null, mergeable_state: 'unknown' }), false);
  assert.equal(prConflicts({ mergeable: false, mergeable_state: 'blocked' }), false);
  assert.equal(prConflicts({ mergeable: true, mergeable_state: 'clean' }), false);
});

test('a dispatched merge wait ends conflicting on a dirty PR; an undispatched one keeps polling', async () => {
  scriptGitHub({ [`GET /repos/${SITE_REPO}/pulls/402`]: { state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty' } });
  assert.deepEqual(await awaitFixPrMerge(PR, { reportConflict: true }), { prUrl: PR, state: 'conflicting', mergeSha: null, at: null });

  let caught: unknown;
  await awaitFixPrMerge(PR).catch((err) => {
    caught = err;
  });
  assert.ok(caught instanceof ApplicationFailure);
  assert.equal(caught.type, 'PrStillOpen');
  assert.equal(caught.nonRetryable, false);
});

test('a dispatched merge wait still polls while GitHub computes mergeability', async () => {
  scriptGitHub({ [`GET /repos/${SITE_REPO}/pulls/402`]: { state: 'open', merged: false, mergeable: null, mergeable_state: 'unknown' } });
  await assert.rejects(awaitFixPrMerge(PR, { reportConflict: true }), (err: unknown) => (err as ApplicationFailure).type === 'PrStillOpen');
});

// ---------------------------------------------------------------------------
// The close
// ---------------------------------------------------------------------------

function conflictRoutes(state: { closed: boolean }, existingComments: { body: string }[] = []) {
  return {
    [`GET /repos/${SITE_REPO}/pulls/402`]: () => ({
      state: state.closed ? 'closed' : 'open',
      created_at: '2026-10-30T06:02:00Z',
      base: { ref: 'master' },
    }),
    [`GET /repos/${SITE_REPO}/pulls/402/files?per_page=100`]: [{ filename: 'public/.well-known/mcp-server' }, { filename: 'src/pages/mcp.ts' }],
    [`GET /repos/${SITE_REPO}/pulls?state=closed&base=master&sort=updated&direction=desc&per_page=30`]: [
      { number: 403, html_url: `https://github.com/${SITE_REPO}/pull/403`, merged_at: null },
      { number: 401, html_url: SIBLING, merged_at: '2026-10-30T07:00:00Z' },
      { number: 400, html_url: `https://github.com/${SITE_REPO}/pull/400`, merged_at: '2026-10-30T06:30:00Z' },
      { number: 399, html_url: OLDER, merged_at: '2026-10-30T05:00:00Z' },
    ],
    [`GET /repos/${SITE_REPO}/pulls/401/files?per_page=100`]: [{ filename: 'public/.well-known/mcp-server' }],
    [`GET /repos/${SITE_REPO}/pulls/400/files?per_page=100`]: [{ filename: 'src/content/writing/other.md' }],
    [`GET /repos/${SITE_REPO}/issues/402/comments?per_page=100`]: existingComments,
    [`POST /repos/${SITE_REPO}/issues/402/comments`]: { id: 1 },
    [`PATCH /repos/${SITE_REPO}/pulls/402`]: () => {
      state.closed = true;
      return { state: 'closed' };
    },
  };
}

test('a conflicting PR is closed with a comment naming the sibling merged since it opened, on the shared file', async () => {
  const state = { closed: false };
  const calls = scriptGitHub(conflictRoutes(state));
  const result = await closeConflictingFixPr(PR);
  assert.deepEqual(result, { closed: true, siblings: [SIBLING], files: ['public/.well-known/mcp-server'] });
  assert.equal(state.closed, true);
  assert.ok(!calls.some((c) => c.path.includes('/pulls/399/')), 'a PR merged before this one opened is no candidate');
  assert.ok(!calls.some((c) => c.path.includes('/pulls/403/')), 'an unmerged closed PR is no candidate');
  const comment = calls.find((c) => c.method === 'POST')?.body.body as string;
  assert.match(comment, /^<!-- steward:recut -->\n/);
  assert.match(comment, /It conflicts with `master` since https:\/\/github\.com\/.+\/pull\/401 merged, on `public\/\.well-known\/mcp-server`\./);
  assert.match(comment, /cut from the new `master`\.$/);
  assert.deepEqual(calls.find((c) => c.method === 'PATCH')?.body, { state: 'closed' });
});

test('a retry after the comment landed does not post it twice', async () => {
  const state = { closed: false };
  const calls = scriptGitHub(conflictRoutes(state, [{ body: recutComment([SIBLING], []) }]));
  await closeConflictingFixPr(PR);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('a PR no longer open is left alone, and the result says so', async () => {
  const calls = scriptGitHub(conflictRoutes({ closed: true }));
  assert.deepEqual(await closeConflictingFixPr(PR), { closed: false, siblings: [], files: [] });
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
});

test('with no sibling found the comment still says why it closed', () => {
  assert.match(recutComment([], []), /It conflicts with `master` since another change merged\./);
});

// ---------------------------------------------------------------------------
// The slot request
// ---------------------------------------------------------------------------

test('a finding whose cause names no path is granted by the activity, with no dispatcher', async () => {
  const path = `sites/mattpyle-com/findings/${OPPORTUNITY_KEY}.md`;
  fake = installFakeGitHub({ defaultBranch: 'main', seed: { [path]: OPPORTUNITY_FINDING } });
  const requested = await requestFixSlot({
    repo: 'mattpyle/argus',
    site: 'mattpyle-com',
    key: OPPORTUNITY_KEY,
    findingPath: path,
    workflowId: `finding/mattpyle-com/${OPPORTUNITY_KEY}`,
    ticket: 1,
    at: '2026-10-30T20:00:00.000Z',
  });
  // No activity context was needed: a dispatched request would have read `Context.current()` and thrown.
  assert.deepEqual(requested, { paths: [], dispatched: false });
});
