import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftFor, type FindingRow, type FindingsModel, type SiteSection } from '../../src/console/findings-model.js';
import {
  findingsHref,
  parseFindingsQuery,
  renderFindingsPage,
  type FindingsQuery,
} from '../../src/console/findings-page.js';

/**
 * `/findings`'s query string over a hand-built model: two sites, every
 * status, and one row of each kind `view=todo` keeps and drops. The model is
 * built here rather than loaded, so each row's run and drift are exact.
 */

function row(site: string, key: string, status: string, extra: Partial<FindingRow> & { step?: string | null; open?: boolean } = {}): FindingRow {
  const { step = null, open = false, ...rest } = extra;
  const run = {
    open,
    since: open ? '2026-10-29T10:00:00.000Z' : null,
    step,
    queried: step !== null && step !== 'waiting-verdict',
    queryError: null,
    prUrl: null,
    issueUrl: null,
    previewResult: null,
    lastFixError: null,
    slotLine: null,
  };
  const out: FindingRow = {
    site,
    key,
    status,
    fileStatus: status,
    kind: 'defect',
    title: `Title of ${key}`,
    reason: '',
    priority: 'medium',
    verdictAt: null,
    verdictSource: null,
    opened: null,
    index: 0,
    prUrl: null,
    fileMissing: false,
    run,
    verification: null,
    drift: [],
    ...rest,
  };
  out.drift = driftFor(out.status, out.fileStatus, out.run);
  return out;
}

function section(site: string, rows: FindingRow[]): SiteSection {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  rows.forEach((r, i) => (r.index = i));
  return { site, rows, counts, openRuns: rows.filter((r) => r.run.open).length, orphanRuns: [] };
}

const A = 'mattpyle-com';
const B = 'temporal-io';

