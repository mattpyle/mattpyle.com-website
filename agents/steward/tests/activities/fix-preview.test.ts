import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { awaitPreviewDeploy } from '../../src/activities/findings.js';
import { openFixerPr, readFixChecks } from '../../src/activities/fixer.js';
import { BYPASS_SECRET_ENV, runFindingChecks } from '../../src/activities/verify-finding.js';
import { buildFixerPrBody, opensAsDraft, siteCheckProblems, type FixerSiteChecks } from '../../src/lib/fixer.js';
import { parseFindingBody } from '../../src/lib/findings.js';
import { verifyBlockRetryPrompt } from '../../src/lib/handoff-generator.js';
import { VERCEL_BYPASS_HEADER, bypassFetch, onOrigin, type VerifyCheck } from '../../src/lib/verify-checks.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * The pieces of the fixer's two tests: the origin swap and the bypass secret's
 * reach, the preview wait against a scripted GitHub, the choice of block, the
 * regeneration prompt, the PR body's Verify section and the draft flip.
 */

const PREVIEW = 'https://mattpyle-com-website-abc123-mattpyles-projects.vercel.app';
const SECRET = 'test-bypass-secret';
const SITE_REPO = 'mattpyle/mattpyle.com-website';

const realFetch = globalThis.fetch;
const previousToken = process.env.GITHUB_TOKEN;
const previousSecret = process.env[BYPASS_SECRET_ENV];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  restore('GITHUB_TOKEN', previousToken);
  restore(BYPASS_SECRET_ENV, previousSecret);
});

