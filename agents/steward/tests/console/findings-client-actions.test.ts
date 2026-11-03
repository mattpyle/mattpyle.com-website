import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import type { FindingRow, FindingsModel } from '../../src/console/findings-model.js';

/**
 * The buttons the page adds for the verbs it runs: Sync findings in the menu, Fix and Verify in the
 * panel foot, and the drift box's two remedies. Same harness as findings-client.test.ts: the script's
 * pure half in a Node vm. A button shows only in its state; the server decides `actions`.
 */

const SCRIPT = fs.readFileSync(new URL('../../src/console/assets/findings.js', import.meta.url), 'utf8');
const context: Record<string, unknown> = {};
vm.runInNewContext(SCRIPT, context);
const F = context.StewardFindings as any;

const RUN = { open: false, since: null, step: null, queried: false, queryError: null, prUrl: null, issueUrl: null, previewResult: null, lastFixError: null, slotLine: null };
const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/533';

function row(partial: Partial<FindingRow> & Pick<FindingRow, 'key' | 'status'>): FindingRow {
  return {
    site: 'mattpyle-com',
    fileStatus: partial.status,
    kind: 'defect',
    type: 'content',
    title: `Title of ${partial.key}`,
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
    verification: null,
    drift: [],
    quietReason: null,
    holdLine: null,
    body: '',
    sections: [],
    events: [],
    actions: { fix: false, verify: false },
    ...partial,
  };
}

const ROWS = [
  row({ key: 'approved-fixable', status: 'approved', drift: ['approved with no open run'], actions: { fix: true, verify: false } }),
  row({ key: 'approved-refused', status: 'approved', drift: ['approved with no open run'] }),
  row({ key: 'fixing-merged', status: 'fixing', prUrl: PR, actions: { fix: false, verify: true } }),
  row({ key: 'fixing-open', status: 'fixing', prUrl: PR }),
  row({ key: 'resolved-one', status: 'resolved', prUrl: PR }),
  row({ key: 'proposed-orphan', status: 'proposed', drift: ['proposed with no open run'] }),
  row({
    key: 'approved-parked',
    status: 'approved',
    kind: 'opportunity',
    run: { ...RUN, open: true, step: 'waiting-fix' },
    holdLine: "The fixer's gate refuses it: it names more than one page (/a, /b) & more.",
    actions: { fix: false, verify: false },
  }),
  row({ key: 'approved-parked-fixable', status: 'approved', run: { ...RUN, open: true, step: 'waiting-fix' }, actions: { fix: true, verify: false } }),
  row({ key: 'proposed-live', status: 'proposed', run: { ...RUN, open: true, step: 'waiting-verdict' } }),
];

