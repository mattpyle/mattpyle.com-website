import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ASK_SKILL_ID,
  AUDIT_SKILL_ID,
  GET_TASK_METHOD,
  LEGACY_GET_TASK_METHODS,
  isAuditTaskId,
  routeMessage,
  targetIn,
  taskStateFor,
} from '../src/lib/a2a-audit-skill.mjs';
import { A2A_METHOD, ERROR_CODES, LEGACY_METHODS, respond } from '../src/lib/a2a-responder.mjs';

const digest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/a2a-digest.json', import.meta.url)), 'utf8')
);

/** Deterministic ids and a frozen clock, so a whole Task can be asserted as bytes. */
function ids() {
  let n = 0;
  return () => `id-${++n}`;
}
const NOW = '2026-08-18T17:00:00.000Z';

const WORKFLOW_ID = 'steward-audit-example.com-deep-1a2b3c4d';

/** A report shaped like the real one where this skill touches it, and no deeper. */
const REPORT = {
  schemaVersion: 3,
  tool: { name: 'steward-audit', version: '0.2.0' },
  target: { input: 'example.com', origin: 'https://example.com' },
  checks: [{ id: 'llms-txt', status: 'fail' }],
};

/**
 * The audit engine, faked whole.
 *
 * Every piece of I/O the skill has is one of these six functions, which is the point of injecting
 * them: this file drives the entire lifecycle — a fast audit, a workflow start, five distinct
 * terminal and non-terminal states — with no Temporal, no network, and no deploy.
 */
function engine(overrides = {}) {
  return {
    originFor: (url) => new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).origin,
    checkLimit: async (tier) => ({ allowed: true, tier }),
    runFast: async () => REPORT,
    startDeep: async () => ({ workflowId: WORKFLOW_ID }),
    readTask: async () => ({ status: running() }),
    renderSummary: (audit) => `# Audit of ${audit.target.origin}\n\n1 check failed.\n`,
    ...overrides,
  };
}

/** The status documents src/lib/mcp-temporal.mjs assembles, for each state worth mapping. */
const queued = () => ({
  workflowId: WORKFLOW_ID,
  url: 'https://example.com',
  execution: 'RUNNING',
  done: false,
  succeeded: false,
  queued: true,
  queuePosition: 2,
  note: 'queued — the audit is started and durable, and no worker has picked it up yet',
});
const running = () => ({
  workflowId: WORKFLOW_ID,
  url: 'https://example.com',
  execution: 'RUNNING',
  done: false,
  succeeded: false,
  queued: false,
  note: 'rendering page 2 of 3',
  progress: { phase: 'rendering', steps: [], checks: [] },
});
const finished = () => ({
  workflowId: WORKFLOW_ID,
  url: 'https://example.com',
  execution: 'COMPLETED',
  done: true,
  succeeded: true,
  queued: false,
  note: 'complete',
});
const failed = () => ({
  workflowId: WORKFLOW_ID,
  url: 'https://example.com',
  execution: 'FAILED',
  done: true,
  succeeded: false,
  queued: false,
  note: 'failed',
  error: 'Chrome did not start within 60s',
});

const post = (body, audit) =>
  respond(JSON.stringify(body), { digest, newId: ids(), now: () => NOW, audit });

const send = (text, audit = engine(), extra = {}) =>
  post(
    {
      jsonrpc: '2.0',
      id: 1,
      method: A2A_METHOD,
      params: { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text }] }, ...extra },
    },
    audit
  );

const getTask = (params, audit = engine(), method = GET_TASK_METHOD) =>
  post({ jsonrpc: '2.0', id: 2, method, params }, audit);

/* ---------------------------------------------------------------- asking for the skill */

test('a request needs both an audit verb and a named site', async () => {
  for (const text of [
    'Audit example.com',
    'audit https://example.com',
    'Run an agent-readiness audit of https://example.com',
    'scan www.example.co.uk please',
  ]) {
    assert.equal(routeMessage({}, text).skill, AUDIT_SKILL_ID, text);
  }

  for (const text of [
    // A verb with nothing to point it at.
    'Can you audit sites?',
    'What does the scorecard audit check?',
    // A site with no verb: a question about this site that happens to name one.
    'What is mattpyle.com about?',
    'Tell me about example.com',
  ]) {
    assert.equal(routeMessage({}, text).skill, ASK_SKILL_ID, text);
  }
});

test('a dotted filename is never mistaken for a site to audit', async () => {
  // This is the guard that keeps `ask-about-site` intact. Half of what the webmaster is asked
  // about is spelled like a hostname, and every one of these questions carries an audit verb as
  // well, so the extension denylist is the only thing standing between them and a stranger's audit.
  for (const text of [
    'audit what agents.md says',
    'scan the llms.txt for problems',
    'audit robots.txt on this site',
    'scan the agent-card.json',
  ]) {
    assert.equal(targetIn(text), null, text);
    assert.equal(routeMessage({}, text).skill, ASK_SKILL_ID, text);
  }
});

