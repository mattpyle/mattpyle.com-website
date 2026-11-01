import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { consoleRequest } from '../helpers/console-request.js';
import { startConsoleServer, type ConsoleServer } from '../../src/console/server.js';
import { createFindingsLoader, driftFor, type ConsoleClient, type FindingRunView } from '../../src/console/findings-model.js';
import { renderFindingBody } from '../../src/console/finding-markdown.js';
import { buildFindingVerdict, FindingVerdictError, type FindingVerdictRequest } from '../../src/lib/finding-verdict.js';
import { buildVerificationSection, type Verification } from '../../src/lib/findings.js';

/**
 * The console's JSON routes over a fixture store: a fake GitHub with two sites
 * (one that stops at the verdict), a fake Temporal client with no open runs,
 * and the guards over real sockets.
 */

const REPO = 'test/argus';
const MP = 'mattpyle-com';
const TI = 'temporal-io';

const VERIFICATION: Verification = {
  status: 'resolved',
  at: '2026-10-20T09:00:00.000Z',
  workflowId: 'verify/mattpyle-com/ux-resolved--about/2026-10-20T090000Z',
  source: 'finding',
  rows: [{ n: 1, url: 'https://www.mattpyle.com/about/', kind: 'selector', pass: true, expected: 'at least 1 match', measured: '1 match' }],
};

function file(key: string, status: string, kind: string, extra: string[], body: string): string {
  return ['---', `key: ${key}`, `status: ${status}`, `kind: ${kind}`, 'type: accessibility', 'priority: high', ...extra, '---', '', `# Title of ${key}`, '', body].join('\n');
}

const BODY = [
  '## Who wanted what',
  '',
  'A reader. <script>alert(1)</script> See [the page](https://www.mattpyle.com/about/) and [bad](javascript:alert(1)).',
  '',
  '## What happened',
  '',
  '- URL: https://www.mattpyle.com/about/',
].join('\n');

const FILES: Record<string, string> = {
  [`sites/${MP}/config.yaml`]: 'site:\n  name: mattpyle.com\n',
  [`sites/${TI}/config.yaml`]: 'site:\n  name: temporal.io\n  stop_after: verdict\n',
  [`sites/${MP}/findings/INDEX.md`]: [
    'ux-proposed--about | proposed | defect | recruiter | Proposed |',
    'ux-resolved--about | resolved | defect | recruiter | Resolved | Approved.',
    'ux-opp--about | approved | opportunity | recruiter | Opportunity | Approved.',
    'ux-lost--about | approved | defect | recruiter | Lost | Approved.',
  ].join('\n'),
  [`sites/${MP}/findings/ux-proposed--about.md`]: file('ux-proposed--about', 'proposed', 'defect', ['first_seen: 2026-10-27', 'title_short: Short one', 'summary: A summary.'], BODY),
  [`sites/${MP}/findings/ux-resolved--about.md`]: file(
    'ux-resolved--about',
    'resolved',
    'defect',
    [
      'first_seen: 2026-10-01',
      'last_seen: 2026-10-10',
      'last_run: 2026-10-10T0642Z',
      'verdict_reason: "Fix it."',
      'verdict_at: 2026-10-02T04:37:30Z',
      'verdict_source: cli',
      'resolved_run: 2026-10-20T0900Z',
      'links:\n  pr: https://github.com/mattpyle/mattpyle.com-website/pull/500',
    ],
    `${BODY}\n\n## Re-check 2026-10-05T0642Z\n\n- Outcome: not-resolved\n\n${buildVerificationSection(VERIFICATION)}\n`,
  ),
  [`sites/${MP}/findings/ux-opp--about.md`]: file('ux-opp--about', 'approved', 'opportunity', ['first_seen: 2026-10-01'], BODY),
  [`sites/${MP}/findings/ux-lost--about.md`]: file('ux-lost--about', 'approved', 'defect', ['first_seen: 2026-10-01'], BODY),
  [`sites/${TI}/findings/INDEX.md`]: 'ti-approved--home | approved | defect | recruiter | Approved |',
  [`sites/${TI}/findings/ti-approved--home.md`]: file('ti-approved--home', 'approved', 'defect', ['first_seen: 2026-10-01'], BODY),
};

const sha = (text: string) => crypto.createHash('sha1').update(text).digest('hex');