const MODEL = {
  generatedAt: '2026-11-01T12:00:00.000Z',
  repo: 'test/argus',
  sites: [{ site: 'mattpyle-com', rows: ROWS, counts: {}, openRuns: 0, orphanRuns: [] }],
  failedVerifies: [],
  cost: { treeCalls: 1, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
  commit: 'abc1234',
  behindMaster: false,
} as unknown as FindingsModel;

const OPTIONS = { timeZone: 'America/Vancouver', webUi: 'https://web.example', namespace: 'ns.test', now: new Date('2026-11-01T19:00:00Z') };

function open(key: string, change: Record<string, unknown> = {}) {
  const state = { ...F.createState(), current: `mattpyle-com/${key}`, ...change };
  return F.view(MODEL, state, OPTIONS);
}

test('Fix shows for an approved finding the server accepts, and nowhere else', () => {
  assert.match(open('approved-fixable').foot, /data-act="fix"[^>]*>Fix<\/button>/);
  for (const key of ['approved-refused', 'fixing-merged', 'fixing-open', 'resolved-one', 'proposed-live']) {
    assert.doesNotMatch(open(key).foot, /data-act="fix"/, key);
  }
});

test('an approved row at waiting-fix shows what holds it, and Fix where the server accepts the parked run', () => {
  const doc = open('approved-parked').doc;
  assert.match(doc, /<dt>Holding<\/dt><dd>The fixer&#39;s gate refuses it: it names more than one page \(\/a, \/b\) &amp; more\.<\/dd>/);
  assert.doesNotMatch(open('approved-fixable').doc, /<dt>Holding<\/dt>/, 'a row with no hold line says nothing');
  assert.doesNotMatch(open('approved-parked').foot, /data-act="fix"/);
  assert.match(open('approved-parked-fixable').foot, /data-act="fix"[^>]*>Fix<\/button>/);
});

test('Verify shows for a fixing finding whose gate accepts it, beside the PR link, and nowhere else', () => {
  const foot = open('fixing-merged').foot;
  assert.match(foot, /data-act="verify"[^>]*>Verify<\/button>/);
  assert.match(foot, />Open PR #533<\/a>/);
  for (const key of ['approved-fixable', 'fixing-open', 'resolved-one', 'proposed-live']) {
    assert.doesNotMatch(open(key).foot, /data-act="verify"/, key);
  }
});

test('a finding the server did not accept keeps the foot it had: the PR link alone, or nothing', () => {
  assert.match(open('fixing-open').foot, /^<div class="actions"><a class="btn"[^>]*>Open PR #533<\/a><\/div>$/);
  assert.equal(open('approved-refused').foot, '');
});

test('after Fix starts, the foot shows the run id and the next step, and the button is gone', () => {
  const ran = { 'mattpyle-com/approved-fixable': { verb: 'fix', workflowId: 'finding/mattpyle-com/approved-fixable', nextStep: 'It opens an issue, then waits for its PR.' } };
  const foot = open('approved-fixable', { ran }).foot;
  assert.match(foot, /Fix started: <a href="https:\/\/web\.example\/namespaces\/ns\.test\/workflows\/finding%2Fmattpyle-com%2Fapproved-fixable"/);
  assert.match(foot, /It opens an issue, then waits for its PR\./);
  assert.doesNotMatch(foot, /data-act="fix"/);
});

test('a refused Fix shows the refusal and keeps the button for a retry', () => {
  const ran = { 'mattpyle-com/approved-fixable': { verb: 'fix', error: 'approved-fixable does not go to the fixer: it has no title line.' } };
  const foot = open('approved-fixable', { ran }).foot;
  assert.match(foot, /role="alert">approved-fixable does not go to the fixer: it has no title line\.<\/p>/);
  assert.match(foot, /data-act="fix"/);
});

test('buttons are disabled while a request is out', () => {
  const foot = open('approved-fixable', { foot: { error: null, sending: true, reasonError: false } }).foot;
  assert.match(foot, /data-act="fix"[^>]*disabled/);
});

test('the drift box offers Sync on "proposed with no open run" and Fix on "approved with no open run" when Fix is accepted', () => {
  assert.match(open('proposed-orphan').doc, /<li>proposed with no open run<button class="btn" type="button" data-act="sync"[^>]*>Sync<\/button><\/li>/);
  assert.match(open('approved-fixable').doc, /<li>approved with no open run<button class="btn" type="button" data-act="fix"/);
  assert.doesNotMatch(open('approved-refused').doc, /data-act="fix"/);
});

test('the drift Sync shows its result in place of the button once it ran', () => {
  const doc = open('proposed-orphan', { sync: { text: 'Started 1, signalled 0, fixed 0, unchanged 4.' } }).doc;
  assert.match(doc, /Started 1, signalled 0, fixed 0, unchanged 4\./);
  assert.doesNotMatch(doc, /data-act="sync"/);
  assert.match(open('proposed-orphan', { sync: 'running' }).doc, /data-act="sync" disabled>Syncing</);
});

test('the menu lists Sync findings above Restart console, and shows the counts a run returned', () => {
  const state = F.createState();
  state.appMenu = true;
  const html = F.menuHtml(MODEL, state);
  assert.ok(html.indexOf('data-act="sync"') > 0 && html.indexOf('data-act="sync"') < html.indexOf('data-act="restart"'));
  assert.match(html, />Sync findings</);
  state.sync = 'running';
  assert.match(F.menuHtml(MODEL, state), /data-act="sync" disabled><span>Syncing findings</);
  state.sync = { text: 'Started 0, signalled 1, fixed 0, unchanged 9.' };
  assert.match(F.menuHtml(MODEL, state), /role="status">Started 0, signalled 1, fixed 0, unchanged 9\.<\/p>/);
  state.sync = { error: 'The schedule did not report a run.' };
  assert.match(F.menuHtml(MODEL, state), /menu-error" role="alert">The schedule did not report a run\./);
});