async function rejectsWith(promise: Promise<unknown>, type: string, nonRetryable: boolean): Promise<ApplicationFailure> {
  let caught: unknown;
  await promise.catch((err) => {
    caught = err;
  });
  assert.ok(caught instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(caught)}`);
  assert.equal(caught.type, type);
  assert.equal(caught.nonRetryable, nonRetryable);
  return caught;
}

const CHECK: VerifyCheck = { url: `${ORIGIN}/scorecard/?view=runs`, kind: 'text', expect: { count: 0, of: '100/100 (Fail)' } };

// ---------------------------------------------------------------------------
// The origin swap and the secret's reach
// ---------------------------------------------------------------------------

test("a block on the preview keeps each check's path, query and expectation", () => {
  assert.deepEqual(onOrigin([CHECK, { url: `${ORIGIN}/`, kind: 'status', expect: 200 }], PREVIEW), [
    { url: `${PREVIEW}/scorecard/?view=runs`, kind: 'text', expect: { count: 0, of: '100/100 (Fail)' } },
    { url: `${PREVIEW}/`, kind: 'status', expect: 200 },
  ]);
});

test('the bypass secret goes to the preview origin and nowhere a redirect leads', async () => {
  const seen: [string, string | null][] = [];
  const base = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    seen.push([u, new Headers(init.headers).get(VERCEL_BYPASS_HEADER)]);
    assert.equal(init.redirect, 'manual', 'every hop is followed by hand');
    if (u === `${PREVIEW}/old`) return new Response(null, { status: 308, headers: { location: '/new' } });
    if (u === `${PREVIEW}/new`) return new Response(null, { status: 302, headers: { location: `${ORIGIN}/new` } });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const fetcher = bypassFetch(PREVIEW, SECRET, base);

  const res = await fetcher(`${PREVIEW}/old`, { headers: { 'User-Agent': 'steward-audit' } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [
    [`${PREVIEW}/old`, SECRET],
    [`${PREVIEW}/new`, SECRET],
    [`${ORIGIN}/new`, null],
  ]);

  // A caller that asks for the redirect itself gets it, as from fetch.
  seen.length = 0;
  const manual = await fetcher(`${PREVIEW}/old`, { redirect: 'manual' });
  assert.equal(manual.status, 308);
  assert.equal(seen.length, 1);
});

test('the check run on a preview swaps the origin and carries the secret, and its result does not', async () => {
  process.env[BYPASS_SECRET_ENV] = SECRET;
  const seen: [string, string | null][] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    seen.push([String(url), new Headers(init.headers).get(VERCEL_BYPASS_HEADER)]);
    return new Response('<p>Accessibility: 1 axe violation (Fail)</p>', { status: 200 });
  }) as typeof fetch;
  const run = await runFindingChecks({ key: DEFECT_KEY, checks: [CHECK], previewOrigin: PREVIEW }, { fetch: fetcher });

  assert.deepEqual(seen, [[`${PREVIEW}/scorecard/?view=runs`, SECRET]]);
  assert.equal(run.passed, true);
  assert.ok(!JSON.stringify(run).includes(SECRET), 'the secret is in no result');
});

test('a worker without the bypass secret refuses the preview run before any request', async () => {
  process.env[BYPASS_SECRET_ENV] = '';
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    return new Response('');
  }) as typeof fetch;
  const err = await rejectsWith(
    runFindingChecks({ key: DEFECT_KEY, checks: [CHECK], previewOrigin: PREVIEW }, { fetch: fetcher }),
    'PreviewBypassMissing',
    true,
  );
  assert.match(err.message, /VERCEL_AUTOMATION_BYPASS_SECRET is not set/);
  assert.equal(requests, 0);
});

test('the production run sends no secret, even when the worker has one', async () => {
  process.env[BYPASS_SECRET_ENV] = SECRET;
  let header: string | null = 'unset';
  const fetcher = (async (_url: string | URL, init: RequestInit = {}) => {
    header = new Headers(init.headers).get(VERCEL_BYPASS_HEADER);
    return new Response('<p>100/100 (Fail)</p>', { status: 200 });
  }) as typeof fetch;
  const run = await runFindingChecks({ key: DEFECT_KEY, checks: [CHECK] }, { fetch: fetcher });
  assert.equal(header, null);
  assert.equal(run.passed, false);
});

// ---------------------------------------------------------------------------
// The preview wait
// ---------------------------------------------------------------------------

const DEPLOYS = `/repos/${SITE_REPO}/deployments?sha=c-head&environment=Preview&per_page=1`;
const status = (id: number) => `/repos/${SITE_REPO}/deployments/${id}/statuses?per_page=1`;

function scriptGitHub(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  process.env.GITHUB_TOKEN = 'fake-token-for-tests';
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    const path = `${u.pathname}${u.search}`;
    calls.push(path);
    if (!(path in routes)) throw new Error(`no scripted route for ${path}`);
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const previewInput = { repo: SITE_REPO, sha: 'c-head', environment: 'Preview' };

test("a ready preview is the origin of its status's environment URL", async () => {
  scriptGitHub({
    [DEPLOYS]: [{ id: 41 }],
    [status(41)]: [{ state: 'success', environment_url: `${PREVIEW}/` }],
  });
  assert.deepEqual(await awaitPreviewDeploy(previewInput), { origin: PREVIEW, deploymentId: 41 });
});

test('no deployment yet, or one still building, is the retryable PreviewNotReady', async () => {
  scriptGitHub({ [DEPLOYS]: [] });
  await rejectsWith(awaitPreviewDeploy(previewInput), 'PreviewNotReady', false);
  scriptGitHub({ [DEPLOYS]: [{ id: 41 }], [status(41)]: [{ state: 'in_progress' }] });
  await rejectsWith(awaitPreviewDeploy(previewInput), 'PreviewNotReady', false);
});

test('a failed preview build is PreviewFailed, which no retry mends', async () => {
  scriptGitHub({ [DEPLOYS]: [{ id: 41 }], [status(41)]: [{ state: 'failure' }] });
  const err = await rejectsWith(awaitPreviewDeploy(previewInput), 'PreviewFailed', true);
  assert.match(err.message, /c-head ended failure/);
});

// ---------------------------------------------------------------------------
// The block a fix is judged by
// ---------------------------------------------------------------------------

const handoffWith = (yaml: string) => DEFECT_HANDOFF.replace('verify: []', yaml);
const HANDOFF_BLOCK = ['verify:', `  - url: ${ORIGIN}/scorecard/`, '    kind: status', '    expect: 200'].join('\n');
const findingInput = (findingText: string, handoff = handoffWith(HANDOFF_BLOCK)) => ({
  key: DEFECT_KEY,
  findingPath: `sites/mattpyle-com/findings/${DEFECT_KEY}.md`,
  findingText,
  handoff,
  origin: ORIGIN,
});

test("the finding's own block wins, and the handoff's stands in only when the finding has no key", async () => {
  const own = DEFECT_FINDING.replace(
    'references: []',
    ['references: []', 'verify:', `  - url: ${ORIGIN}/scorecard/`, '    kind: text', '    expect: {contains: "violation"}'].join('\n'),
  );
  assert.deepEqual(await readFixChecks(findingInput(own)), {
    origin: ORIGIN,
    source: 'finding',
    checks: [{ url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { contains: 'violation' } }],
    coverage: null,
  });
  assert.deepEqual(await readFixChecks(findingInput(DEFECT_FINDING)), {
    origin: ORIGIN,
    source: 'handoff',
    checks: [{ url: `${ORIGIN}/scorecard/`, kind: 'status', expect: 200 }],
    coverage: null,
  });
});

test("a handoff's coverage map is read beside its block, and one that names a missing check fails the fix", async () => {
  const map = ['verify_coverage:', `  - surface: ${ORIGIN}/scorecard/`, '    checks: [1]', '  - surface: the A2A answer', '    reason: A2A is a POST.'];
  const mapped = handoffWith([HANDOFF_BLOCK, ...map].join('\n'));
  assert.deepEqual((await readFixChecks(findingInput(DEFECT_FINDING, mapped))).coverage, [
    { surface: `${ORIGIN}/scorecard/`, checks: [1] },
    { surface: 'the A2A answer', reason: 'A2A is a POST.' },
  ]);
  const wrong = handoffWith([HANDOFF_BLOCK, ...map].join('\n').replace('checks: [1]', 'checks: [2]'));
  const err = await rejectsWith(readFixChecks(findingInput(DEFECT_FINDING, wrong)), 'VerifyBlockInvalid', true);
  assert.match(err.message, /the handoff for .* was refused: coverage entry 1 .* names check 2, which the block does not have/);
});

test("an invalid finding block fails the fix, naming the finding, and never falls back to the handoff's", async () => {
  const bad = DEFECT_FINDING.replace('references: []', ['references: []', 'verify:', '  - url: https://example.com/', '    kind: status', '    expect: 200'].join('\n'));
  const err = await rejectsWith(readFixChecks(findingInput(bad)), 'VerifyBlockInvalid', true);
  assert.match(err.message, /findings\/content-perfect-score-labelled-fail--scorecard\.md was refused/);
});

test('the regeneration is told each check, what it measured, and which pass before the fix', () => {
  const prompt = verifyBlockRetryPrompt({
    key: DEFECT_KEY,
    finding: DEFECT_FINDING,
    handoff: DEFECT_HANDOFF,
    origin: ORIGIN,
    rejected: {
      checks: [CHECK, { url: `${ORIGIN}/`, kind: 'status', expect: 200 }],
      results: [
        { n: 1, url: CHECK.url, kind: 'text', pass: false, expected: 'x', measured: '2 occurrences' },
        { n: 2, url: `${ORIGIN}/`, kind: 'status', pass: true, expected: 'status 200', measured: 'status 200' },
      ],
      broken: null,
    },
  });
  assert.match(prompt, /The fix is not written yet/);
  assert.match(prompt, /1\. `text` https:\/\/www\.mattpyle\.com\/scorecard\/\?view=runs, expect \{"count":0,"of":"100\/100 \(Fail\)"\}: measured 2 occurrences\. It fails before the fix, as it should\./);
  assert.match(prompt, /2\. `status` https:\/\/www\.mattpyle\.com\/, expect 200: measured status 200\. It PASSES before the fix/);
  assert.match(prompt, /verify:\n {2}- url: <a URL on the production origin>/);
});

// ---------------------------------------------------------------------------
// The PR
// ---------------------------------------------------------------------------

const row = (n: number, pass: boolean, measured: string) => ({
  n,
  url: CHECK.url,
  kind: 'text' as const,
  pass,
  expected: '0 occurrences of "100/100 (Fail)"',
  measured,
});

const SITE: FixerSiteChecks = {
  source: 'finding',
  regenerated: false,
  regenerateError: null,
  block: [CHECK],
  production: [row(1, false, '2 occurrences')],
  productionNote: null,
  preview: [row(1, true, '0 occurrences')],
  previewNote: null,
};

const bodyWith = (site: FixerSiteChecks | null) =>
  buildFixerPrBody({
    key: DEFECT_KEY,
    finding: parseFindingBody(DEFECT_FINDING),
    checks: ['`npm test -w @mattpyle/steward` passes.'],
    results: [{ n: 1, status: 'pass', command: 'npm test -w @mattpyle/steward' }],
    filesChanged: ['a.ts'],
    exitCode: 0,
    timedOut: false,
    site,
  });

test('the Verify section shows both tests per check: production measured, preview measured, pass or fail', () => {
  const body = bodyWith(SITE);
  assert.ok(body.includes(
    [
      "The checks on the site, from the finding's own `verify` block. Each runs on production before the fix, where it must fail, and on this PR's preview, where it must pass.",
      '',
      `1. \`text\` ${CHECK.url}`,
      '   - Expects: 0 occurrences of "100/100 (Fail)"',
      '   - Production, before the fix: 2 occurrences. Fails, as it should.',
      '   - Preview: 0 occurrences. Pass.',
    ].join('\n'),
  ), body);
  assert.ok(!body.startsWith('>'), 'no banner when both tests held');
  assert.equal(siteCheckProblems(SITE).length, 0);
});