test('the tier is fast unless the caller asks for the browser', async () => {
  assert.equal(routeMessage({}, 'audit example.com').tier, 'fast');
  assert.equal(routeMessage({}, 'run a deep audit of example.com').tier, 'deep');
  assert.equal(routeMessage({}, 'audit example.com with lighthouse and axe').tier, 'deep');
});

test('a caller may name the skill and the tier outright rather than guess the words', async () => {
  const named = routeMessage(
    { metadata: { skill: AUDIT_SKILL_ID, tier: 'deep' } },
    'example.com'
  );
  assert.deepEqual(named, {
    skill: AUDIT_SKILL_ID,
    tier: 'deep',
    target: 'example.com',
    explicit: true,
  });

  // And may pin the other skill, so a question that happens to look like an audit stays a question.
  assert.equal(
    routeMessage({ message: { metadata: { skill: ASK_SKILL_ID } } }, 'audit example.com').skill,
    ASK_SKILL_ID
  );
});

/* ---------------------------------------------------------------- the fast tier: a Message */

test('the fast tier answers in the call, as a Message carrying both renderings', async () => {
  const result = await send('audit example.com');

  assert.equal(result.status, 200);
  assert.equal(result.outcome, 'ok/audit-fast');
  const { message, task } = result.payload.result;
  assert.equal(task, undefined, 'the work is over before the reply is written; there is nothing to poll');
  assert.equal(message.role, 'ROLE_AGENT');
  assert.deepEqual(message.parts, [
    { text: '# Audit of https://example.com\n\n1 check failed.\n', mediaType: 'text/markdown' },
    { data: REPORT, mediaType: 'application/json' },
  ]);
});

test('a fast audit that throws is an error naming the target, not an empty report', async () => {
  const result = await send(
    'audit example.com',
    engine({ runFast: async () => { throw new Error('the target refused every request'); } })
  );
  assert.equal(result.outcome, 'audit-failed/fast');
  assert.equal(result.payload.error.code, ERROR_CODES.internal);
  assert.match(result.payload.error.message, /https:\/\/example\.com/);
  assert.match(result.payload.error.message, /refused every request/);
});

/* ---------------------------------------------------------------- the deep tier: a Task */

