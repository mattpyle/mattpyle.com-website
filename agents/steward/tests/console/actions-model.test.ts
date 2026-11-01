import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFindingsLoader, type ConsoleClient } from '../../src/console/findings-model.js';

/**
 * `row.actions`: the loader decides, on the server, which buttons a row's foot offers. Fix is for an
 * approved finding with no open run that `fixRefusal` accepts; Verify is for a fixing finding whose
 * PR is merged. A merged PR is asked about once per process.
 */

const REPO = 'test/argus';
const MP = 'mattpyle-com';
const MERGED = 'https://github.com/mattpyle/mattpyle.com-website/pull/600';
const OPEN = 'https://github.com/mattpyle/mattpyle.com-website/pull/601';

function file(key: string, status: string, extra: string[], body: string[]): string {
  return ['---', `key: ${key}`, `status: ${status}`, 'kind: defect', ...extra, '---', '', `# Title of ${key}`, '', ...body].join('\n');
}
const FIXABLE = ['## What happened', '', '- Cause: a missing alt attribute.', '', '## How to measure', '', 'Open /about and look for an alt attribute.'];

const FILES: Record<string, string> = {
  [`sites/${MP}/config.yaml`]: 'site:\n  name: mattpyle.com\n',
  [`sites/${MP}/findings/INDEX.md`]: [
    'ux-fixable | approved | defect | recruiter | Fixable |',
    'ux-no-cause | approved | defect | recruiter | No cause |',
    'ux-merged | fixing | defect | recruiter | Merged |',
    'ux-open-pr | fixing | defect | recruiter | Open PR |',
    'ux-running | approved | defect | recruiter | Running |',
  ].join('\n'),
  [`sites/${MP}/findings/ux-fixable.md`]: file('ux-fixable', 'approved', [], FIXABLE),
  [`sites/${MP}/findings/ux-no-cause.md`]: file('ux-no-cause', 'approved', [], ['## What happened', '', '- Seen on /about.']),
  [`sites/${MP}/findings/ux-merged.md`]: file('ux-merged', 'fixing', [`links:\n  pr: ${MERGED}`], FIXABLE),
  [`sites/${MP}/findings/ux-open-pr.md`]: file('ux-open-pr', 'fixing', [`links:\n  pr: ${OPEN}`], FIXABLE),
  [`sites/${MP}/findings/ux-running.md`]: file('ux-running', 'approved', [], FIXABLE),
};

const sha = (text: string) => crypto.createHash('sha1').update(text).digest('hex');

test('actions offer Fix and Verify only where the CLI gate accepts, and ask about a merged PR once', async () => {
  const byPath = new Map(Object.entries(FILES).map(([p, text]) => [p, { sha: sha(text), text }]));
  const bySha = new Map([...byPath.values()].map((b) => [b.sha, b.text]));
  const prCalls: string[] = [];
  const ghJson = async (pathname: string) => {
    if (pathname === `/repos/${REPO}/git/trees/main?recursive=1`) return { tree: [...byPath].map(([p, b]) => ({ path: p, type: 'blob', sha: b.sha })) };
    const id = /\/git\/blobs\/([0-9a-f]+)$/.exec(pathname)?.[1];
    if (id && bySha.has(id)) return { content: Buffer.from(bySha.get(id) as string).toString('base64') };
    const pr = /\/pulls\/(\d+)$/.exec(pathname)?.[1];
    if (pr) {
      prCalls.push(pr);
      return { merged: pr === '600', state: pr === '600' ? 'closed' : 'open' };
    }
    throw new Error(`unexpected GitHub call ${pathname}`);
  };
  const running = `finding/${MP}/ux-running`;
  const client: ConsoleClient = {
    workflow: {
      async *list(options) {
        if (options.query.includes("WorkflowType='findingWorkflow'")) {
          yield { workflowId: running, startTime: new Date('2026-11-01T10:00:00Z'), status: { name: 'Running' } };
        }
      },
      getHandle: () => ({
        query: async () => ({ step: 'waiting-fix', status: 'waiting' }) as never,
      }),
    },
  };
  const loader = createFindingsLoader({ repo: REPO, ghJson, client, now: () => new Date('2026-11-01T12:00:00Z') });
  const model = await loader.load();
  const actions = Object.fromEntries(model.sites[0].rows.map((r) => [r.key, r.actions]));
  assert.deepEqual(actions['ux-fixable'], { fix: true, verify: false });
  assert.deepEqual(actions['ux-no-cause'], { fix: false, verify: false });
  assert.deepEqual(actions['ux-merged'], { fix: false, verify: true });
  assert.deepEqual(actions['ux-open-pr'], { fix: false, verify: false });
  assert.deepEqual(actions['ux-running'], { fix: false, verify: false }, 'an open run is not offered Fix');

  await loader.load();
  assert.deepEqual(prCalls.filter((n) => n === '600'), ['600'], 'the merged PR is asked once');
  assert.deepEqual(prCalls.filter((n) => n === '601'), ['601', '601'], 'an open PR is asked again');
});