function fakeGitHub() {
  const byPath = new Map(Object.entries(FILES).map(([p, text]) => [p, { sha: sha(text), text }]));
  const bySha = new Map([...byPath.values()].map((b) => [b.sha, b.text]));
  return async (pathname: string) => {
    if (pathname === `/repos/${REPO}/git/trees/main?recursive=1`) {
      return { tree: [...byPath].map(([p, b]) => ({ path: p, type: 'blob', sha: b.sha })) };
    }
    const id = /\/git\/blobs\/([0-9a-f]+)$/.exec(pathname)?.[1];
    if (id && bySha.has(id)) return { content: Buffer.from(bySha.get(id) as string).toString('base64') };
    throw new Error(`unexpected GitHub call ${pathname}`);
  };
}

const client: ConsoleClient = {
  workflow: {
    async *list() {},
    getHandle() {
      throw new Error('no run is open, so nothing is queried');
    },
  },
};

let server: ConsoleServer;
let sent: FindingVerdictRequest[] = [];
let refuseNext = false;

before(async () => {
  const loader = createFindingsLoader({ repo: REPO, ghJson: fakeGitHub(), client, now: () => new Date('2026-10-31T12:00:00Z') });
  server = await startConsoleServer({
    port: 0,
    loadFindings: () => loader.load(),
    sendVerdict: async (request) => {
      if (refuseNext) {
        refuseNext = false;
        throw new FindingVerdictError('no-run', 'no open run');
      }
      sent.push(request);
      return {
        workflowId: `finding/${request.site}/${request.key}`,
        sent: buildFindingVerdict(request.status, request.reason),
        recorded: buildFindingVerdict(request.status, request.reason),
        commitSha: 'abc1234',
        nextStep: null,
        nextStepError: null,
        webUrl: 'https://cloud.temporal.io/x',
      };
    },
    timeZone: 'America/Vancouver',
    webUi: 'https://web.example',
    namespace: 'ns.test',
  });
});

after(async () => {
  await server?.close();
});

async function api(): Promise<any> {
  const res = await consoleRequest({ port: server.port, path: '/api/findings' });
  assert.equal(res.status, 200, res.body);
  assert.match(String(res.headers['content-type']), /application\/json/);
  return JSON.parse(res.body);
}

const row = (data: any, site: string, key: string) => data.sites.find((s: any) => s.site === site).rows.find((r: any) => r.key === key);

test('GET /api/findings returns the model, the cost and the token', async () => {
  const data = await api();
  assert.equal(data.repo, REPO);
  assert.deepEqual(Object.keys(data.cost).sort(), ['blobReads', 'dispatcherQueries', 'stateQueries', 'treeCalls']);
  assert.equal(data.token, server.token);
  assert.equal(data.sites.find((s: any) => s.site === MP).rows.length, 4);
  assert.equal(data.sites.find((s: any) => s.site === TI).rows.length, 1);
});

test('a proposed row has kind and type apart, the short fields it holds, null for the rest, and one event', async () => {
  const r = row(await api(), MP, 'ux-proposed--about');
  assert.equal(r.kind, 'defect');
  assert.equal(r.type, 'accessibility');
  assert.equal(r.titleShort, 'Short one');
  assert.equal(r.summary, 'A summary.');
  assert.equal(r.keyShort, null);
  assert.deepEqual(r.events, [{ kind: 'first-seen', at: '2026-10-27', label: 'First seen by Argus' }]);
  assert.deepEqual(r.sections.map((s: any) => s.heading), ['Who wanted what', 'What happened']);
});

test('a resolved row has its events oldest first', async () => {
  const r = row(await api(), MP, 'ux-resolved--about');
  assert.deepEqual(
    r.events.map((e: any) => [e.kind, e.at]),
    [
      ['first-seen', '2026-10-01'],
      ['verdict', '2026-10-02T04:37:30.000Z'],
      ['pr', null],
      ['recheck', '2026-10-05T06:42:00Z'],
      ['seen', '2026-10-10T06:42:00Z'],
      ['verification', '2026-10-20T09:00:00.000Z'],
      ['resolved', '2026-10-20T09:00:00Z'],
    ],
  );
  const verdict = r.events.find((e: any) => e.kind === 'verdict');
  assert.equal(verdict.label, 'Approved');
  assert.equal(verdict.detail, 'Fix it. via cli');
  assert.equal(r.events.find((e: any) => e.kind === 'pr').url, 'https://github.com/mattpyle/mattpyle.com-website/pull/500');
  assert.equal(r.events.find((e: any) => e.kind === 'recheck').detail, 'not-resolved');
  assert.equal(r.events.find((e: any) => e.kind === 'verification').detail, '1 of 1 checks passed');
});