test('the deep tier answers with a Task whose id is the durable run', async () => {
  const result = await send('run a deep audit of example.com');

  assert.equal(result.outcome, 'ok/audit-deep');
  const { task, message } = result.payload.result;
  assert.equal(message, undefined, 'the work has not started; a Message would be a claim it had');
  assert.equal(task.id, WORKFLOW_ID, 'the Task id IS the Temporal workflow id');
  assert.equal(task.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal(task.status.timestamp, NOW);
  assert.equal(task.artifacts, undefined, 'nothing has been produced yet');
  assert.equal(task.metadata.tier, 'deep');
  assert.equal(task.metadata.workflowId, WORKFLOW_ID);
  assert.match(task.status.message.parts[0].text, new RegExp(GET_TASK_METHOD));
});

test('a deployment with no Temporal says so rather than failing as a broken task', async () => {
  const result = await send(
    'deep audit example.com',
    engine({ startDeep: async () => { throw new Error('no Temporal connection is configured'); } })
  );
  assert.equal(result.outcome, 'audit-unavailable/deep');
  assert.equal(result.payload.error.code, ERROR_CODES.internal);
  assert.match(result.payload.error.message, /fast tier .* is unaffected/);
});

/* ---------------------------------------------------------------- the lifecycle */

test('every state of a durable run maps onto the A2A state that means it', async () => {
  assert.equal(taskStateFor(queued(), false), 'submitted');
  assert.equal(taskStateFor(running(), false), 'working');
  assert.equal(taskStateFor(finished(), true), 'completed');
  // A completed run with no report is a failed audit, not a completed task with no artifact: the
  // caller's next move would be to read an empty artifact list as a clean site.
  assert.equal(taskStateFor(finished(), false), 'failed');
  assert.equal(taskStateFor(failed(), false), 'failed');
  assert.equal(taskStateFor({ ...failed(), execution: 'CANCELED' }, false), 'canceled');
  assert.equal(taskStateFor({ ...failed(), execution: 'TERMINATED' }, false), 'canceled');
});

test('GetTask reports a queued run as submitted, with its position', async () => {
  const result = await getTask({ id: WORKFLOW_ID }, engine({ readTask: async () => ({ status: queued() }) }));

  assert.equal(result.outcome, 'ok/task/submitted');
  assert.equal(result.payload.result.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal(result.payload.result.metadata.queuePosition, 2);
  assert.match(result.payload.result.status.message.parts[0].text, /Position 2\./);
});

test('GetTask reports a run a worker has in hand as working, in its own words', async () => {
  const result = await getTask({ id: WORKFLOW_ID });

  assert.equal(result.outcome, 'ok/task/working');
  assert.equal(result.payload.result.status.state, 'TASK_STATE_WORKING');
  assert.equal(result.payload.result.status.message.parts[0].text, 'rendering page 2 of 3');
  assert.deepEqual(result.payload.result.metadata.progress, running().progress);
});

test('GetTask on a finished run is completed, with the report as one artifact of two parts', async () => {
  const result = await getTask(
    { id: WORKFLOW_ID },
    engine({ readTask: async () => ({ status: finished(), result: REPORT }) })
  );

  assert.equal(result.outcome, 'ok/task/completed');
  const task = result.payload.result;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.artifacts.length, 1, 'one measurement, two renderings — not two artifacts');
  const [artifact] = task.artifacts;
  assert.equal(artifact.artifactId, `${WORKFLOW_ID}-report`);
  assert.equal(artifact.name, 'agent-readiness-report');
  assert.deepEqual(artifact.parts, [
    { text: '# Audit of https://example.com\n\n1 check failed.\n', mediaType: 'text/markdown' },
    { data: REPORT, mediaType: 'application/json' },
  ]);
});

test('a run that ended without a report is a failed task, not a completed empty one', async () => {
  const result = await getTask(
    { id: WORKFLOW_ID },
    engine({ readTask: async () => ({ status: finished() }) })
  );
  assert.equal(result.payload.result.status.state, 'TASK_STATE_FAILED');
  assert.equal(result.payload.result.artifacts, undefined);
});

test('a failed run carries the reason the workflow gave, not a generic one', async () => {
  const result = await getTask({ id: WORKFLOW_ID }, engine({ readTask: async () => ({ status: failed() }) }));
  assert.equal(result.payload.result.status.state, 'TASK_STATE_FAILED');
  assert.equal(result.payload.result.status.message.parts[0].text, 'Chrome did not start within 60s');
});

/* ---------------------------------------------------------------- GetTask's refusals */

test('an id that is not one of ours is TaskNotFound, before any Temporal call', async () => {
  let asked = false;
  const result = await getTask(
    { id: 'some-other-agents-task' },
    engine({ readTask: async () => { asked = true; return { status: running() }; } })
  );

  assert.equal(asked, false, 'a stranger id must not cost a round trip to Cloud');
  assert.equal(result.outcome, 'task-not-found/malformed');
  assert.equal(result.payload.error.code, ERROR_CODES.taskNotFound, 'A2A maps TaskNotFound to -32001');
  assert.equal(result.payload.error.data[0].reason, 'TASK_NOT_FOUND');
});

test('a well-formed id Temporal has never heard of is TaskNotFound too', async () => {
  const result = await getTask(
    { id: WORKFLOW_ID },
    engine({ readTask: async () => { throw new Error(`No audit with workflow ID "${WORKFLOW_ID}".`); } })
  );
  assert.equal(result.outcome, 'task-not-found/unknown');
  assert.equal(result.payload.error.code, ERROR_CODES.taskNotFound);
});

test('a Temporal outage is an internal error, distinct from a task that does not exist', async () => {
  const result = await getTask(
    { id: WORKFLOW_ID },
    engine({ readTask: async () => { throw new Error('Temporal Cloud did not answer within 8s'); } })
  );
  assert.equal(result.outcome, 'task-unreadable');
  assert.equal(result.payload.error.code, ERROR_CODES.internal);
});

test('GetTask with no id names the field and shows a working call', async () => {
  const result = await getTask({});
  assert.equal(result.payload.error.code, ERROR_CODES.invalidParams);
  assert.equal(result.payload.error.data[0].fieldViolations[0].field, 'id');
  assert.match(result.payload.error.message, /steward-audit-example\.com-deep-/);
});

test('an audit request that names no site says what a working one looks like', async () => {
  // Unchanged behaviour, and worth pinning: a bare 'audit' is a scorecard keyword and always was.
  // Naming no site means this was never an audit request, so the keyword classifier still owns it.
  const result = await send('audit', engine());
  assert.equal(result.outcome, 'ok/scorecard');

  // Named outright, though, a missing target is the audit skill refusing rather than the other
  // skill answering.
  const explicit = await send('please', engine(), { metadata: { skill: AUDIT_SKILL_ID } });
  assert.equal(explicit.outcome, 'invalid-params/audit-no-target');
  assert.equal(explicit.payload.error.code, ERROR_CODES.invalidParams);
  assert.match(explicit.payload.error.message, /audit example\.com/);
});

test('a target that is not an http site is refused before anything runs', async () => {
  let ran = false;
  const result = await send('audit ftp.example.com', engine({
    originFor: () => { throw new Error('Only http and https targets are audited'); },
    runFast: async () => { ran = true; return REPORT; },
  }));
  assert.equal(ran, false);
  assert.equal(result.outcome, 'invalid-params/audit-target');
  assert.equal(result.payload.error.code, ERROR_CODES.invalidParams);
});

/* ---------------------------------------------------------------- the shared budget */

test('a refused caller is told which budget, and that the two endpoints share it', async () => {
  const result = await send(
    'deep audit example.com',
    engine({
      checkLimit: async () => ({
        allowed: false,
        tier: 'deep',
        scope: 'caller',
        reason: 'this caller has used 2 deep audits today',
        retryAfterSeconds: 3600,
        limit: 2,
      }),
    })
  );

  assert.equal(result.outcome, 'rate-limited/deep/caller');
  assert.equal(result.payload.error.code, ERROR_CODES.serverError);
  assert.match(result.payload.error.message, /shared with the MCP endpoint/);
  assert.equal(result.payload.error.data[0].metadata.retryAfterSeconds, '3600');
});

test('the limiter is asked before the workflow is started, never after', async () => {
  const order = [];
  await send(
    'deep audit example.com',
    engine({
      checkLimit: async (tier) => { order.push(`limit:${tier}`); return { allowed: true, tier }; },
      startDeep: async () => { order.push('start'); return { workflowId: WORKFLOW_ID }; },
    })
  );
  assert.deepEqual(order, ['limit:deep', 'start'], 'a refused deep call must cost no worker time');
});

test('a refused deep call starts nothing', async () => {
  let started = false;
  await send(
    'deep audit example.com',
    engine({
      checkLimit: async () => ({ allowed: false, tier: 'deep', scope: 'global', reason: 'x', retryAfterSeconds: 10 }),
      startDeep: async () => { started = true; return { workflowId: WORKFLOW_ID }; },
    })
  );
  assert.equal(started, false);
});

test('GetTask spends no budget: polling politely must not lock a caller out', async () => {
  let asked = 0;
  await getTask({ id: WORKFLOW_ID }, engine({ checkLimit: async () => { asked++; return { allowed: true }; } }));
  assert.equal(asked, 0);
});

/* ---------------------------------------------------------------- the 0.x dialect */

test('a 0.x caller gets a 0.x Task, discriminator and lowercase state and all', async () => {
  const result = await post(
    {
      jsonrpc: '2.0',
      id: 1,
      method: LEGACY_METHODS[0],
      params: {
        message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'deep audit example.com' }] },
      },
    },
    engine()
  );

  assert.equal(result.outcome, 'legacy/ok/audit-deep');
  const task = result.payload.result;
  assert.equal(task.task, undefined, 'must not wrap the Task the 1.0 way');
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'submitted', 'the 0.x TaskState is a lowercase string');
  assert.equal(task.status.message.kind, 'message');
  assert.equal(task.status.message.role, 'agent');
  assert.deepEqual(Object.keys(task.status.message.parts[0]), ['kind', 'text']);
});

