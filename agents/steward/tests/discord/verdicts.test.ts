import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure, WorkflowNotFoundError, WorkflowUpdateFailedError } from '@temporalio/client';
import { sendFindingVerdict, type VerdictClient, type VerdictHandle } from '../../src/lib/finding-verdict.js';
import type { FindingVerdict } from '../../src/lib/findings.js';
import { VERDICT_WRITE_FAILED, type VerdictRecorded } from '../../src/workflows/finding.js';
import { parseFindingRef, type FindingRef } from '../../src/lib/finding-ids.js';
import type { ResolvedFinding, ResolvedFindingId } from '../../src/lib/finding-resolve-contract.js';
import { ResolverUnavailable } from '../../src/discord/finding-resolver.js';
import { commandHandler } from '../../src/discord/commands.js';
import { DISCORD_APPROVE_REASON, LOOKUP_FAILED, WORKER_DID_NOT_ANSWER, decideFindings, type VerdictDeps } from '../../src/discord/verdicts.js';
import { verdictCommandDefinitions, verdictCommands } from '../../src/discord/verdict-commands.js';
import type { HandlerResult, Interaction } from '../../src/discord/interactions.js';
import { commandInteraction } from './support.js';

/**
 * From a command to its answer, through the real `sendFindingVerdict` and a
 * fake Temporal handle: one line per finding for every outcome the Update can
 * have, and how `/approve` and `/reject` read their options.
 */

const HELLO: ResolvedFinding = { site: 'mattpyle-com', key: 'content-first-post--hello-world', keyShort: 'MP-121', title: 'Hello World description calls it the first post', autoFix: false };
const RAIL: ResolvedFinding = { site: 'mattpyle-com', key: 'ux-rail-scrollbar--writing', keyShort: 'MP-7', title: 'Sticky rail shows a phantom scrollbar', autoFix: false };
const CREDIT: ResolvedFinding = { site: 'temporal-io', key: 'content-credit-amount--home', keyShort: 'TI-4', title: 'Homepage credit amount differs', autoFix: false };
const KNOWN = [HELLO, RAIL, CREDIT];

type Start = VerdictHandle['startUpdate'];
const completes = (recorded: Omit<VerdictRecorded, 'verdict'> & { verdict?: FindingVerdict }): Start => async (_def, options) => ({
  result: async () => ({ ...recorded, verdict: recorded.verdict ?? options.args[0] }),
});
const updateFailed = (message: string, type?: string) =>
  new WorkflowUpdateFailedError('Workflow Update failed', ApplicationFailure.nonRetryable(message, type));
const fails = (message: string, type?: string): Start => async () => ({
  result: async () => {
    throw updateFailed(message, type);
  },
});
const never = <T>() => new Promise<T>(() => undefined);

interface Script {
  /** By key: how that finding's run answers. Absent means no workflow exists. */
  runs: Record<string, { start: Start; status?: string }>;
  autoFix?: Record<string, boolean>;
  /** When set, the lookup fails with it. */
  resolveError?: Error;
}

function setup(script: Script) {
  const sent: { workflowId: string; verdict: FindingVerdict }[] = [];
  const client: VerdictClient = {
    workflow: {
      getHandle: (workflowId) => {
        const run = script.runs[workflowId.split('/')[2]];
        return {
          workflowId,
          describe: async () => {
            if (!run) throw new WorkflowNotFoundError('not found', workflowId, undefined);
            return { status: { name: run.status ?? 'RUNNING' } };
          },
          startUpdate: (def, options) => {
            sent.push({ workflowId, verdict: options.args[0] });
            return (run as { start: Start }).start(def, options);
          },
        };
      },
    },
  };
  const lookups: FindingRef[][] = [];
  const errors: unknown[] = [];
  const deps: VerdictDeps = {
    resolve: async (refs) => {
      lookups.push([...refs]);
      if (script.resolveError) throw script.resolveError;
      return refs.map((ref): ResolvedFindingId => {
        const matches = KNOWN.filter((entry) => (ref.kind === 'short' ? entry.keyShort === ref.short : entry.key === ref.key));
        return matches.length === 1
          ? { id: ref.text, found: { ...matches[0], autoFix: script.autoFix?.[matches[0].site] ?? false } }
          : { id: ref.text, missing: true };
      });
    },
    // As `main.ts` binds it: the flag from the lookup answers the verdict's `auto_fix` read.
    sendVerdict: (request, autoFix) => sendFindingVerdict(request, { client, readAutoFix: async () => autoFix, waitMs: 40 }),
    onError: (err) => void errors.push(err),
  };
  return { deps, sent, lookups, errors };
}