test('raw HTML in a body is escaped, a javascript link is dropped and a web link opens as a link', async () => {
  const r = row(await api(), MP, 'ux-proposed--about');
  assert.doesNotMatch(r.body, /<script/);
  assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(r.body, /javascript:/);
  assert.match(r.body, /<a href="https:\/\/www\.mattpyle\.com\/about\/" target="_blank" rel="noopener noreferrer">the page<\/a>/);
  assert.match(r.body, /<h2>Who wanted what<\/h2>/);
  assert.doesNotMatch(r.body, /Title of/);
  assert.doesNotMatch(r.sections[0].html, /<h2/);
});

test('a heading inside a code fence does not start a section', () => {
  const { sections } = renderFindingBody('# T\n\n## One\n\n```\n## Not a heading\n```\n\n## Two\n\ntext');
  assert.deepEqual(sections.map((s) => s.heading), ['One', 'Two']);
});

test('drift: temporal-io stops at the verdict, an opportunity is quiet, a lost defect still drifts', async () => {
  const data = await api();
  const ti = row(data, TI, 'ti-approved--home');
  assert.deepEqual(ti.drift, []);
  assert.equal(ti.quietReason, 'no fixer for this site');
  const opp = row(data, MP, 'ux-opp--about');
  assert.deepEqual(opp.drift, []);
  assert.equal(opp.quietReason, 'opportunity, yours to take');
  const lost = row(data, MP, 'ux-lost--about');
  assert.deepEqual(lost.drift, ['approved with no open run']);
  assert.equal(lost.quietReason, null);
  assert.equal(row(data, MP, 'ux-proposed--about').drift[0], 'proposed with no open run');
});

test('driftFor without a context keeps the old answer', () => {
  const run: FindingRunView = { open: false, since: null, step: null, queried: false, queryError: null, prUrl: null, issueUrl: null, previewResult: null, lastFixError: null, slotLine: null };
  assert.deepEqual(driftFor('approved', 'approved', run), ['approved with no open run']);
  assert.deepEqual(driftFor('fixing', 'fixing', run, { stopAfter: 'verdict', kind: 'opportunity' }), ['fixing with no open run']);
});

test('POST /api/verdict answers JSON for a JSON body, under the guards', async () => {
  sent = [];
  const fields = { token: server.token, site: MP, key: 'ux-proposed--about', verdict: 'rejected', reason: 'Duplicate.' };
  const origin = `http://127.0.0.1:${server.port}`;
  const ok = await consoleRequest({ port: server.port, path: '/api/verdict', method: 'POST', origin, json: fields });
  assert.equal(ok.status, 200, ok.body);
  assert.match(String(ok.headers['content-type']), /application\/json/);
  assert.equal(JSON.parse(ok.body).commitSha, 'abc1234');
  const asForm = await consoleRequest({ port: server.port, path: '/api/verdict', method: 'POST', origin, form: fields });
  assert.equal(asForm.status, 415);
  assert.equal(sent.length, 1);

  const foreign = await consoleRequest({ port: server.port, path: '/api/verdict', method: 'POST', origin: 'http://evil.example', json: fields });
  assert.equal(foreign.status, 403);
  assert.ok(JSON.parse(foreign.body).error);
  const noToken = await consoleRequest({ port: server.port, path: '/api/verdict', method: 'POST', origin, json: { ...fields, token: 'nope' } });
  assert.equal(noToken.status, 403);
  const noReason = await consoleRequest({ port: server.port, path: '/api/verdict', method: 'POST', origin, json: { ...fields, reason: '' } });
  assert.equal(noReason.status, 400);
  assert.equal(sent.length, 1, 'a refused request never reaches the sender');
  refuseNext = true;
  const conflict = await consoleRequest({ port: server.port, path: '/api/verdict', method: 'POST', origin, json: fields });
  assert.equal(conflict.status, 409);
});

test('both routes refuse a non-loopback Host', async () => {
  sent = [];
  const get = await consoleRequest({ port: server.port, path: '/api/findings', host: 'rebound.example' });
  assert.equal(get.status, 403);
  const post = await consoleRequest({
    port: server.port,
    path: '/api/verdict',
    method: 'POST',
    host: 'rebound.example',
    origin: 'http://rebound.example',
    json: { token: server.token, site: MP, key: 'k', verdict: 'approved' },
  });
  assert.equal(post.status, 403);
  assert.deepEqual(sent, []);
  const wrongMethod = await consoleRequest({ port: server.port, path: '/api/verdict' });
  assert.equal(wrongMethod.status, 405);
});
