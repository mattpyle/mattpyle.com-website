import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import type { FindingRow, FindingsModel } from '../../src/console/findings-model.js';

/**
 * The findings page's script, run in a Node vm with no document: its pure half
 * turns a model and a state into the HTML the page places. Each test draws one
 * of the approved mock's states from a fixture model and asserts on that HTML.
 * The DOM half (placing the HTML, the clicks, the fetches) is checked by hand
 * in a browser; the server tests check the page that loads it.
 */

const SCRIPT = fs.readFileSync(new URL('../../src/console/assets/findings.js', import.meta.url), 'utf8');

function load(): any {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(SCRIPT, context);
  return context.StewardFindings;
}
const F = load();

/** The text of a fragment with its tags dropped, for an assertion. A reader for tests, not a sanitiser. */
function textOf(html: string): string {
  let out = '';
  let depth = 0;
  for (const ch of html) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

const RUN = { open: true, since: null, step: 'waiting-verdict', queried: false, queryError: null, prUrl: null, issueUrl: null, previewResult: null, lastFixError: null, slotLine: null };

function row(partial: Partial<FindingRow> & Pick<FindingRow, 'site' | 'key' | 'status'>): FindingRow {
  return {
    fileStatus: partial.status,
    kind: 'defect',
    type: 'content',
    title: `Full title of ${partial.key}`,
    titleShort: null,
    summary: null,
    keyShort: null,
    reason: '',
    priority: 'medium',
    verdictAt: null,
    verdictSource: null,
    opened: '2026-10-20',
    index: 0,
    prUrl: null,
    fileMissing: false,
    run: RUN,
    actions: { fix: false, verify: false },
    verification: null,
    drift: [],
    quietReason: null,
    holdLine: null,
    body: '',
    sections: [{ heading: 'Who wanted what', html: '<p>A reader.</p>' }],
    events: [{ kind: 'first-seen', at: partial.opened ?? '2026-10-20', label: 'First seen by Argus' }],
    ...partial,
  };
}

const MP = 'mattpyle-com';
const TI = 'temporal-io';

const ROWS: FindingRow[] = [
  row({ site: MP, key: 'ux-short--about', status: 'proposed', priority: 'high', opened: '2026-10-27', index: 3, titleShort: 'Short one', summary: 'A summary.', keyShort: 'MP-1', type: 'accessibility' }),
  row({ site: MP, key: 'ux-long--home', status: 'proposed', priority: 'low', opened: '2026-10-01', index: 1, title: 'A <script>alert(1)</script> title' }),
  row({ site: TI, key: 'ti-proposed--docs', status: 'proposed', priority: 'medium', opened: '2026-10-29', index: 0, kind: 'opportunity' }),
  row({
    site: MP, key: 'ux-fixing--blog', status: 'fixing', priority: 'medium', opened: '2026-10-10', index: 2,
    verdictAt: '2026-10-20T16:00:00.000Z', prUrl: 'https://github.com/mattpyle/mattpyle.com-website/pull/533',
    run: { ...RUN, step: 'waiting-merge', queried: true },
  }),
  row({
    site: MP, key: 'ux-drift--feed', status: 'approved', priority: 'high', opened: '2026-10-12', index: 4,
    fileStatus: 'proposed', drift: ['INDEX.md says approved, the file says proposed', 'approved with no open run'], run: { ...RUN, open: false, step: null },
  }),
  row({ site: TI, key: 'ti-quiet--home', status: 'approved', priority: 'low', opened: '2026-10-05', index: 1, quietReason: 'no fixer for this site', run: { ...RUN, open: false, step: null } }),
  row({
    site: MP, key: 'ux-resolved--about', status: 'resolved', priority: 'low', opened: '2026-10-01', index: 5,
    verdictAt: '2026-10-02T04:37:30.000Z', prUrl: 'https://github.com/mattpyle/mattpyle.com-website/pull/500', run: { ...RUN, open: false, step: null },
    events: [
      { kind: 'first-seen', at: '2026-10-01', label: 'First seen by Argus' },
      { kind: 'verdict', at: '2026-10-02T04:37:30.000Z', label: 'Approved', detail: 'Fix it. via cli' },
      { kind: 'pr', at: null, label: 'PR opened', url: 'https://github.com/mattpyle/mattpyle.com-website/pull/500' },
      { kind: 'verification', at: '2026-10-20T09:00:00.000Z', label: 'Verified on production', detail: '1 of 1 checks passed' },
    ],
  }),
  row({ site: TI, key: 'ti-rejected--home', status: 'rejected', priority: 'medium', opened: '2026-10-03', index: 2, reason: 'Duplicate.', verdictAt: '2026-10-04T10:00:00.000Z', run: { ...RUN, open: false, step: null } }),
];

const MODEL: FindingsModel = {
  generatedAt: '2026-10-31T12:00:00.000Z',
  repo: 'test/argus',
  sites: [
    { site: MP, rows: ROWS.filter((r) => r.site === MP), counts: {}, openRuns: 0, orphanRuns: [] },
    { site: TI, rows: ROWS.filter((r) => r.site === TI), counts: {}, openRuns: 0, orphanRuns: [] },
  ],
  failedVerifies: [],
  cost: { treeCalls: 1, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
};

const OPTIONS = { timeZone: 'America/Vancouver', webUi: 'https://web.example', namespace: 'ns.test', now: new Date('2026-10-31T19:00:00Z') };

function render(change: Record<string, unknown> = {}) {
  const state = { ...F.createState(), ...change };
  return { state, v: F.view(MODEL, state, OPTIONS) };
}
const ids = (html: string) => [...html.matchAll(/class="row cols" type="button" data-id="([^"]+)"/g)].map((m) => m[1]);
const count = (html: string, label: string) => new RegExp(`>${label}<span class="count">(\\d+)<`).exec(html)?.[1];

test('closed: Proposed is selected, rows group under High, Medium and Low with their counts, and no panel shows', () => {
  const { v } = render();
  assert.equal(v.open, false);
  assert.equal(v.doc, '');
  assert.equal(v.foot, '');
  assert.equal(v.sort, 'priority');
  assert.match(v.statuses, /data-status="proposed" aria-selected="true">Proposed<span class="count">3</);
  assert.equal(count(v.statuses, 'Approved'), '2');
  assert.equal(count(v.statuses, 'All'), '8');
  assert.doesNotMatch(v.statuses, /Reopened/, 'Reopened shows only when a finding has it');
  assert.deepEqual(ids(v.list), [`${MP}/ux-short--about`, `${TI}/ti-proposed--docs`, `${MP}/ux-long--home`]);
  assert.match(v.list, /<h2 class="group-head"><span class="pri" data-p="high">.*High<\/span><span class="count">1</);
  assert.match(v.list, /Medium<\/span><span class="count">1</);
});

test('a row shows the short title and key when Argus writes them, else the full title and the finding key', () => {
  const { v } = render();
  assert.match(v.list, /<span class="c-ref" title="ux-short--about">MP-1<\/span>\s*<span class="c-title" title="Full title of ux-short--about"><span class="t">Short one<\/span>/);
  assert.match(v.list, /<span class="c-ref" title="ux-long--home">ux-long--home<\/span>\s*<span class="c-title" title="A &lt;script&gt;alert\(1\)&lt;\/script&gt; title"><span class="t">A &lt;script&gt;alert\(1\)&lt;\/script&gt; title<\/span>/);
  assert.doesNotMatch(v.list, /<script/);
  assert.match(v.list, /<img class="site-mark" src="\/icons\/mattpyle-com-16\.png"/);
  assert.match(v.list, /<img class="site-mark" src="\/icons\/temporal-io\.svg"/);
  assert.match(v.list, /<span class="kind" data-k="opportunity" title="Opportunity">/);
  assert.match(v.list, /<span class="cat" data-t="accessibility" title="Accessibility">.*Accessibility<\/span>/);
  assert.match(v.list, /<time datetime="2026-10-27" title="Opened Tue, 27 October 2026">4d<\/time>/);
  assert.match(v.list, /<time datetime="2026-10-01"[^>]*>1 Oct<\/time>/);
});

test('open on a proposed row: the head, the facts with Verdict Pending, one event, and the verdict foot', () => {
  const { v } = render({ current: `${MP}/ux-short--about` });
  assert.equal(v.open, true);
  assert.match(v.list, /data-id="mattpyle-com\/ux-short--about" aria-current="true"/);
  assert.match(v.doc, /<p class="doc-ref">.*mattpyle\.com.*<span class="sep" aria-hidden="true">\/<\/span><span class="ref">MP-1<\/span><\/p>/s);
  assert.match(v.doc, /<h2 class="doc-title">Short one<\/h2>/);
  assert.match(v.doc, /<p class="doc-summary">A summary\.<\/p>/);
  assert.match(v.doc, /<dt>Verdict<\/dt><dd>Pending<\/dd>/);
  assert.match(v.doc, /<dt>Key<\/dt><dd><button class="key-copy"[^>]*aria-label="Copy key ux-short--about">/);
  assert.match(v.doc, /<section class="section"><h3>Who wanted what<\/h3><div class="prose"><p>A reader\.<\/p><\/div><\/section>/);
  assert.equal((v.doc.match(/<li><span>/g) ?? []).length, 1, 'a finding with no verdict has one event');
  assert.match(v.doc, /<li><span>First seen by Argus<\/span><time title="Tue, 27 October 2026">27 Oct<\/time><\/li>/);
  assert.match(v.foot, /<textarea id="reason"/);
  assert.match(v.foot, /<p class="reason-error" id="reason-error" hidden><\/p>/);
  assert.match(v.foot, /data-act="reject"[^>]*>Reject<\/button>/);
  assert.match(v.foot, /data-act="approve"[^>]*>Approve and fix<\/button>/);
  assert.doesNotMatch(v.foot, /Undo/);
});

test('a row with neither short field shows the full title as the heading and no summary line', () => {
  const { v } = render({ current: `${MP}/ux-long--home` });
  assert.match(v.doc, /<h2 class="doc-title">A &lt;script&gt;alert\(1\)&lt;\/script&gt; title<\/h2>/);
  assert.doesNotMatch(v.doc, /doc-summary/);
  assert.match(v.doc, /<span class="ref">ux-long--home<\/span>/);
});

test('a temporal.io finding approves without a fix', () => {
  const { v } = render({ current: `${TI}/ti-proposed--docs` });
  assert.match(v.foot, /title="Records your verdict; nothing is sent to temporal\.io">Approve<\/button>/);
});

test('reject with an empty reason shows the inline message', () => {
  const { v } = render({ current: `${MP}/ux-short--about`, foot: { error: null, sending: false, reasonError: true } });
  assert.match(v.foot, /<div class="reason" data-error>/);
  assert.match(v.foot, /aria-invalid="true"/);
  assert.match(v.foot, /<p class="reason-error" id="reason-error">Add a reason to reject\.<\/p>/);
});

test('a refused verdict shows the console\'s answer in the same place', () => {
  const { v } = render({ current: `${MP}/ux-short--about`, foot: { error: 'No open workflow finding/mattpyle-com/ux-short--about.', sending: false, reasonError: false } });
  assert.match(v.foot, /<p class="reason-error" id="reason-error">No open workflow finding\/mattpyle-com\/ux-short--about\.<\/p>/);
});

test('after a verdict: the recorded verdict, commit and next step in the foot, the badge moves, and Next opens the next proposed', () => {
  const id = `${MP}/ux-short--about`;
  const result = {
    workflowId: `finding/${id}`,
    sent: { status: 'approved', reason: '', source: 'cli', at: '2026-10-31T18:00:00.000Z' },
    recorded: { status: 'approved', reason: '', source: 'cli', at: '2026-10-31T18:00:00.000Z' },
    commitSha: 'abc1234',
    nextStep: 'Steward opens a fix issue.',
    nextStepError: null,
    webUrl: 'https://cloud.temporal.io/x',
  };
  const { v } = render({ current: id, decided: { [id]: { status: 'approved', reason: '', at: result.recorded.at, result } } });
  assert.match(v.foot, /<p>Commit <code>abc1234<\/code><\/p>/);
  assert.match(v.foot, /<p>Steward opens a fix issue\.<\/p>/);
  assert.match(v.foot, /<p class="next"><span class="status"><i class="dot" data-s="approved"><\/i>Approved<\/span><\/p>/);
  assert.match(v.foot, new RegExp(`data-act="next" data-id="${TI}/ti-proposed--docs">Next<`));
  assert.doesNotMatch(v.foot, /textarea|Undo/);
  // The row stays in the list until the next load, with its new badge; the counts move.
  assert.match(v.list, /data-id="mattpyle-com\/ux-short--about" aria-current="true"[\s\S]*?data-s="approved"/);
  assert.equal(count(v.statuses, 'Proposed'), '2');
  assert.equal(count(v.statuses, 'Approved'), '3');
  assert.match(v.doc, /<dt>Verdict<\/dt><dd><time title="Sat, 31 October 2026 at 11:00">31 Oct, 11:00<\/time><\/dd>/);
  assert.match(v.doc, /<li><span>Approved<\/span><time/);
});

test('a fixing row: the ring status, the PR fact and the foot links to the PR', () => {
  const { v } = render({ status: 'fixing', current: `${MP}/ux-fixing--blog` });
  assert.match(v.list, /<i class="dot" data-s="fixing"><\/i>Fixing/);
  assert.match(v.doc, /<dt>PR<\/dt><dd><a href="https:\/\/github\.com\/mattpyle\/mattpyle\.com-website\/pull\/533"[^>]*>#533<\/a><\/dd>/);
  assert.match(v.doc, /<dt>Verdict<\/dt><dd><time[^>]*>20 Oct, 09:00<\/time>/);
  assert.match(v.foot, /<a class="btn" href="https:\/\/github\.com\/mattpyle\/mattpyle\.com-website\/pull\/533"[^>]*>Open PR #533<\/a>/);
});

test('drift: a flag on the row, a chip with the count, and a box in the finding; a quiet row has none', () => {
  const { v } = render({ status: 'approved', current: `${MP}/ux-drift--feed` });
  assert.match(v.list, /data-id="mattpyle-com\/ux-drift--feed"[\s\S]*?<span class="drift" title="Drift: INDEX\.md says approved, the file says proposed; approved with no open run"/);
  assert.match(v.facets, /<button class="drift-chip" type="button" data-act="drift" aria-pressed="false"[^>]*>.*Drift<span class="count">1<\/span>/s);
  assert.match(v.doc, /<div class="drift-box" role="note">.*<li>INDEX\.md says approved, the file says proposed<\/li><li>approved with no open run<\/li>/s);
  const quiet = v.list.split('<li>').find((li: string) => li.includes('ti-quiet--home')) ?? '';
  assert.doesNotMatch(quiet, /class="drift"/);
  assert.match(render().v.facets, /Drift<span class="count">1</, 'the chip counts drift in every status, so it shows on the Proposed tab');
  assert.equal(render({ site: TI }).v.facets.includes('drift-chip'), false, 'no chip when nothing in the site drifts');
  assert.deepEqual(ids(render({ status: 'all', drift: true }).v.list), [`${MP}/ux-drift--feed`]);
});

test('a resolved row: its events oldest first with the PR link, and the foot links to the PR', () => {
  const { v } = render({ status: 'resolved', current: `${MP}/ux-resolved--about` });
  const events = [...v.doc.matchAll(/<li><span>(.*?)<\/span>/g)].map((m) => textOf(m[1]));
  assert.deepEqual(events, ['First seen by Argus', 'Approved: Fix it. via cli', 'PR #500 opened', 'Verified on production: 1 of 1 checks passed']);
  assert.match(v.foot, />Open PR #500<\/a>/);
});

test('a rejected row shows its reason and no foot', () => {
  const { v } = render({ status: 'rejected', current: `${TI}/ti-rejected--home` });
  assert.match(v.doc, /<dt>Reason<\/dt><dd>Duplicate\.<\/dd>/);
  assert.equal(v.foot, '');
});

test('each sort: priority groups, oldest first and newest first make one list, and the Age heading reads the order', () => {
  const all = { status: 'all' };
  const byPri = render(all).v;
  assert.match(byPri.list, /<section class="group">/);
  assert.equal(byPri.ageSort, 'none');
  const oldest = render({ ...all, sort: 'oldest' }).v;
  assert.doesNotMatch(oldest.list, /<section class="group">/);
  assert.equal(oldest.ageSort, 'ascending');
  assert.equal(oldest.sort, 'oldest');
  const order = ids(oldest.list);
  assert.deepEqual(order.slice(0, 2), [`${MP}/ux-long--home`, `${MP}/ux-resolved--about`], 'same day: the INDEX.md order');
  assert.equal(order.at(-1), `${TI}/ti-proposed--docs`);
  const newest = render({ ...all, sort: 'newest' }).v;
  assert.deepEqual(ids(newest.list), [...order].reverse());
  assert.equal(newest.ageSort, 'descending');
  assert.match(newest.facets, /data-on="true" title="Sort">Newest first/);
});

test('each filter: status, site, priority and search narrow the list, and the counts follow the site', () => {
  assert.deepEqual(ids(render({ status: 'rejected' }).v.list), [`${TI}/ti-rejected--home`]);
  const site = render({ status: 'all', site: TI }).v;
  assert.deepEqual(new Set(ids(site.list).map((id: string) => id.split('/')[0])), new Set([TI]));
  assert.equal(count(site.statuses, 'All'), '3');
  assert.match(site.facets, /data-facet="site">\s*<button class="facet-btn" type="button" aria-haspopup="menu" aria-expanded="false" data-on="true">.*temporal\.io/s);
  assert.deepEqual(ids(render({ status: 'all', pri: 'high' }).v.list), [`${MP}/ux-short--about`, `${MP}/ux-drift--feed`]);
  assert.deepEqual(ids(render({ status: 'all', q: 'short one' }).v.list), [`${MP}/ux-short--about`]);
  const none = render({ q: 'nothing like this' }).v.list;
  assert.match(none, /<p>No findings match\.<\/p><button class="linkish" type="button" data-act="clear">Clear filters<\/button>/);
});

test('an open menu lists its choices with counts and ticks the current one', () => {
  const { v } = render({ menu: 'pri' });
  assert.match(v.facets, /role="menuitemradio" aria-checked="true" data-pri="all">All priorities<span class="count">3</);
  assert.match(v.facets, /data-pri="high">.*High<\/span><span class="count">1</s);
  const sort = render({ menu: 'sort' }).v.facets;
  assert.match(sort, /aria-checked="true" data-sort="priority">Priority/);
});

test('a new page has no finding selected, and Next skips a decided finding', () => {
  const state = F.createState();
  assert.equal(state.current, null);
  assert.equal(F.view(MODEL, state, OPTIONS).open, false);
  const rows = F.rowsOf(MODEL);
  const first = rows.find((r: FindingRow) => r.key === 'ux-short--about');
  state.decided[`${TI}/ti-proposed--docs`] = { status: 'rejected' };
  assert.equal(F.nextProposed(rows, state, first).key, 'ux-long--home');
});

test('an empty model renders the empty list, not an error', () => {
  const v = F.view({ ...MODEL, sites: [] }, F.createState(), OPTIONS);
  assert.match(v.list, /No findings match/);
  assert.equal(count(v.statuses, 'All'), '0');
});

const RUN_URL = (id: string) => `https://web.example/namespaces/ns.test/workflows/${encodeURIComponent(id)}`;

test('a verification event and an open run link to the Temporal Web UI', () => {
  const verified = row({
    site: MP, key: 'ux-verified--home', status: 'resolved', run: { ...RUN, open: false, step: null },
    events: [{ kind: 'verification', at: '2026-10-20T09:00:00.000Z', label: 'Verified on production', workflowId: 'verify/mattpyle-com/ux-verified--home/1' }],
  });
  const open = row({ site: MP, key: 'ux-fixing--blog', status: 'fixing', run: { ...RUN, step: 'waiting-merge', queried: true } });
  const model = { ...MODEL, sites: [{ ...MODEL.sites[0], rows: [verified, open] }] };
  const state = { ...F.createState(), status: 'all' };
  const doc = (id: string) => F.view(model, { ...state, current: id }, OPTIONS).doc;

  const href = RUN_URL('verify/mattpyle-com/ux-verified--home/1');
  assert.ok(doc(`${MP}/ux-verified--home`).includes(`<a href="${href}" target="_blank" rel="noopener noreferrer">verify/mattpyle-com/ux-verified--home/1</a>`));
  assert.doesNotMatch(doc(`${MP}/ux-verified--home`), /<dt>Run<\/dt>/, 'a closed run has no Run fact');
  assert.ok(doc(`${MP}/ux-fixing--blog`).includes(`<dt>Run</dt><dd><a href="${RUN_URL('finding/mattpyle-com/ux-fixing--blog')}"`));
  // Without the server's two values the id shows as text and nothing is linked.
  const bare = F.view(model, { ...state, current: `${MP}/ux-fixing--blog` }, { timeZone: 'America/Vancouver', now: OPTIONS.now }).doc;
  assert.match(bare, /<dt>Run<\/dt><dd><code>finding\/mattpyle-com\/ux-fixing--blog<\/code>/);
});

test('orphan runs and failed verifies show in a box above the list, count into the Drift chip, and are silent when empty', () => {
  const none = render({ status: 'approved' });
  assert.doesNotMatch(none.v.list, /drift-box/);
  const model = {
    ...MODEL,
    sites: [{ ...MODEL.sites[0], orphanRuns: ['finding/mattpyle-com/ux-orphan--x'] }, MODEL.sites[1]],
    failedVerifies: [{ workflowId: 'verify/temporal-io/ti-quiet--home/1', site: TI, key: 'ti-quiet--home', status: 'Failed', closeTime: '2026-10-30T18:00:00.000Z' }],
  };
  const state = { ...F.createState(), status: 'approved' };
  const v = F.view(model, state, OPTIONS);
  assert.match(v.list, /^<div class="drift-box"/);
  assert.ok(v.list.includes(`mattpyle.com: open run with no INDEX.md line: <a href="${RUN_URL('finding/mattpyle-com/ux-orphan--x')}"`));
  assert.ok(v.list.includes(`temporal.io: verify run closed as Failed on 30 Oct, 11:00: <a href="${RUN_URL('verify/temporal-io/ti-quiet--home/1')}"`));
  // One drifting row (ux-drift--feed) plus the two site signals.
  assert.match(v.facets, /Drift<span class="count">3</);
  // The site filter narrows the signals and the count.
  const ti = F.view(model, { ...state, site: TI }, OPTIONS);
  assert.doesNotMatch(ti.list, /ux-orphan--x/);
  assert.match(ti.list, /ti-quiet--home\/1/);
  assert.match(ti.facets, /Drift<span class="count">1</);
});

test('a failed load closes the open finding and leaves no foot', () => {
  const state = { ...F.createState(), current: `${MP}/ux-short--about`, foot: { error: 'x', sending: true, reasonError: true } };
  const gone = F.loadFailed(state);
  assert.equal(state.current, null);
  assert.deepEqual({ ...gone }, { open: false, doc: '', foot: '' });
  assert.equal(state.foot.sending, false);
  // The page nulls its model on a failed load; a click on a tab or chip then paints the controls without throwing.
  const v = F.view(null, state, OPTIONS);
  assert.match(v.statuses, /data-status="all"/);
  assert.equal(v.facets.includes('drift-chip'), false);
  assert.match(v.list, /No findings match/);
});

test('titles and summaries keep their backticks', () => {
  const r = row({ site: MP, key: 'ux-ticks--home', status: 'proposed', title: 'The `og:image` tag is missing', summary: 'Add `og:image` to the head.' });
  const model = { ...MODEL, sites: [{ ...MODEL.sites[0], rows: [r] }] };
  const v = F.view(model, { ...F.createState(), current: `${MP}/ux-ticks--home` }, OPTIONS);
  assert.ok(v.list.includes('The `og:image` tag is missing'));
  assert.ok(v.doc.includes('<h2 class="doc-title">The `og:image` tag is missing</h2>'));
  assert.ok(v.doc.includes('Add `og:image` to the head.'));
});

test('the site label is plain in the facet menu and the panel header, and hidden-able in the list', () => {
  const { v } = render({ site: MP, current: `${MP}/ux-short--about` });
  assert.ok(v.list.includes('<span class="lbl">mattpyle.com</span>'));
  assert.ok(v.facets.includes('<span>mattpyle.com</span>'));
  assert.ok(!v.facets.includes('class="lbl"'));
  assert.ok(v.doc.includes('<span>mattpyle.com</span>'));
});

test('the header menu is empty while closed; open, it names the commit and offers the restart', () => {
  const state = F.createState();
  const model = { commit: 'abc1234', behindMaster: false } as unknown as FindingsModel;
  assert.equal(F.menuHtml(model, state), '');
  state.appMenu = true;
  const html = F.menuHtml(model, state);
  assert.match(textOf(html), /Running commit abc1234/);
  assert.match(html, /data-act="restart"/);
  assert.match(textOf(html), /Restart console/);
  assert.doesNotMatch(textOf(html), /steward update/);
});

test('the menu says the restart does not pull only when master has moved on', () => {
  const state = F.createState();
  state.appMenu = true;
  const behind = F.menuHtml({ commit: 'abc1234', behindMaster: true }, state);
  assert.match(textOf(behind), /Restart does not pull: run steward update first/);
  assert.equal(F.view({ sites: [], failedVerifies: [], commit: 'abc1234', behindMaster: true }, state, { timeZone: 'America/Vancouver', webUi: '', namespace: '', now: new Date() }).menu, behind);
});

test('while restarting the menu shows Restarting in place of the item; a failure keeps the item and says why', () => {
  const state = F.createState();
  state.appMenu = true;
  state.restart = 'restarting';
  const busy = F.menuHtml({ commit: 'abc1234' }, state);
  assert.match(textOf(busy), /Restarting/);
  assert.doesNotMatch(busy, /data-act="restart"/);
  state.restart = 'The restart did not start: nope.';
  const failed = F.menuHtml({ commit: 'abc1234' }, state);
  assert.match(failed, /data-act="restart"/);
  assert.match(textOf(failed), /did not start: nope/);
});

test('a model with no commit reads as unknown', () => {
  const state = F.createState();
  state.appMenu = true;
  assert.match(textOf(F.menuHtml(null, state)), /Running commit unknown/);
});

test('each cell in a row names its own value on hover, and the row button carries no title', () => {
  const { v } = render();
  const li = v.list.split('<li>').find((x: string) => x.includes('data-id="mattpyle-com/ux-short--about"')) as string;
  assert.doesNotMatch(li.slice(0, li.indexOf('>') + 1), /title=/, 'the row button has no title');
  assert.match(li, /<span class="c-ref" title="ux-short--about">MP-1</);
  assert.match(li, /<span class="c-title" title="Full title of ux-short--about">/);
  assert.match(li, /<span class="site" title="mattpyle\.com">/);
  assert.match(li, /<span class="cat" data-t="accessibility" title="Accessibility">/);
  assert.match(li, /<span class="kind" data-k="defect" title="Defect">/);
  assert.match(li, /<time datetime="2026-10-27" title="Opened Tue, 27 October 2026">/);
});

test('a query finds a row in any status, the status control reads All, and clearing it returns to the tab', () => {
  const key = 'ux-resolved--about';
  assert.deepEqual(F.visible(F.rowsOf(MODEL), { ...F.createState(), status: 'proposed' }).map((r: FindingRow) => r.key).includes(key), false);
  const { v, state } = render({ status: 'proposed', q: key });
  assert.deepEqual(ids(v.list), [`${MP}/${key}`]);
  assert.match(v.statuses, /data-status="all" aria-selected="true"/);
  assert.match(v.statuses, /data-status="proposed" aria-selected="false"/);
  assert.match(v.facets, /data-facet="status">\s*<button[^>]*data-on="false">All</);
  assert.equal(state.status, 'proposed', 'the chosen tab is kept');
  const back = F.view(MODEL, { ...state, q: '' }, OPTIONS);
  assert.match(back.statuses, /data-status="proposed" aria-selected="true"/);
});