test('a check that passed before the fix or failed on the preview is a banner and a draft', () => {
  const site = { ...SITE, production: [row(1, true, '0 occurrences')], preview: [row(1, false, '2 occurrences')] };
  const body = bodyWith(site);
  assert.match(body, /^> \*\*Check 1 already passes on production\.\*\* Before the fix, so it does not show the defect\.\n\n> \*\*Check 1 fails on the preview\.\*\*/);
  assert.match(body, /Production, before the fix: 0 occurrences\. Passes, so it does not show the defect\./);
  assert.match(body, /Preview: 2 occurrences\. Fail\./);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site }), true);
});

test('before the preview is measured the body says so, and that alone is not a draft', () => {
  const site = { ...SITE, preview: null };
  assert.match(bodyWith(site), /Preview: not measured yet\./);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site }), false);
});

test('a preview that could not be measured is a banner with the reason, and a draft', () => {
  const site = { ...SITE, preview: null, previewNote: 'No Preview deployment of c-head was ready within 20 minutes.' };
  const body = bodyWith(site);
  assert.match(body, /^> \*\*The preview was not measured\.\*\* No Preview deployment of c-head was ready within 20 minutes\./);
  assert.match(body, /Preview: not measured\./);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site }), true);
});

test('an empty block is named unverifiable by checks, and is not a draft', () => {
  const site = { ...SITE, block: [], production: null, preview: null };
  assert.match(bodyWith(site), /its `verify` block is empty\. The fix is unverifiable by checks\./);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site }), false);
});

