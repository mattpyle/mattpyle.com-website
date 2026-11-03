import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFindingsLoader, holdLineFor, type ConsoleClient, type FindingRunView, type FindingRow } from '../../src/console/findings-model.js';
import { findingWorkflowId } from '../../src/lib/findings.js';
import type { FindingState } from '../../src/workflows/finding.js';

/**
 * What the console says about an approved row whose run waits at `waiting-fix`,
 * and whether it offers Fix: the loader over a fake store with open runs.
 */

const REPO = 'test/argus';
const SITE = 'mattpyle-com';
const ISSUE = 'https://github.com/mattpyle/mattpyle.com-website/issues/900';

function finding(key: string, kind: string, serve: string, measure = true): string {
  return [
    '---',
    `key: ${key}`,
    'status: approved',
    `kind: ${kind}`,
    'type: content',
    'priority: high',
    '---',
    '',
    `# Title of ${key}`,
    '',
    '## What happened',
    '',
    '- URL: https://www.mattpyle.com/about/',
    '',
    '## What would serve them',
    '',
    serve,
    ...(measure ? ['', '## How to measure', '', 'Open the page and look for the change.'] : []),
  ].join('\n');
}

const KEYS = {
  waiting: ['opportunity', 'Change the lede on /about.'],
  refused: ['opportunity', 'Change the lede on /about and the footer on /contact.'],
  failed: ['opportunity', 'Change the lede on /about.'],
  issued: ['defect', 'Change the lede on /about.'],
} as const;

function files(autoFix: boolean): Record<string, string> {
  const out: Record<string, string> = {
    [`sites/${SITE}/config.yaml`]: `site:\n  name: mattpyle.com\n${autoFix ? 'auto_fix: true\n' : ''}`,
    [`sites/${SITE}/findings/INDEX.md`]: Object.entries(KEYS)
      .map(([key, [kind]]) => `${key} | approved | ${kind} | recruiter | Title | Yes.`)
      .join('\n'),
  };
  for (const [key, [kind, serve]] of Object.entries(KEYS)) {
    const body = finding(key, kind, serve);
    // A defect names its cause in the source.
    out[`sites/${SITE}/findings/${key}.md`] = kind === 'defect' ? body.replace('- URL:', '- Cause, from the source: a missing rule.\n- URL:') : body;
  }
  return out;
}

const sha = (text: string) => crypto.createHash('sha1').update(text).digest('hex');

function fakeGitHub(store: Record<string, string>) {
  const byPath = new Map(Object.entries(store).map(([p, text]) => [p, { sha: sha(text), text }]));
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

function fakeClient(states: Record<string, Partial<FindingState>>): ConsoleClient {
  return {
    workflow: {
      async *list(options) {
        if (!options.query.includes("WorkflowType='findingWorkflow'")) return;
        for (const key of Object.keys(states)) {
          yield { workflowId: findingWorkflowId(SITE, key), startTime: new Date('2026-11-02T20:00:00Z'), status: { name: 'RUNNING' } };
        }
      },
      getHandle(workflowId: string) {
        const key = workflowId.split('/')[2];
        return { query: async () => states[key] as never };
      },
    },
  };
}

async function load(autoFix: boolean): Promise<Record<string, FindingRow>> {
  const states: Record<string, Partial<FindingState>> = {
    waiting: { step: 'waiting-fix', fixAttempts: 0, issueUrl: null, lastFixError: null },
    refused: { step: 'waiting-fix', fixAttempts: 1, issueUrl: null, lastFixError: 'refused does not go to the fixer: stale reason.' },
    failed: { step: 'waiting-fix', fixAttempts: 1, issueUrl: null, lastFixError: 'GitHub rejected the credential (403).' },
    issued: { step: 'waiting-fix', fixAttempts: 1, issueUrl: ISSUE, lastFixError: null },
  };
  const loader = createFindingsLoader({ repo: REPO, ghJson: fakeGitHub(files(autoFix)), client: fakeClient(states), now: () => new Date('2026-11-03T12:00:00Z') });
  const model = await loader.load();
  return Object.fromEntries(model.sites[0].rows.map((row) => [row.key, row]));
}

test('an approved row at waiting-fix says what holds it: the gate, else the last failure, else the wait', async () => {
  const rows = await load(true);
  assert.equal(rows.refused.holdLine, "The fixer's gate refuses it: it names more than one page (/about, /contact), so its fix is not one change.");
  assert.equal(rows.failed.holdLine, 'The last fix attempt failed: GitHub rejected the credential (403).');
  assert.equal(rows.waiting.holdLine, 'Waits for the fixer; the next hourly reconcile sends it.');
  assert.equal(rows.issued.holdLine, 'Its fix issue ended without a merged PR; Fix retries it.');
});

test('a site without auto_fix says the wait is the person\'s', async () => {
  const rows = await load(false);
  assert.equal(rows.waiting.holdLine, 'Waits for you: the site has no auto_fix, so Fix starts it.');
});

test('Fix is offered for a parked run the gate accepts and has no issue, and for no other', async () => {
  const rows = await load(true);
  assert.equal(rows.waiting.actions.fix, true);
  assert.equal(rows.failed.actions.fix, true, 'a failed attempt with no issue is a retry the gate accepts');
  assert.equal(rows.refused.actions.fix, false, 'the gate refuses it');
  assert.equal(rows.issued.actions.fix, false, 'it has an issue');
});

test('holdLineFor says nothing for a row that is not an approved one at waiting-fix', () => {
  const run: FindingRunView = { open: true, since: null, step: 'waiting-fix', queried: true, queryError: null, prUrl: null, issueUrl: null, previewResult: null, lastFixError: null, slotLine: null };
  assert.equal(holdLineFor({ status: 'fixing', run, refusal: null, autoFix: true }), null);
  assert.equal(holdLineFor({ status: 'approved', run: { ...run, step: 'waiting-merge' }, refusal: null, autoFix: true }), null);
  assert.equal(holdLineFor({ status: 'approved', run: { ...run, open: false }, refusal: null, autoFix: true }), null);
});