function model(): FindingsModel {
  return {
    generatedAt: '2026-10-31T12:00:00.000Z',
    repo: 'test/argus',
    sites: [
      section(A, [
        // Kept by view=todo: a verdict due, drift, a PR waiting on a merge.
        row(A, 'todo-verdict--a', 'proposed', { open: true, step: 'waiting-verdict', opened: '2026-10-20' }),
        row(A, 'todo-drift--a', 'approved', { open: false, opened: '2026-10-25' }),
        row(A, 'todo-merge--a', 'fixing', { open: true, step: 'waiting-merge', opened: '2026-10-10' }),
        // Dropped by view=todo: in flight with no drift, and done.
        row(A, 'skip-fix--a', 'approved', { open: true, step: 'waiting-fix', opened: '2026-10-28' }),
        row(A, 'skip-deploy--a', 'fixing', { open: true, step: 'waiting-deploy' }),
        row(A, 'skip-resolved--a', 'resolved', { opened: '2026-10-01' }),
        row(A, 'skip-rejected--a', 'rejected', { opened: '2026-10-02' }),
      ]),
      section(B, [
        row(B, 'b-first--x', 'proposed', { open: true, step: 'waiting-verdict', opened: '2026-10-27' }),
        row(B, 'b-second--x', 'reopened', { open: true, step: 'waiting-verdict', opened: '2026-10-29' }),
        row(B, 'b-undated--x', 'proposed', { open: true, step: 'waiting-verdict' }),
      ]),
    ],
    failedVerifies: [
      { workflowId: 'verify/mattpyle-com/x--a/2026-10-30T041233Z', site: A, key: 'x--a', status: 'FAILED', closeTime: '2026-10-30T04:20:00.000Z' },
    ],
    cost: { treeCalls: 1, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
  };
}

const PAGE = { token: 'tok', timeZone: 'America/Vancouver', webUi: 'https://cloud.temporal.io', namespace: 'ns', fonts: false };

const render = (qs: string) => renderFindingsPage(model(), PAGE, parseFindingsQuery(new URLSearchParams(qs)));
const rowIds = (html: string) => [...html.matchAll(/<li class="row[^"]*" id="([^"]+)"/g)].map((m) => m[1]);

test('site keeps one section; status keeps one status across the groups', () => {
  const bySite = render(`site=${B}`);
  assert.match(bySite, new RegExp(`<h2 id="site-${B}">`));
  assert.doesNotMatch(bySite, new RegExp(`<h2 id="site-${A}">`));
  assert.match(bySite, new RegExp(`Showing site <strong>${B}</strong>`));
  assert.match(bySite, /<a href="\/findings">Clear filters<\/a>/);

  const byStatus = render('status=proposed');
  assert.deepEqual(rowIds(byStatus).sort(), [`${A}--todo-verdict--a`, `${B}--b-first--x`, `${B}--b-undated--x`]);
  // Groups with nothing to show are dropped, not rendered as None.
  assert.doesNotMatch(byStatus, /In flight/);

  const both = render(`site=${B}&status=reopened`);
  assert.deepEqual(rowIds(both), [`${B}--b-second--x`]);

  const done = render('status=resolved');
  assert.deepEqual(rowIds(done), [`${A}--skip-resolved--a`]);
  assert.match(done, /<details open><summary>Done \(1\)<\/summary>/);
});

test('view=todo keeps a verdict due, drift and a waiting merge, and nothing else', () => {
  const html = render('view=todo');
  assert.deepEqual(rowIds(html).sort(), [
    `${A}--todo-drift--a`,
    `${A}--todo-merge--a`,
    `${A}--todo-verdict--a`,
    `${B}--b-first--x`,
    `${B}--b-second--x`,
    `${B}--b-undated--x`,
  ]);
  for (const skipped of ['skip-fix--a', 'skip-deploy--a', 'skip-resolved--a', 'skip-rejected--a']) {
    assert.doesNotMatch(html, new RegExp(skipped), skipped);
  }
  assert.match(html, /To do: 6 rows need you\.<\/strong>.*Everything else is hidden\./);
  // The failed-verify strip is part of the view.
  assert.match(html, /1 verify run closed other than Completed/);
  assert.match(html, /<a href="\/findings\?view=todo" aria-current="page">To do<\/a>/);
});

test('sort=opened orders each group newest first, sort=opened-asc oldest first, the index as fallback', () => {
  const newest = rowIds(render(`site=${B}&sort=opened`));
  assert.deepEqual(newest, [`${B}--b-second--x`, `${B}--b-first--x`, `${B}--b-undated--x`]);
  const oldest = rowIds(render(`site=${B}&sort=opened-asc`));
  assert.deepEqual(oldest, [`${B}--b-undated--x`, `${B}--b-first--x`, `${B}--b-second--x`]);

  // Within a group only: needs-a-verdict stays ahead of in flight whatever the dates.
  const all = rowIds(render(`site=${A}&sort=opened`));
  assert.equal(all[0], `${A}--todo-verdict--a`);
  assert.deepEqual(all.slice(1, 5), [`${A}--skip-fix--a`, `${A}--todo-drift--a`, `${A}--todo-merge--a`, `${A}--skip-deploy--a`]);
});

test('sort=status orders proposed before reopened within the verdict group', () => {
  const ids = rowIds(render(`site=${B}&sort=status`));
  assert.equal(ids.at(-1), `${B}--b-second--x`);
});

test('an unknown sort, view, status or site renders the unfiltered page', () => {
  const plain = render('');
  for (const qs of ['sort=sideways', 'view=everything', 'status=maybe', 'site=nowhere', 'site=../x']) {
    assert.deepEqual(rowIds(render(qs)), rowIds(plain), qs);
  }
  assert.deepEqual(parseFindingsQuery(new URLSearchParams('sort=sideways&view=x')), {
    site: null,
    status: null,
    sort: 'default',
    view: 'all',
  } satisfies FindingsQuery);
  assert.match(plain, /Showing every finding\./);
});

test('statuses render as distinct badges, in the rows and in the counts line', () => {
  const html = render('');
  for (const s of ['proposed', 'reopened', 'approved', 'fixing', 'resolved', 'rejected']) {
    assert.match(html, new RegExp(`<span class="badge s-${s}">${s}</span>`), s);
    assert.match(html, new RegExp(`\\.s-${s} \\{`), `${s} style`);
  }
  // The counts line: one linked badge per status with its number.
  assert.match(html, /<a href="\/findings\?site=mattpyle-com&amp;status=approved"[^>]*><span class="badge s-approved">approved 2<\/span><\/a>/);
});

test('each row has a copy button; the title leads with the verdicts due', () => {
  const html = render('');
  assert.equal(html.match(/<button type="button" class="copy" data-key="/g)?.length, 10);
  assert.match(html, /data-key="todo-verdict--a"/);
  assert.match(html, /<script src="\/console\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<p id="copy-status" class="sr-only" role="status"/);
  assert.match(html, /<title>4 need a verdict · Steward findings<\/title>/);
});

test('findingsHref drops defaults and keeps a fixed order', () => {
  const q = parseFindingsQuery(new URLSearchParams('view=todo&sort=opened&status=fixing&site=temporal-io'));
  assert.equal(findingsHref(q), '/findings?site=temporal-io&status=fixing&sort=opened&view=todo');
  assert.equal(findingsHref(q, { site: null, status: null, sort: 'default', view: 'all' }), '/findings');
});