test('the Verify section shows the coverage map, and a fully mapped block is not a draft', () => {
  const site: FixerSiteChecks = { ...SITE, source: 'handoff', coverage: [{ surface: `${ORIGIN}/scorecard/`, checks: [1] }] };
  const body = bodyWith(site);
  assert.ok(body.includes(
    ['The surfaces the finding names, and the checks on the site that measure each:', '', `- \`${ORIGIN}/scorecard/\`: check 1.`].join('\n'),
  ), body);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site }), false);
});

test('a surface with a reason and no check is a banner and a draft, and the reason is under Verify', () => {
  const site: FixerSiteChecks = {
    ...SITE,
    source: 'handoff',
    coverage: [
      { surface: '/llms.txt', checks: [1] },
      { surface: 'the A2A answer', reason: 'A2A is a POST; no check kind sends one.' },
    ],
  };
  const body = bodyWith(site);
  assert.match(body, /^> \*\*A surface the finding names has no check\.\*\* Its reason is under Verify; a person decides whether the fix holds there\./);
  assert.ok(body.includes('- `the A2A answer`: no check. A2A is a POST; no check kind sends one.'), body);
  assert.ok(body.includes('- `/llms.txt`: check 1.'), body);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site }), true);
  // An empty block whose every surface has a reason is a draft too.
  const empty = { ...site, block: [], production: null, preview: null, coverage: [site.coverage![1]] };
  assert.match(bodyWith(empty), /The fix is unverifiable by checks\.\n\nThe surfaces the finding names/);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site: empty }), true);
});

