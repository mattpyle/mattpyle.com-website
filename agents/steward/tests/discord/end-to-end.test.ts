import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { bounded, createLocalEnv } from '../helpers/test-env.js';
import { workflowBundle } from '../helpers/workflow-bundle.js';
import { skipVerdictMeasure } from '../helpers/verdict-measure.js';
import { DEFECT_FINDING, DEFECT_KEY } from '../helpers/finding-fixtures.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { sendFindingVerdict } from '../../src/lib/finding-verdict.js';
import { findingWorkflowId, type FindingVerdict } from '../../src/lib/findings.js';
import { findingStateQuery, findingWorkflow } from '../../src/workflows/finding.js';
import { commandHandler } from '../../src/discord/commands.js';
import { firstHandler } from '../../src/discord/interactions.js';
import { verdictCommands } from '../../src/discord/verdict-commands.js';
import { DISCORD_APPROVE_REASON } from '../../src/discord/verdicts.js';
import type { ResolvedFinding } from '../../src/lib/finding-resolve-contract.js';
import { STRANGER_ID, commandInteraction, fakeDiscord, startTestServer, testApplication, until } from './support.js';

/**
 * The whole path once, on a real dev server: a signed `/approve` over HTTP
 * reaches the real `findingWorkflow`'s `record-verdict` Update, and the run
 * records it. A bad signature and another user's id reach nothing.
 *
 * The id lookup and the activities are stand-ins (`resolve-finding-ids.test.ts` runs the real lookup); the server, the
 * command, `sendFindingVerdict`, the client and the workflow are the real ones.
 * A server per test, and no test waits on a timer.
 */

const QUEUE = 'steward-findings';
const SITE = 'mattpyle-com';
const ENTRY: ResolvedFinding = { site: SITE, key: DEFECT_KEY, keyShort: 'MP-121', title: 'Perfect score labelled a fail', autoFix: false };

let env: TestWorkflowEnvironment;
let client: Client;

beforeEach(async () => {
  env = await createLocalEnv();
  client = new Client({ connection: env.connection, namespace: env.namespace });
}, { timeout: 120_000 });

afterEach(async () => {
  await env?.teardown();
});

async function scenario(fn: (context: { post: Awaited<ReturnType<typeof startTestServer>>['post']; writes: FindingVerdict[]; followUps: ReturnType<typeof fakeDiscord>['calls'] }) => Promise<void>) {
  const writes: FindingVerdict[] = [];
  const activities = skipVerdictMeasure({
    writeFindingVerdict: async (input: { status: FindingVerdict['status']; reason: string; source: FindingVerdict['source']; at: string }) => {
      writes.push({ status: input.status, reason: input.reason, source: input.source, at: input.at });
      return { findingCommitSha: 'c-file', indexCommitSha: 'c-index', commitSha: 'c-index' };
    },
    readFinding: async (_repo: string, path: string) => ({ path, text: DEFECT_FINDING, sha: 'sha-1', data: parseFrontmatter(DEFECT_FINDING).data }),
    readVerifyBlock: async () => ({ handoff: null, hasBlock: false, checks: [], source: 'finding' as const }),
    readSiteAutoFix: async () => false,
    requestFixSlot: async () => ({ paths: [], dispatched: false }),
  });
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    workflowBundle: await workflowBundle(),
    activities,
    taskQueue: QUEUE,
  });
  const discord = fakeDiscord();
  const commands = verdictCommands({
    resolve: async (refs) => refs.map((ref) => (ref.kind === 'short' && ref.short === ENTRY.keyShort ? { id: ref.text, found: ENTRY } : { id: ref.text, missing: true as const })),
    sendVerdict: (request, autoFix) => sendFindingVerdict(request, { client, readAutoFix: async () => autoFix, waitMs: 20_000 }),
  });
  // A short window, so the answer takes the deferred path whatever the machine's speed.
  const server = await startTestServer(firstHandler([commandHandler(commands)]), { fetch: discord.fetch, replyBudgetMs: 1 }, testApplication());
  try {
    await worker.runUntil(bounded(fn({ post: server.post, writes, followUps: discord.calls })));
  } finally {
    await server.server.close();
  }
}

function startRun() {
  return client.workflow.start(findingWorkflow, {
    workflowId: findingWorkflowId(SITE, DEFECT_KEY),
    taskQueue: QUEUE,
    args: [
      {
        site: SITE,
        key: DEFECT_KEY,
        repo: 'mattpyle/argus',
        findingPath: `sites/${SITE}/findings/${DEFECT_KEY}.md`,
        indexPath: `sites/${SITE}/findings/INDEX.md`,
        stopAfter: 'verdict' as const,
      },
    ],
  });
}

test("a signed /approve reaches the run's record-verdict Update, and the answer names the finding", { timeout: 55_000 }, async () => {
  await scenario(async ({ post, writes, followUps }) => {
    const handle = await startRun();
    const res = await post(commandInteraction('approve', { ids: 'mp121' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { type: 5 });
    await until(() => followUps.length === 1, 'the follow-up');
    assert.equal(followUps[0].body.content, 'MP-121 Perfect score labelled a fail: recorded');

    // The run took the verdict as the Update and wrote it.
    const result = await handle.result();
    assert.equal(writes.length, 1);
    assert.deepEqual(result.verdict, { status: 'approved', reason: DISCORD_APPROVE_REASON, source: 'cli', at: writes[0].at });
    assert.equal(result.commitSha, 'c-index');
    const history = await handle.fetchHistory();
    const accepted = (history.events ?? []).filter((event) => event.workflowExecutionUpdateAcceptedEventAttributes);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input?.name, 'record-verdict');
  });
});

test("a bad signature and another user's id reach no run", { timeout: 55_000 }, async () => {
  await scenario(async ({ post, writes, followUps }) => {
    const handle = await startRun();
    const body = commandInteraction('approve', { ids: 'mp121' });
    const stamp = String(Math.floor(Date.now() / 1000));
    const forged = testApplication().sign(stamp, JSON.stringify(body));
    assert.equal((await post(body, { signature: forged, timestamp: stamp })).status, 401);

    const stranger = await post(commandInteraction('approve', { ids: 'mp121' }, STRANGER_ID));
    assert.equal(stranger.body.type, 4);
    assert.equal(stranger.body.data.flags, 64);

    const state = await handle.query(findingStateQuery);
    assert.equal(state.verdict ?? null, null);
    assert.equal(writes.length, 0);
    assert.equal(followUps.length, 0);
    const history = await handle.fetchHistory();
    assert.ok(!(history.events ?? []).some((event) => event.workflowExecutionUpdateAcceptedEventAttributes));
    await handle.terminate('test over');
  });
});