test('the 0.x tasks/get alias is accepted and answered in its own dialect', async () => {
  const result = await getTask(
    { id: WORKFLOW_ID },
    engine({ readTask: async () => ({ status: finished(), result: REPORT }) }),
    LEGACY_GET_TASK_METHODS[0]
  );

  assert.equal(result.outcome, 'legacy/ok/task/completed');
  const task = result.payload.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.deepEqual(task.artifacts[0].parts.map((part) => part.kind), ['text', 'data']);
});

/* ---------------------------------------------------------------- the endpoint without it */

test('an endpoint with no audit engine refuses the skill rather than answering as the other', async () => {
  const result = await respond(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: A2A_METHOD,
      params: { message: { parts: [{ text: 'audit example.com' }] } },
    }),
    { digest, newId: ids() }
  );

  assert.equal(result.outcome, 'audit-unavailable/not-configured');
  assert.equal(result.payload.error.data[0].metadata.skill, AUDIT_SKILL_ID);
});

test('the task id guard accepts what the workspace generates and nothing else', async () => {
  assert.equal(isAuditTaskId(WORKFLOW_ID), true);
  assert.equal(isAuditTaskId('steward-audit-www.example.co.uk-fast-deadbeef'), true);
  assert.equal(isAuditTaskId('steward-audit-'), false);
  assert.equal(isAuditTaskId('../../etc/passwd'), false);
  assert.equal(isAuditTaskId('steward-audit-example.com deep'), false);
  assert.equal(isAuditTaskId(''), false);
  assert.equal(isAuditTaskId(undefined), false);
});