test("a finding's own block has no map: the section says so, and that alone is not a draft", () => {
  const site: FixerSiteChecks = { ...SITE, source: 'finding', coverage: null };
  assert.match(bodyWith(site), /Coverage not mapped \(the finding's own block\)\./);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [], site }), false);
  assert.match(bodyWith({ ...site, source: 'handoff' }), /Coverage not mapped \(the handoff predates the map\)\./);
});

test("a regenerated handoff block says so, and a failed regeneration says why the first stands", () => {
  const regenerated = bodyWith({ ...SITE, source: 'handoff', regenerated: true });
  assert.match(regenerated, /from the handoff's `verify` block, written a second time because the first one passed on production before the fix\./);
  const failed = bodyWith({ ...SITE, source: 'handoff', regenerateError: 'verify is not a list' });
  assert.match(failed, /Writing the block a second time failed, so the first one stands: verify is not a list/);
});

test('a PR the preview test fails is turned into a draft by GraphQL, and a draft is left alone', async () => {
  const calls: string[] = [];
  let draft = false;
  process.env.GITHUB_TOKEN = 'fake-token-for-tests';
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname === `/repos/${SITE_REPO}/pulls` && method === 'GET') return json([{ number: 340 }]);
    if (u.pathname === `/repos/${SITE_REPO}/pulls/340` && method === 'PATCH') {
      return json({ html_url: `https://github.com/${SITE_REPO}/pull/340` });
    }
    if (u.pathname === `/repos/${SITE_REPO}/pulls/340`) return json({ draft, node_id: 'PR_node' });
    if (u.pathname === '/graphql') {
      assert.match(String(init.body), /convertPullRequestToDraft/);
      assert.equal(JSON.parse(String(init.body)).variables.id, 'PR_node');
      draft = true;
      return json({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } });
    }
    throw new Error(`unscripted ${method} ${u.pathname}`);
  }) as typeof fetch;

  const prInput = {
    key: DEFECT_KEY,
    findingText: DEFECT_FINDING,
    handoff: DEFECT_HANDOFF,
    branch: `fix/finding-${DEFECT_KEY}`,
    base: 'master',
    filesChanged: ['a.ts'],
    checks: [],
    exitCode: 0,
    timedOut: false,
    site: { ...SITE, preview: [row(1, false, '2 occurrences')] },
  };
  assert.deepEqual(await openFixerPr(prInput), { prUrl: `https://github.com/${SITE_REPO}/pull/340`, draft: true });
  assert.ok(calls.includes('POST /graphql'));

  calls.length = 0;
  await openFixerPr(prInput);
  assert.ok(!calls.includes('POST /graphql'), 'an existing draft is not converted again');
});