const refs = (...typed: string[]): FindingRef[] => typed.map((each) => parseFindingRef(each) as FindingRef);

test('a recorded approval is one line: short id, short title, outcome', async () => {
  const { deps, sent } = setup({ runs: { [HELLO.key]: { start: completes({ commitSha: 'c1', first: true, stopAfter: 'verdict' }) } } });
  const answer = await decideFindings(refs('MP-121'), 'approved', 'Real.', deps);
  assert.equal(answer, 'MP-121 Hello World description calls it the first post: recorded');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].workflowId, 'finding/mattpyle-com/content-first-post--hello-world');
  assert.deepEqual({ ...sent[0].verdict, at: '' }, { status: 'approved', reason: 'Real.', source: 'cli', at: '' });
});

test('an approval on a run that goes on to a fix names the next step on the same line', async () => {
  const lifecycle = { start: completes({ commitSha: 'c1', first: true, stopAfter: 'resolved' }) };
  const auto = setup({ runs: { [HELLO.key]: lifecycle }, autoFix: { 'mattpyle-com': true } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Real.', auto.deps),
    'MP-121 Hello World description calls it the first post: recorded; next: its checks, then the fix',
  );
  const manual = setup({ runs: { [HELLO.key]: lifecycle } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Real.', manual.deps),
    'MP-121 Hello World description calls it the first post: recorded; next: its checks, then it waits for Fix',
  );
  // A rejection ends the run: no next step.
  const rejected = setup({ runs: { [HELLO.key]: lifecycle }, autoFix: { 'mattpyle-com': true } });
  assert.match(await decideFindings(refs('MP-121'), 'rejected', 'By design.', rejected.deps), /: recorded$/);
});

test('an earlier verdict of the same status is "already recorded", with its date', async () => {
  const earlier: FindingVerdict = { status: 'approved', reason: 'Earlier.', source: 'cli', at: '2026-11-20T18:00:00.000Z' };
  const { deps } = setup({ runs: { [HELLO.key]: { start: completes({ verdict: earlier, commitSha: null, first: false, stopAfter: 'resolved' }) } } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Again.', deps),
    'MP-121 Hello World description calls it the first post: already recorded (approved on 2026-11-20)',
  );
});

test("a refusal carries the run's own reason", async () => {
  const { deps } = setup({ runs: { [HELLO.key]: { start: fails('The finding is already rejected.') } } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Real.', deps),
    'MP-121 Hello World description calls it the first post: refused: The finding is already rejected.',
  );
});

test('an id that names no finding sends nothing, for any finding in the command', async () => {
  const { deps, sent } = setup({ runs: { [HELLO.key]: { start: completes({ commitSha: 'c1', first: true, stopAfter: 'verdict' }) } } });
  const answer = await decideFindings(refs('MP-121', 'MP-999', 'RAIL-7'), 'approved', 'Real.', deps);
  assert.equal(answer, 'MP-999: no such finding\nRAIL-7: no such finding\nNothing sent for the other finding. Fix the id and send again.');
  assert.equal(sent.length, 0);
  assert.equal(await decideFindings(refs('MP-999'), 'approved', 'Real.', deps), 'MP-999: no such finding');
});

test('an id two findings share is named with both, and nothing is sent', async () => {
  const { deps, sent } = setup({ runs: {} });
  deps.resolve = async (refs) => refs.map((ref) => ({ id: ref.text, ambiguous: [{ site: 'mattpyle-com', key: 'shared--home' }, { site: 'temporal-io', key: 'shared--home' }] }));
  assert.equal(
    await decideFindings(refs('shared--home'), 'approved', 'Real.', deps),
    'shared--home: names 2 findings (mattpyle-com/shared--home, temporal-io/shared--home); use site/key',
  );
  assert.equal(sent.length, 0);
});

test('when the worker does not answer the lookup, the answer says so and nothing is sent', async () => {
  const cause = new Error('activity timed out');
  const late = setup({ runs: {}, resolveError: new ResolverUnavailable(true, cause) });
  assert.equal(await decideFindings(refs('MP-121'), 'approved', 'Real.', late.deps), WORKER_DID_NOT_ANSWER);
  assert.match(WORKER_DID_NOT_ANSWER, /^The worker did not answer/);
  assert.equal(late.sent.length, 0);
  assert.equal(late.errors[0], cause);
  const broken = setup({ runs: {}, resolveError: new ResolverUnavailable(false, new Error('GitHub 502')) });
  assert.equal(await decideFindings(refs('MP-121'), 'approved', 'Real.', broken.deps), LOOKUP_FAILED);
  assert.equal(broken.sent.length, 0);
});

test('a finding with no open run says so, and nothing is sent to it', async () => {
  const closed = setup({ runs: { [HELLO.key]: { start: never, status: 'COMPLETED' } } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Real.', closed.deps),
    'MP-121 Hello World description calls it the first post: no open run; nothing sent',
  );
  assert.equal(closed.sent.length, 0);
  const absent = setup({ runs: {} });
  assert.match(await decideFindings(refs('MP-121'), 'approved', 'Real.', absent.deps), /: no open run; nothing sent$/);
});

test('no worker in time: not recorded, and may still be taken', async () => {
  const { deps } = setup({ runs: { [HELLO.key]: { start: never } } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Real.', deps),
    'MP-121 Hello World description calls it the first post: no worker answered. No worker took the verdict in 0.04s. ' +
      'It is not recorded yet; a worker that returns may still take it.',
  );
});

test('a worker from before the Update: nothing recorded', async () => {
  const { deps } = setup({ runs: { [HELLO.key]: { start: fails('No registered handler for update: record-verdict') } } });
  const answer = await decideFindings(refs('MP-121'), 'approved', 'Real.', deps);
  assert.match(answer, /: no worker answered\. The worker serving this run predates the verdict Update; nothing was recorded\./);
});

test('accepted and still writing, and accepted with a failed write, are told apart from a refusal', async () => {
  const writing = setup({ runs: { [HELLO.key]: { start: async () => ({ result: never }) } } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Real.', writing.deps),
    'MP-121 Hello World description calls it the first post: The run accepted the verdict and is still writing it after 0.04s.',
  );
  const failed = setup({ runs: { [HELLO.key]: { start: fails('The finding file is gone.', VERDICT_WRITE_FAILED) } } });
  assert.equal(
    await decideFindings(refs('MP-121'), 'approved', 'Real.', failed.deps),
    'MP-121 Hello World description calls it the first post: The run accepted the verdict and did not record it: The finding file is gone.',
  );
});

test('an unexpected failure is one fixed phrase in the answer and the error in the log', async () => {
  const detail = ['connection', 'detail'].join(' ');
  const { deps, errors } = setup({
    runs: {
      [HELLO.key]: {
        start: async () => {
          throw new Error(detail);
        },
      },
    },
  });
  const answer = await decideFindings(refs('MP-121'), 'approved', 'Real.', deps);
  assert.equal(answer, 'MP-121 Hello World description calls it the first post: failed; the service log has the error');
  assert.equal((errors[0] as Error).message, detail);
});

test('several findings get one line each, in the order typed, whatever each outcome', async () => {
  const { deps, sent } = setup({
    runs: {
      [HELLO.key]: { start: completes({ commitSha: 'c1', first: true, stopAfter: 'verdict' }) },
      [RAIL.key]: { start: fails('The finding is already rejected.') },
    },
  });
  const answer = await decideFindings(refs('TI-4', 'mp7', 'MP-121', 'content-first-post--hello-world'), 'approved', 'Real.', deps);
  assert.deepEqual(answer.split('\n'), [
    'TI-4 Homepage credit amount differs: no open run; nothing sent',
    'MP-7 Sticky rail shows a phantom scrollbar: refused: The finding is already rejected.',
    // Named twice, by short id and by key: one verdict, one line.
    'MP-121 Hello World description calls it the first post: recorded',
  ]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((each) => each.verdict.reason === 'Real.'));
});

// ---------------------------------------------------------------------------
// The two commands
// ---------------------------------------------------------------------------

function run(name: string, options: Record<string, string>, script: Script = { runs: {} }) {
  const context = setup(script);
  const handler = commandHandler(verdictCommands(context.deps));
  const result = handler(commandInteraction(name, options) as unknown as Interaction);
  return { ...context, result };
}

async function answerOf(result: HandlerResult | null): Promise<string> {
  assert.ok(result && result.kind === 'work', 'the command was not taken as work');
  return result.run();
}

function usageOf(result: HandlerResult | null): string {
  assert.ok(result && result.kind === 'reply', 'the command was taken as work');
  assert.equal(result.message.ephemeral, true);
  return result.message.content;
}

const ALL = {
  runs: Object.fromEntries(KNOWN.map((entry) => [entry.key, { start: completes({ commitSha: 'c1', first: true, stopAfter: 'verdict' }) }])),
};

test('/approve with several ids in mixed case sends each the trailing words as its reason', async () => {
  const { result, sent, lookups } = run('approve', { ids: 'mp121 MP-7, ti-4 fix the heading too' }, ALL);
  const answer = await answerOf(result);
  assert.equal(answer.split('\n').length, 3);
  assert.deepEqual(lookups[0].map((ref) => ref.text), ['MP-121', 'MP-7', 'TI-4']);
  assert.deepEqual(sent.map((each) => each.verdict.reason), ['fix the heading too', 'fix the heading too', 'fix the heading too']);
  assert.ok(sent.every((each) => each.verdict.status === 'approved'));
});

test('/approve with ids alone sends the default reason, which names Discord', async () => {
  const { result, sent } = run('approve', { ids: 'MP-121' }, ALL);
  await answerOf(result);
  assert.equal(sent[0].verdict.reason, DISCORD_APPROVE_REASON);
  assert.match(DISCORD_APPROVE_REASON, /Discord/);
});

test('/approve joins the trailing words and the reason option, in that order', async () => {
  const both = run('approve', { ids: 'MP-121 keep the date', reason: 'drop the label' }, ALL);
  await answerOf(both.result);
  assert.equal(both.sent[0].verdict.reason, 'keep the date drop the label');
  const option = run('approve', { ids: 'MP-121', reason: 'drop the label' }, ALL);
  await answerOf(option.result);
  assert.equal(option.sent[0].verdict.reason, 'drop the label');
});

test('/approve with no id first is a usage answer for the invoking user, and nothing is looked up', () => {
  const { result, lookups } = run('approve', { ids: 'fix the heading MP-121' });
  assert.match(usageOf(result), /Name at least one finding first/);
  assert.equal(lookups.length, 0);
  assert.match(usageOf(run('approve', {}).result), /Name at least one finding first/);
});

test('/reject sends one finding the reason as typed', async () => {
  const { result, sent } = run('reject', { id: 'mp-121', reason: '  By design: the date is the publish date.  ' }, ALL);
  assert.equal(await answerOf(result), 'MP-121 Hello World description calls it the first post: recorded');
  assert.deepEqual(sent.map((each) => [each.verdict.status, each.verdict.reason]), [['rejected', 'By design: the date is the publish date.']]);
});

test('/reject without a reason, or with a blank one, is refused', () => {
  assert.equal(usageOf(run('reject', { id: 'MP-121' }).result), 'A reject needs a reason: say why.');
  assert.equal(usageOf(run('reject', { id: 'MP-121', reason: '   ' }).result), 'A reject needs a reason: say why.');
});

test('/reject takes exactly one finding', () => {
  for (const id of ['MP-121 MP-7', 'MP-121 because', 'because', '']) {
    assert.match(usageOf(run('reject', { id, reason: 'why' }).result), /A reject takes one finding/, id);
  }
});

test('a reason over the cap is refused before anything is sent', () => {
  const long = 'x'.repeat(2001);
  assert.match(usageOf(run('approve', { ids: 'MP-121', reason: long }).result), /over 2000 characters/);
  assert.match(usageOf(run('reject', { id: 'MP-121', reason: long }).result), /over 2000 characters/);
});

test('a command the list does not hold, and an interaction that is not a command, are left to another handler', () => {
  const handler = commandHandler(verdictCommands(setup({ runs: {} }).deps));
  assert.equal(handler(commandInteraction('defer', { id: 'MP-1' }) as unknown as Interaction), null);
  assert.equal(handler({ ...commandInteraction('approve', { ids: 'MP-1' }), type: 3 } as unknown as Interaction), null);
});

test("the definitions fit Discord's rules: required options first, descriptions within 100 characters", () => {
  const definitions = verdictCommandDefinitions();
  assert.deepEqual(definitions.map((each) => each.name), ['approve', 'reject']);
  for (const definition of definitions) {
    assert.equal(definition.type, 1);
    assert.equal(definition.default_member_permissions, '0');
    assert.ok(definition.description.length >= 1 && definition.description.length <= 100);
    const required = definition.options.map((option) => option.required);
    assert.deepEqual(required, [...required].sort((a, b) => Number(b) - Number(a)), 'required options come first');
    for (const option of definition.options) {
      assert.equal(option.type, 3);
      assert.match(option.name, /^[a-z]{1,32}$/);
      assert.ok(option.description.length >= 1 && option.description.length <= 100, option.name);
      assert.ok((option.max_length ?? 1) <= 6000);
    }
  }
  assert.deepEqual(definitions[0].options.map((o) => [o.name, o.required]), [['ids', true], ['reason', false]]);
  assert.deepEqual(definitions[1].options.map((o) => [o.name, o.required]), [['id', true], ['reason', true]]);
});
