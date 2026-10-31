import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRelease,
  applyRequest,
  causePaths,
  dispatchWorkflowId,
  dropEnded,
  planGrants,
  slotBlocker,
  waitingSlotLine,
  type DispatchState,
  type SlotRequest,
} from '../../src/lib/fix-dispatch.js';
import { parseFindingBody } from '../../src/lib/findings.js';
import { DEFECT_FINDING } from '../helpers/finding-fixtures.js';

/**
 * The dispatcher's pure rules: which paths a cause names, and who is granted
 * when. The workflow only carries these out, so the grant order is tested here
 * in full and only its wiring in `tests/workflows/fix-dispatch.test.ts`.
 */

const AT = '2026-10-30T20:00:00.000Z';

function request(key: string, paths: string[], ticket = 1): SlotRequest {
  return { workflowId: `finding/mattpyle-com/${key}`, key, paths, ticket, at: AT };
}

function empty(): DispatchState {
  return { site: 'mattpyle-com', holders: [], waiters: [] };
}

test('the dispatcher is one per site', () => {
  assert.equal(dispatchWorkflowId('mattpyle-com'), 'dispatch/mattpyle-com');
});

// ---------------------------------------------------------------------------
// causePaths
// ---------------------------------------------------------------------------

test("the fixtures' defect names one source file, with its line suffix stripped", () => {
  assert.deepEqual(causePaths(parseFindingBody(DEFECT_FINDING).cause), ['agents/steward/src/workflows/scorecard-audit.ts']);
});

test('the two 2026-10-29 collisions read as paths, the extensionless descriptor included', () => {
  assert.deepEqual(causePaths('`public/.well-known/mcp-server` says the server is read-only.'), ['public/.well-known/mcp-server']);
  assert.deepEqual(causePaths('`src/data/skills/using-mattpyle-com.md`, the skill body.'), ['src/data/skills/using-mattpyle-com.md']);
});

test('line suffixes are stripped in each form Argus writes', () => {
  assert.deepEqual(
    causePaths('`public/agents.md:113`, `src/components/SiteHeader.astro:189-196`, `src/a/b.ts#L4`, `src/a/c.ts#L4-L9`'),
    ['public/agents.md', 'src/a/b.ts', 'src/a/c.ts', 'src/components/SiteHeader.astro'],
  );
});

test('a route file with brackets is a path; duplicates collapse and the list is sorted', () => {
  assert.deepEqual(
    causePaths('`src/pages/writing/[slug].astro` and again `src/pages/writing/[slug].astro`, then `scripts/lib/html-to-markdown.mjs`'),
    ['scripts/lib/html-to-markdown.mjs', 'src/pages/writing/[slug].astro'],
  );
});

test('tokens that are not repository files are left out', () => {
  const cause = [
    '`/changelog`', // a URL path
    '`/changelog/rss.xml`',
    '`src/`', // a directory
    '`Layout.astro`', // no slash
    '`@astrojs/rss`', // a package
    '`text/html`', // a MIME type: two segments, no extension
    '`cmd/gen-docs`',
    '`github.com/mattpyle/mattpyle.com-website`', // a host
    '`docs/develop/java/*.mdx`', // a glob
    '`gtag/js?id=G-1`', // a query string
    '`${base}/projects/`', // a template
    '`grep -rln "x" src/pages`', // a command
    '`.prose h2/h3`',
    '`blob/main/...#L<n>`',
  ].join(', ');
  assert.deepEqual(causePaths(cause), []);
});

test('no cause, or a cause with no backticks, is an empty list', () => {
  assert.deepEqual(causePaths(null), []);
  assert.deepEqual(causePaths(undefined), []);
  assert.deepEqual(causePaths('the footer never renders the date'), []);
});

// ---------------------------------------------------------------------------
// Requests, releases and grants
// ---------------------------------------------------------------------------

test('a first request is granted at once', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  const granted = planGrants(state, AT);
  assert.deepEqual(granted.map((e) => e.key), ['a']);
  assert.equal(granted[0].grantedAt, AT);
  assert.deepEqual(state.waiters, []);
});

test('a request naming a held path waits, and is granted once the holder releases', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts', 'src/y.ts']));
  planGrants(state, AT);
  applyRequest(state, request('b', ['src/y.ts']));
  assert.deepEqual(planGrants(state, AT), []);
  assert.deepEqual(slotBlocker(state, 'finding/mattpyle-com/b'), { key: 'a', path: 'src/y.ts', held: true });

  assert.equal(applyRelease(state, { workflowId: 'finding/mattpyle-com/a', ticket: 1 }), true);
  assert.deepEqual(planGrants(state, AT).map((e) => e.key), ['b']);
});

