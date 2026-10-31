import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFindingsLoader, driftFor, type ConsoleClient } from '../../src/console/findings-model.js';
import { renderFindingsPage } from '../../src/console/findings-page.js';
import {
  buildVerificationSection,
  parseVerificationSection,
  type Verification,
} from '../../src/lib/findings.js';
import type { FindingState } from '../../src/workflows/finding.js';

/**
 * `/findings` from a fixture store: a fake GitHub serving one tree and its
 * blobs, and a fake Temporal client serving the open runs, the failed verify
 * runs and the `state` of the runs the page asks about. The page must show all
 * three groups, a drift flag, the failed-verify strip, and a reopened
 * finding's failed checks with their measured values, while querying only the
 * approved and fixing runs.
 */

const REPO = 'test/argus';
const SITE = 'mattpyle-com';

const REOPENED_VERIFICATION: Verification = {
  status: 'reopened',
  at: '2026-10-30T18:04:00.000Z',
  workflowId: 'verify/mattpyle-com/ux-reopened--about/2026-10-30T180400Z',
  source: 'finding',
  rows: [
    { n: 1, url: 'https://www.mattpyle.com/about/', kind: 'selector', pass: true, expected: 'at least 1 match', measured: '1 match' },
    {
      n: 2,
      url: 'https://www.mattpyle.com/about/',
      kind: 'js',
      pass: false,
      expected: 'true',
      measured: 'false (the rail overlaps the header by 32px)',
      viewport: '390x844',
    },
  ],
};

