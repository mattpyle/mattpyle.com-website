import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEAVY_ACTIVITY_TYPES,
  UpdateRefused,
  findBusyWorkflows,
  prepareUpdate,
  type GitResult,
  type ListingClient,
  type UpdateDeps,
} from '../../src/lib/steward-update.js';

/**
 * `steward update`'s decisions, against fakes for git, Temporal, the process
 * table and npm. What is asserted first in every refusal is that nothing after
 * the refusing step ran: a refusal that had already pulled or killed the worker
 * would be the bug the command exists to prevent.
 */

interface FakeWorkflow {
  workflowId: string;
  type: string;
  pending: string[];
}

function fakeClient(workflows: FakeWorkflow[]): ListingClient {
  return {
    workflow: {
      list: (options: { query?: string }) => {
        assert.equal(options.query, "ExecutionStatus='Running'");
        return (async function* () {
          for (const w of workflows) yield { workflowId: w.workflowId, runId: `run-${w.workflowId}`, type: w.type };
        })();
      },
      getHandle: (workflowId: string) => ({
        describe: async () => ({
          raw: {
            pendingActivities: workflows
              .find((w) => w.workflowId === workflowId)!
              .pending.map((name) => ({ activityType: { name } })),
          },
        }),
      }),
    },
  } as unknown as ListingClient;
}

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });

interface Harness {
  deps: UpdateDeps;
  calls: string[];
  logs: string[];
}

/** A passing environment; each test overrides the one thing it is about. */
function harness(
  overrides: {
    branch?: string;
    diffNames?: string;
    shimEolOnly?: boolean;
    workflows?: FakeWorkflow[];
    connectError?: Error;
    lockChanged?: boolean;
    pullResult?: GitResult;
    head?: string[];
  } = {},
): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  const heads = [...(overrides.head ?? [OLD, NEW])];
  const deps: UpdateDeps = {
    git: async (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --abbrev-ref HEAD') return ok(overrides.branch ?? 'master');
      if (key === 'diff HEAD --name-only') return ok(overrides.diffNames ?? '');
      if (key.startsWith('diff HEAD --ignore-cr-at-eol --quiet')) {
        return { stdout: '', stderr: '', exitCode: overrides.shimEolOnly ? 0 : 1 };
      }
      if (key === 'rev-parse HEAD') return ok(heads.length > 1 ? heads.shift()! : heads[0]);
      if (key === 'pull --ff-only') {
        calls.push('pull');
        return overrides.pullResult ?? ok('Updating');
      }
      if (key.startsWith('diff --name-only') && key.endsWith('-- package-lock.json')) {
        return ok(overrides.lockChanged ? 'package-lock.json' : '');
      }
      throw new Error(`unexpected git call: ${key}`);
    },
    connect: async () => {
      calls.push('connect');
      if (overrides.connectError) throw overrides.connectError;
      return { client: fakeClient(overrides.workflows ?? []), close: async () => void calls.push('close') };
    },
    killOrphans: async () => {
      calls.push('killOrphans');
      return 1;
    },
    npmCi: async () => void calls.push('npmCi'),
    log: (line) => void logs.push(line),
  };
  return { deps, calls, logs };
}

test('findBusyWorkflows names a workflow with a pending steward-heavy activity and skips the rest', async () => {
  const busy = await findBusyWorkflows(
    fakeClient([
      { workflowId: 'finding/a', type: 'findingWorkflow', pending: ['awaitFixPr'] },
      { workflowId: 'steward-review-x', type: 'reviewPost', pending: [] },
      { workflowId: 'fix/b', type: 'fixFindingWorkflow', pending: ['runFixer'] },
    ]),
  );
  assert.deepEqual(busy, [{ workflowId: 'fix/b', workflowType: 'fixFindingWorkflow', activityType: 'runFixer' }]);
});

test('a running heavy activity refuses the update, names the workflow, and changes nothing', async () => {
  const h = harness({
    workflows: [{ workflowId: 'steward-review-my-draft', type: 'reviewPost', pending: ['buildAndAuditDraft'] }],
  });
  await assert.rejects(
    prepareUpdate({ force: false }, h.deps),
    (err: unknown) => {
      assert.ok(err instanceof UpdateRefused);
      assert.match(err.message, /steward-review-my-draft/);
      assert.match(err.message, /buildAndAuditDraft/);
      assert.match(err.message, /--force/);
      return true;
    },
  );
  // The connection was opened and closed; the pull, the kill and the install never happened.
  assert.deepEqual(h.calls, ['connect', 'close']);
});