test('requests naming different paths are granted together', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  applyRequest(state, request('b', ['src/y.ts']));
  applyRequest(state, request('c', []));
  assert.deepEqual(planGrants(state, AT).map((e) => e.key), ['a', 'b', 'c']);
});

test('two waiters on one path are granted in request order, and an unrelated later one is not held back', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  planGrants(state, AT);
  applyRequest(state, request('b', ['src/x.ts']));
  applyRequest(state, request('c', ['src/x.ts']));
  applyRequest(state, request('d', ['src/z.ts']));
  assert.deepEqual(planGrants(state, AT).map((e) => e.key), ['d']);
  assert.deepEqual(slotBlocker(state, 'finding/mattpyle-com/c'), { key: 'a', path: 'src/x.ts', held: true });

  applyRelease(state, { workflowId: 'finding/mattpyle-com/a', ticket: 1 });
  assert.deepEqual(planGrants(state, AT).map((e) => e.key), ['b'], 'b asked first');
  assert.deepEqual(slotBlocker(state, 'finding/mattpyle-com/c'), { key: 'b', path: 'src/x.ts', held: true });
});

test('a waiter blocked only by an earlier waiter names it as queued first', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  planGrants(state, AT);
  applyRequest(state, request('b', ['src/x.ts', 'src/y.ts']));
  applyRequest(state, request('c', ['src/y.ts']));
  assert.deepEqual(planGrants(state, AT), []);
  assert.deepEqual(slotBlocker(state, 'finding/mattpyle-com/c'), { key: 'b', path: 'src/y.ts', held: false });
});

test('a re-send of a held request changes nothing and asks for the grant again; a waiting one keeps its place', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  planGrants(state, AT);
  applyRequest(state, request('b', ['src/x.ts']));
  assert.deepEqual(applyRequest(state, request('a', ['src/x.ts'])), { regrant: true });
  assert.deepEqual(applyRequest(state, request('b', ['src/x.ts'])), { regrant: false });
  assert.deepEqual(state.holders.map((e) => e.key), ['a']);
  assert.deepEqual(state.waiters.map((e) => e.key), ['b']);
});

test('a new ticket from the same run replaces its earlier entry and joins the back', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  planGrants(state, AT);
  applyRequest(state, request('b', ['src/x.ts']));
  applyRequest(state, request('a', ['src/x.ts'], 2));
  assert.deepEqual(state.holders, []);
  assert.deepEqual(state.waiters.map((e) => `${e.key}#${e.ticket}`), ['b#1', 'a#2']);
  assert.deepEqual(planGrants(state, AT).map((e) => e.key), ['b']);
});

test('a release for another ticket is stale and drops nothing', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts'], 2));
  planGrants(state, AT);
  assert.equal(applyRelease(state, { workflowId: 'finding/mattpyle-com/a', ticket: 1 }), false);
  assert.equal(state.holders.length, 1);
});

test('the sweep drops every entry of a run that no longer runs', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  planGrants(state, AT);
  applyRequest(state, request('b', ['src/x.ts']));
  applyRequest(state, request('c', ['src/x.ts']));
  const ended = dropEnded(state, new Set(['finding/mattpyle-com/c']));
  assert.deepEqual(ended, ['finding/mattpyle-com/a', 'finding/mattpyle-com/b']);
  assert.deepEqual(planGrants(state, AT).map((e) => e.key), ['c']);
});

// ---------------------------------------------------------------------------
// The status line
// ---------------------------------------------------------------------------

test('the status line names the path and the fix it waits behind', () => {
  const state = empty();
  applyRequest(state, request('a', ['src/x.ts']));
  planGrants(state, AT);
  applyRequest(state, request('b', ['src/x.ts']));
  assert.equal(waitingSlotLine(state, 'finding/mattpyle-com/b', ['src/x.ts']), 'waiting-slot: src/x.ts, behind a (in flight)');
  assert.equal(
    waitingSlotLine(null, 'finding/mattpyle-com/b', ['src/x.ts']),
    "waiting-slot: names src/x.ts; the dispatcher did not answer",
  );
  assert.equal(
    waitingSlotLine(state, 'finding/mattpyle-com/a', ['src/x.ts']),
    'waiting-slot: granted, the run is taking it (names src/x.ts)',
  );
  assert.equal(waitingSlotLine(empty(), 'finding/mattpyle-com/z', []), "waiting-slot: names no path; not in the dispatcher's queue yet");
});
