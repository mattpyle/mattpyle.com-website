import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';

/**
 * STW-610: the public-audit role bundles `src/workflows/public-audit.ts`, not
 * `index.ts`. This replays the audit fixture against that narrow bundle, so a
 * later change to the entry cannot break replay of an `auditSiteWorkflow` run
 * unnoticed, and checks that the bundle holds no other workflow. The fixture is
 * the one `replay.test.ts` records (`stage3-audit-site-fanout.json`).
 */

const entry = fileURLToPath(new URL('../../src/workflows/public-audit.ts', import.meta.url));
const history = fileURLToPath(new URL('../fixtures/histories/stage3-audit-site-fanout.json', import.meta.url));

test('the audit history replays against the public role\'s narrow bundle', { timeout: 120_000 }, async () => {
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: entry });
  await Worker.runReplayHistory(
    { workflowBundle },
    JSON.parse(await fs.readFile(history, 'utf8')),
    'steward-audit-www.mattpyle.com-deep-fanout1',
  );
});

test('the narrow bundle holds the audit workflow and none of the others', { timeout: 120_000 }, async () => {
  const { code } = await bundleWorkflowCode({ workflowsPath: entry });
  assert.match(code, /auditSiteWorkflow/);
  for (const other of [
    'reviewPostWorkflow',
    'scorecardAuditWorkflow',
    'findingWorkflow',
    'reconcileFindingsWorkflow',
    'verifyFindingWorkflow',
    'recheckFindingsWorkflow',
  ]) {
    assert.ok(!code.includes(other), `${other} is in the public role's bundle`);
  }
});