test('--force skips the check and goes on to pull and restart', async () => {
  const h = harness({
    workflows: [{ workflowId: 'fix/b', type: 'fixFindingWorkflow', pending: ['runFixer'] }],
  });
  const result = await prepareUpdate({ force: true }, h.deps);
  assert.deepEqual(h.calls, ['pull', 'killOrphans']);
  assert.deepEqual(result, { from: OLD, to: NEW, installed: false });
});

test('an idle namespace pulls, stops the stack, and skips npm ci when the lockfile is unchanged', async () => {
  const h = harness({
    workflows: [{ workflowId: 'finding/a', type: 'findingWorkflow', pending: ['awaitFixPr'] }],
  });
  const result = await prepareUpdate({ force: false }, h.deps);
  assert.deepEqual(h.calls, ['connect', 'close', 'pull', 'killOrphans']);
  assert.equal(result.installed, false);
});

test('npm ci runs only when package-lock.json changed between the old and new HEAD', async () => {
  const h = harness({ lockChanged: true });
  const result = await prepareUpdate({ force: false }, h.deps);
  assert.deepEqual(h.calls, ['connect', 'close', 'pull', 'killOrphans', 'npmCi']);
  assert.equal(result.installed, true);
});

test('a pull that moves nothing never asks git about the lockfile', async () => {
  const h = harness({ head: [OLD] });
  const result = await prepareUpdate({ force: false }, h.deps);
  assert.equal(result.installed, false);
  assert.deepEqual(h.calls, ['connect', 'close', 'pull', 'killOrphans']);
});

test('a checkout on another branch is refused before anything connects', async () => {
  const h = harness({ branch: 'feat/x' });
  await assert.rejects(prepareUpdate({ force: false }, h.deps), /on "feat\/x", not master/);
  assert.deepEqual(h.calls, []);
});

test('tracked local changes are refused and named', async () => {
  const h = harness({ diffNames: 'agents/steward/src/cli.ts\npackage.json' });
  await assert.rejects(prepareUpdate({ force: false }, h.deps), /local changes \(agents\/steward\/src\/cli\.ts, package\.json\)/);
  assert.deepEqual(h.calls, []);
});

test('a line-ending-only diff of the steward shim counts as clean, a real one does not', async () => {
  const clean = harness({ diffNames: 'agents/steward/scripts/steward.mjs', shimEolOnly: true });
  await prepareUpdate({ force: false }, clean.deps);
  assert.ok(clean.calls.includes('pull'));

  const edited = harness({ diffNames: 'agents/steward/scripts/steward.mjs', shimEolOnly: false });
  await assert.rejects(prepareUpdate({ force: false }, edited.deps), /steward\.mjs/);
  assert.deepEqual(edited.calls, []);
});

test('a Temporal that cannot be reached refuses, and --force is the way past it', async () => {
  const h = harness({ connectError: new Error('connect ECONNREFUSED') });
  await assert.rejects(prepareUpdate({ force: false }, h.deps), /Could not reach Temporal.*ECONNREFUSED.*--force/s);
  assert.deepEqual(h.calls, ['connect']);
});

test('a pull that cannot fast-forward leaves the worker running', async () => {
  const h = harness({ pullResult: { stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.', exitCode: 128 } });
  await assert.rejects(prepareUpdate({ force: false }, h.deps), /Not possible to fast-forward.*worker was not touched/s);
  assert.ok(!h.calls.includes('killOrphans'));
});

/**
 * The list of heavy activity types is the one fact here that nothing enforces,
 * because a pending activity does not carry its queue. Read the workflow sources
 * and compare, so a workflow that moves an activity onto `steward-heavy` fails
 * this test instead of becoming an activity `steward update` restarts under.
 */
test('HEAVY_ACTIVITY_TYPES matches the activities the workflows schedule on steward-heavy', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'workflows');
  const found = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const proxies = [...source.matchAll(/proxyActivities<\s*Pick<typeof activities,\s*([^>]+?)\s*>\s*>\(/g)];
    for (const [i, m] of proxies.entries()) {
      const end = i + 1 < proxies.length ? proxies[i + 1].index! : source.length;
      const options = source.slice(m.index! + m[0].length, end);
      // The options object, or the shared constant for it, is the first thing after the call.
      const head = options.slice(0, 400);
      const heavy = /^\s*HEAVY_ACTIVITY_OPTIONS/.test(head) || /taskQueue:\s*QUEUE_HEAVY/.test(head);
      if (!heavy) continue;
      for (const name of m[1].split('|').map((n) => n.trim().replace(/^'|'$/g, ''))) found.add(name);
    }
  }
  assert.deepEqual([...found].sort(), [...HEAVY_ACTIVITY_TYPES].sort());
});