function finding(key: string, status: string, title: string, extra = '', body = ''): string {
  return [
    '---',
    `key: ${key}`,
    `status: ${status}`,
    'kind: defect',
    'priority: high',
    extra,
    '---',
    '',
    `# ${title}`,
    '',
    '## What happened',
    '',
    '- URL: https://www.mattpyle.com/about/',
    body,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

const INDEX = [
  '# Findings index',
  '',
  'One line per finding, maintained by Argus: `key | status | kind | scenario | title | verdict reason`.',
  '',
  'ux-proposed--about | proposed | defect | recruiter | A proposed one | ',
  'ux-reopened--about | reopened | defect | recruiter | A reopened one | Approved by Matt via steward finding approve.',
  'ux-approved--about | approved | opportunity | recruiter | An approved one | Approved.',
  'ux-fixing-orphan--about | fixing | defect | recruiter | A fixing one with no run | Approved.',
  'ux-resolved--about | resolved | defect | recruiter | A resolved one | Approved.',
  'ux-rejected--about | rejected | defect | recruiter | A rejected one | A duplicate.',
  '',
].join('\n');

const FILES: Record<string, string> = {
  [`sites/${SITE}/findings/INDEX.md`]: INDEX,
  [`sites/${SITE}/findings/ux-proposed--about.md`]: finding('ux-proposed--about', 'proposed', 'A proposed <one> & more'),
  [`sites/${SITE}/findings/ux-reopened--about.md`]: finding(
    'ux-reopened--about',
    'reopened',
    'A reopened one',
    'links:\n  pr: https://github.com/mattpyle/mattpyle.com-website/pull/500',
    `\n${buildVerificationSection(REOPENED_VERIFICATION)}\n`,
  ),
  [`sites/${SITE}/findings/ux-approved--about.md`]: finding('ux-approved--about', 'approved', 'An approved one'),
  [`sites/${SITE}/findings/ux-fixing-orphan--about.md`]: finding(
    'ux-fixing-orphan--about',
    'fixing',
    'A fixing one with no run',
    'links:\n  pr: https://github.com/mattpyle/mattpyle.com-website/pull/501',
  ),
  [`sites/${SITE}/findings/ux-resolved--about.md`]: finding('ux-resolved--about', 'resolved', 'A resolved one'),
  [`sites/${SITE}/findings/ux-rejected--about.md`]: finding('ux-rejected--about', 'rejected', 'A rejected one'),
  ['README.md']: '# argus',
};

function blobSha(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function fakeGitHub() {
  const calls: string[] = [];
  const byPath = new Map(Object.entries(FILES).map(([p, text]) => [p, { sha: blobSha(text), text }]));
  const bySha = new Map([...byPath.values()].map((b) => [b.sha, b.text]));
  const ghJson = async (pathname: string) => {
    calls.push(pathname);
    if (pathname === `/repos/${REPO}/git/trees/main?recursive=1`) {
      return {
        truncated: false,
        tree: [
          { path: 'sites', type: 'tree', sha: 'd0' },
          ...[...byPath].map(([p, b]) => ({ path: p, type: 'blob', sha: b.sha })),
        ],
      };
    }
    const sha = /\/git\/blobs\/([0-9a-f]+)$/.exec(pathname)?.[1];
    if (sha && bySha.has(sha)) {
      return { encoding: 'base64', content: Buffer.from(bySha.get(sha) as string).toString('base64') };
    }
    throw new Error(`unexpected GitHub call ${pathname}`);
  };
  return { calls, ghJson };
}

const OPEN = ['ux-proposed--about', 'ux-reopened--about', 'ux-approved--about', 'ux-resolved--about'];

function fakeTemporal() {
  const queried: string[] = [];
  const lists: string[] = [];
  const client: ConsoleClient = {
    workflow: {
      async *list({ query }) {
        lists.push(query);
        if (query.includes("WorkflowType='findingWorkflow'")) {
          for (const key of OPEN) {
            yield { workflowId: `finding/${SITE}/${key}`, startTime: new Date('2026-10-29T10:00:00Z'), status: { name: 'RUNNING' } };
          }
          yield { workflowId: `finding/${SITE}/ux-gone--about`, startTime: new Date('2026-10-29T10:00:00Z'), status: { name: 'RUNNING' } };
        } else if (query.includes("WorkflowType='verifyFindingWorkflow'")) {
          yield {
            workflowId: 'verify/mattpyle-com/ux-other--about/2026-10-30T041233Z',
            startTime: new Date('2026-10-30T04:12:33Z'),
            closeTime: new Date('2026-10-30T04:20:00Z'),
            status: { name: 'FAILED' },
          };
        }
      },
      getHandle(workflowId: string) {
        return {
          async query<R>(): Promise<R> {
            queried.push(workflowId);
            const key = workflowId.split('/')[2];
            const state: FindingState = {
              site: SITE,
              key,
              status: 'done',
              verdict: { status: 'approved', reason: 'Approved.', source: 'cli', at: '2026-10-29T11:00:00Z' },
              commitSha: 'abc',
              stopAfter: 'resolved',
              step: 'waiting-fix',
              lastFixError: 'the issue had no PR after 60 minutes',
            };
            return state as R;
          },
        };
      },
    },
  };
  return { client, queried, lists };
}

const PAGE = { token: 'tok-123', timeZone: 'America/Vancouver', webUi: 'https://cloud.temporal.io', namespace: 'ns', fonts: false };

test('the page shows the three groups, a drift row, the failed-verify strip and a reopened finding\'s measured values', async () => {
  const gh = fakeGitHub();
  const temporal = fakeTemporal();
  const loader = createFindingsLoader({ repo: REPO, ghJson: gh.ghJson, client: temporal.client, now: () => new Date('2026-10-31T12:00:00Z') });
  const model = await loader.load();
  const html = renderFindingsPage(model, PAGE);

  // The three groups, in order, with done behind a closed <details>.
  const verdictAt = html.indexOf('Needs a verdict (2)');
  const flightAt = html.indexOf('In flight (2)');
  const doneAt = html.indexOf('<details><summary>Done (2)</summary>');
  assert.ok(verdictAt > 0 && flightAt > verdictAt && doneAt > flightAt, 'groups in order');
  assert.doesNotMatch(html, /<details open/);

  // Drift: a fixing finding with no open run, a resolved one with a run, and a run with no index line.
  assert.match(html, /drift: fixing with no open run/);
  assert.match(html, /drift: resolved with an open run/);
  assert.match(html, /Open runs with no INDEX\.md line: .*finding\/mattpyle-com\/ux-gone--about/);

  // The failed-verify strip, above the first site section.
  const stripAt = html.indexOf('id="failed-verifies"');
  assert.ok(stripAt > 0 && stripAt < html.indexOf('<section'), 'the strip leads');
  assert.match(html, /1 verify run closed other than Completed in the last 7 days/);
  assert.match(html, /FAILED<\/span> <a href="https:\/\/cloud\.temporal\.io\/namespaces\/ns\/workflows\/verify%2Fmattpyle-com%2Fux-other--about%2F2026-10-30T041233Z">/);
  const failedQuery = temporal.lists.find((q) => q.includes('verifyFindingWorkflow')) ?? '';
  assert.match(failedQuery, /ExecutionStatus!='Completed'/);
  assert.match(failedQuery, /CloseTime > '2026-10-24T12:00:00\.000Z'/);

  // The reopened finding: its outcome and its failed check's expected and measured values.
  assert.match(html, /<span class="fail">reopened<\/span>/);
  assert.match(html, /1 of 2 checks passed/);
  assert.match(
    html,
    /2\. <code>js<\/code> on https:\/\/www\.mattpyle\.com\/about\/ at 390x844\. Expected: true\. Measured: false \(the rail overlaps the header by 32px\)\./,
  );
  assert.match(html, /<a href="https:\/\/github\.com\/mattpyle\/mattpyle\.com-website\/pull\/500">/);

  // The in-flight row carries the step and the last fix error from its state query.
  assert.match(html, /<span class="label">step<\/span>waiting-fix/);
  assert.match(html, /the issue had no PR after 60 minutes/);

  // Forms only on the rows that need a verdict and have a run, each carrying the token.
  assert.equal(html.match(/<form class="verdict"/g)?.length, 2);
  assert.equal(html.match(/name="token" value="tok-123"/g)?.length, 2);

  // Titles and values are escaped.
  assert.match(html, /A proposed &lt;one&gt; &amp; more/);
  assert.doesNotMatch(html, /A proposed <one>/);

  // The counts match INDEX.md and the open-run list.
  assert.match(html, /6 findings: approved 1 · fixing 1 · proposed 1 · rejected 1 · reopened 1 · resolved 1 · open runs 5/);
});

test('a refresh queries the approved and fixing runs only, and reads GitHub once when nothing changed', async () => {
  const gh = fakeGitHub();
  const temporal = fakeTemporal();
  const loader = createFindingsLoader({ repo: REPO, ghJson: gh.ghJson, client: temporal.client });

  const first = await loader.load();
  // The approved run is queried; the fixing one has no run; proposed, reopened and resolved are never asked.
  assert.deepEqual(temporal.queried, [`finding/${SITE}/ux-approved--about`]);
  assert.equal(first.cost.stateQueries, 1);
  assert.equal(first.cost.treeCalls, 1);
  assert.equal(first.cost.blobReads, 7);

  gh.calls.length = 0;
  const second = await loader.load();
  assert.deepEqual(gh.calls, [`/repos/${REPO}/git/trees/main?recursive=1`]);
  assert.equal(second.cost.blobReads, 0);
});

test('drift: each file status against what its run says', () => {
  const run = (open: boolean, step: string | null = null) => ({
    open,
    since: null,
    step,
    queried: step !== null,
    queryError: null,
    prUrl: null,
    issueUrl: null,
    previewResult: null,
    lastFixError: null,
    slotLine: null,
  });
  assert.deepEqual(driftFor('proposed', 'proposed', run(true, 'waiting-verdict')), []);
  assert.deepEqual(driftFor('proposed', 'proposed', run(false)), ['proposed with no open run']);
  assert.deepEqual(driftFor('approved', 'approved', run(false)), ['approved with no open run']);
  assert.deepEqual(driftFor('approved', 'approved', run(true, 'waiting-verdict')), [
    'approved, but the run still waits for a verdict',
  ]);
  assert.deepEqual(driftFor('approved', 'approved', run(true, 'waiting-fix')), []);
  assert.deepEqual(driftFor('fixing', 'fixing', run(true, 'waiting-fix')), ['fixing, but the run waits for a fix']);
  assert.deepEqual(driftFor('fixing', 'fixing', run(true, 'waiting-merge')), []);
  assert.deepEqual(driftFor('resolved', 'resolved', run(false)), []);
  assert.deepEqual(driftFor('rejected', 'rejected', run(true)), ['rejected with an open run']);
  assert.deepEqual(driftFor('approved', 'fixing', run(true, 'waiting-fix')), ['INDEX.md says approved, the file says fixing']);
});

test('a written Verification section reads back with every value', () => {
  const text = `---\nstatus: reopened\n---\n\n# T\n\n${buildVerificationSection(REOPENED_VERIFICATION)}\n`;
  const parsed = parseVerificationSection(text);
  assert.deepEqual(parsed, {
    outcome: 'reopened',
    at: '2026-10-30T18:04:00.000Z',
    workflowId: 'verify/mattpyle-com/ux-reopened--about/2026-10-30T180400Z',
    checks: [
      { n: 1, pass: true, kind: 'selector', url: 'https://www.mattpyle.com/about/', viewport: null, expected: 'at least 1 match', measured: '1 match' },
      {
        n: 2,
        pass: false,
        kind: 'js',
        url: 'https://www.mattpyle.com/about/',
        viewport: '390x844',
        expected: 'true',
        measured: 'false (the rail overlaps the header by 32px)',
      },
    ],
    unparsed: [],
  });
  assert.equal(parseVerificationSection('# no section\n'), null);
  const confirmed = parseVerificationSection(
    buildVerificationSection({
      status: 'resolved',
      at: '2026-10-30T18:04:00.000Z',
      workflowId: 'verify/s/k/2026-10-30T180400Z',
      source: 'finding',
      rows: [],
      deploy: { prUrl: 'https://github.com/o/r/pull/1', mergeSha: 'a', liveSha: 'b' },
    }),
  );
  assert.equal(confirmed?.outcome, 'confirmed');
});
