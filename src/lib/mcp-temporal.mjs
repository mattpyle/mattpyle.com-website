/**
 * The deep tier's half of the /mcp endpoint: starting `auditSiteWorkflow` on
 * Temporal Cloud from a Vercel function, and reading one back.
 *
 * The fast tier runs the audit inside the function that answered the request. The
 * deep tier cannot: it renders pages in a real browser, takes minutes, and runs on
 * the always-on worker. So this file is a Temporal **client** and nothing else —
 * it starts a workflow, describes it, and queries it. It never runs an activity,
 * never registers a workflow, and holds no audit logic of its own.
 *
 * Every name it needs comes from `@mattpyle/steward/agent-audit/deep-contract`,
 * the workspace's second exports entry: workflow type, task queue, query name,
 * workflow-ID scheme, budgets, and the type of what the query answers. That entry
 * has an empty runtime import graph, so it adds nothing to this function's bundle
 * — the alternative was a hand-copy of six strings on this side that drifts the
 * day one of them changes on the other.
 *
 * ## Three properties, and each one is a failure mode this endpoint had to answer
 *
 * **1. The connection is module-scope; the server and transport are not.** A
 * `Connection` holds no caller state — it is a gRPC channel to Temporal Cloud —
 * so a warm Fluid Compute instance reusing one across requests leaks nothing
 * between callers. A per-request connect would price a TLS handshake and a gRPC
 * channel setup into every deep call, on a user's request path, which is why the
 * Cloud namespace's region was chosen for this endpoint in the first place. The
 * MCP server and transport stay per request for the opposite reason: they *do*
 * hold the in-flight request's streams. Decided deliberately, recorded in the
 * spec, and the asymmetry is the point.
 *
 * **2. Every failure is a JSON-RPC error, never a platform 504.** An unreachable
 * namespace, an expired key, a query nobody answers: all of them come back as a
 * thrown `Error` the SDK renders as a tool error with a readable message. An
 * agent can act on that; it can only guess at an empty gateway timeout. Every
 * call here is therefore bounded by an explicit deadline of its own rather than
 * by the function's.
 *
 * **3. The fast tier never touches this file.** `src/pages/mcp.ts` imports it,
 * but nothing in `audit_site`'s path calls into it, so Temporal Cloud being down
 * leaves the fast tier answering exactly as before. That is the stage-3 card's
 * last Done-when line, and it is a property of the call graph rather than of a
 * try/catch.
 */

import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { randomUUID } from 'node:crypto';
import {
  AUDIT_STATE_QUERY,
  AUDIT_TASK_QUEUE,
  AUDIT_WORKFLOW_TYPE,
  DEEP_BUDGET_SECONDS,
  auditWorkflowIdFor,
} from '@mattpyle/steward/agent-audit/deep-contract';

/**
 * How long a connect may take before the deep tools give up and answer.
 *
 * Well under the function's own timeout, deliberately: the whole point is that a
 * caller is told Temporal is unreachable rather than being handed a gateway
 * timeout with no body. A healthy connect to the namespace endpoint is tens of
 * milliseconds.
 */
const CONNECT_TIMEOUT_MS = 8_000;

/** One `DescribeWorkflowExecution`. A server-side read with no worker in it. */
const DESCRIBE_TIMEOUT_MS = 6_000;

/**
 * One query. Shorter than the others and load-bearing: a query is answered by a
 * **worker**, not by the server, so a run sitting on the queue with no worker
 * free to answer will not answer at all. That timeout is the queued signal — see
 * `readStatus` — rather than an error, which is why it is measured in seconds
 * rather than in tens of them.
 */
const QUERY_TIMEOUT_MS = 4_000;

/** How many open audits the queue-position answer will look at. Bounds one visibility query. */
const QUEUE_SCAN_LIMIT = 50;

/**
 * The three connection variables, read from Vercel's environment variable store.
 *
 * Names in code, values only in the store — the 2026-08-15 configuration rule.
 * The key is the switch, exactly as it is in Steward's own `config.ts`: no key
 * means nothing here is configured, and the deep tools say so instead of trying a
 * connection that would fail later naming neither cause.
 */
export function readTemporalConfig(env = process.env) {
  const address = env.TEMPORAL_ADDRESS ?? '';
  const namespace = env.TEMPORAL_NAMESPACE ?? '';
  const apiKey = env.TEMPORAL_API_KEY ?? '';
  if (!address || !namespace || !apiKey) return null;
  return { address, namespace, apiKey };
}

/**
 * Rejects `promise` after `ms` with a message a caller can act on.
 *
 * The SDK's calls have no per-call deadline, and an endpoint whose slowest path is
 * "wait for the platform to give up" cannot keep property 2 above.
 */
function withDeadline(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The module-scope client, built at most once per warm instance.
 *
 * Held as the **promise** rather than as the resolved value so two concurrent
 * requests on one instance share a single connect rather than racing two. A
 * failed connect clears the slot: caching a rejection would make one bad moment
 * permanent for the life of the instance, which on Fluid Compute can be a long
 * time.
 */
let clientPromise = null;

export function resetTemporalClient() {
  clientPromise = null;
}

async function getClient() {
  const config = readTemporalConfig();
  if (!config) {
    throw new Error(
      'The deep tier is not configured on this deployment: no Temporal connection is set. ' +
        'The fast audit_site tool is unaffected and still works.',
    );
  }
  if (!clientPromise) {
    clientPromise = withDeadline(
      Connection.connect({
        address: config.address,
        tls: true,
        apiKey: config.apiKey,
        // Redundant against the namespace endpoint and not free to omit: API-key
        // auth against a regional endpoint fails with a bare "Request
        // unauthorized" without it. Same reasoning as Steward's config.ts.
        metadata: { 'temporal-namespace': config.namespace },
      }),
      CONNECT_TIMEOUT_MS,
      'Temporal Cloud',
    )
      .then((connection) => new Client({ connection, namespace: config.namespace }))
      .catch((err) => {
        clientPromise = null;
        throw new Error(
          `The deep tier could not reach Temporal: ${err instanceof Error ? err.message : String(err)}. ` +
            'The fast audit_site tool runs in this function and is unaffected.',
        );
      });
  }
  return clientPromise;
}

/**
 * Starts one deep audit and returns its handle, in the time it takes to write a
 * start command to Cloud.
 *
 * It does not wait for a worker to pick the run up, and that is the shape rather
 * than an omission: a deep audit is minutes long, past what any MCP client holds a
 * tool call open for, and the durable handle is what the caller polls instead.
 *
 * @param {string} origin the normalised origin, already validated by the caller
 * @param {string} url exactly what the caller typed
 */
export async function startDeepAudit(origin, url) {
  const client = await getClient();
  const workflowId = auditWorkflowIdFor(origin, 'deep', randomUUID().slice(0, 8));

  await withDeadline(
    client.workflow.start(AUDIT_WORKFLOW_TYPE, {
      workflowId,
      taskQueue: AUDIT_TASK_QUEUE,
      args: [{ url, tier: 'deep', budgetSeconds: DEEP_BUDGET_SECONDS }],
    }),
    DESCRIBE_TIMEOUT_MS,
    'Temporal Cloud',
  );

  return { workflowId, origin, tier: 'deep' };
}

/**
 * How many open deep audits were started before this one, from Temporal's own
 * visibility store.
 *
 * The card's queue-position answer. It matters because Lighthouse is serial per
 * worker process, so two strangers' deep audits on one replica genuinely wait for
 * each other, and a caller told only "running" for four minutes has no way to
 * tell a slow site from a busy queue.
 *
 * Best-effort by construction: a visibility query that fails, or a namespace
 * where it is not enabled, returns `undefined` and the status view simply omits
 * the field. A missing position is a worse answer than a real one and a far
 * better one than a failed status read.
 */
async function queuePositionFor(client, workflowId, startedAt) {
  if (!startedAt) return undefined;
  try {
    let ahead = 0;
    let seen = 0;
    const query = `WorkflowType = '${AUDIT_WORKFLOW_TYPE}' AND ExecutionStatus = 'Running'`;
    for await (const execution of client.workflow.list({ query })) {
      if (++seen > QUEUE_SCAN_LIMIT) break;
      if (execution.workflowId === workflowId) continue;
      if (execution.startTime && execution.startTime < startedAt) ahead++;
    }
    return ahead + 1;
  } catch {
    return undefined;
  }
}

/**
 * The pending activities Temporal reports for one execution, reduced to what a
 * status view says out loud.
 *
 * **This is where "retrying, attempt 2" comes from**, and it comes from the
 * server rather than from the workflow, per the card. An attempt number is the
 * server's account of how many times it has scheduled a unit of work; tracking it
 * in the workflow would be a second, lagging copy of a fact Temporal already
 * holds, and it would be wrong precisely when it mattered — the workflow cannot
 * see a failed attempt of an activity it is still awaiting.
 */
function pendingFrom(description) {
  const raw = description?.raw?.pendingActivities ?? [];
  return raw.map((activity) => ({
    activityType: activity.activityType?.name ?? 'unknown',
    activityId: activity.activityId ?? '',
    attempt: activity.attempt ?? 1,
    state: isStarted(activity.state) ? 'started' : 'scheduled',
    ...(activity.lastFailure?.message ? { lastFailure: activity.lastFailure.message } : {}),
  }));
}

/**
 * `PENDING_ACTIVITY_STATE_STARTED` / `PENDING_WORKFLOW_TASK_STATE_STARTED`, which the SDK hands
 * over as the raw enum number. Both spellings are accepted because whether the enum arrives as a
 * number or as its name is a protobuf-decoding detail, and being wrong about it here would silently
 * turn every run into a queued one.
 */
function isStarted(state) {
  return state === 2 || state === 'Started' || String(state ?? '').endsWith('STATE_STARTED');
}

/**
 * Is this run waiting for a worker, rather than being worked on?
 *
 * **Read off Temporal's pending-task state, and not off a silent query.** The first version of this
 * asked the query and treated "no answer" as queued, which was wrong in the one case that matters:
 * Lighthouse blocks the worker's event loop while it renders, so a worker that is *busy on this
 * very audit* cannot answer a query either. A run three seconds into rendering its second page
 * reported itself queued and first in line. Measured on the Cloud namespace, 2026-08-15.
 *
 * A started workflow task or a started activity means a worker has this run in hand. Everything
 * scheduled and nothing started means it is durable and waiting, which is the honest answer for a
 * caller behind somebody else's audit on the one replica.
 */
function waitingForWorker(description) {
  const raw = description?.raw ?? {};
  const activities = raw.pendingActivities ?? [];
  if (activities.some((activity) => isStarted(activity.state))) return false;
  const task = raw.pendingWorkflowTask;
  if (task && isStarted(task.state)) return false;
  // Neither present is not evidence of waiting — it is a moment this function cannot read — so it
  // answers no rather than guessing.
  return Boolean(task) || activities.length > 0;
}

/**
 * Why one audit ended without a report, in the words of whatever stopped it.
 *
 * A closed execution's failure reaches a client as `Workflow execution failed`
 * with the reason buried on `.cause`. The innermost specific message is what
 * separates a heartbeat timeout from a wedged Chrome from a refused target.
 */
async function failureMessage(handle, execution) {
  const GENERIC = ['Workflow execution failed', 'Activity task failed'];
  try {
    await withDeadline(handle.result(), DESCRIBE_TIMEOUT_MS, 'Temporal Cloud');
  } catch (err) {
    let current = err;
    let best = '';
    for (let depth = 0; current instanceof Error && depth < 6; depth++) {
      if (current.message && !GENERIC.includes(current.message)) best = current.message;
      current = current.cause;
    }
    if (best) return best;
  }
  return `the audit ended ${execution}`;
}

/**
 * One execution's state, from the two sources that answer different questions.
 *
 * `describe()` is the server's account: the execution status, the start and close
 * times, and the pending activities with their attempt numbers. The query is the
 * workflow's own: which steps it has started and finished, and the report once it
 * has one. Both are asked, and the query is best-effort — a run that is still on
 * the task queue with no worker free has nobody to answer it, and that silence is
 * the queued signal rather than an error.
 */
async function readState(workflowId) {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);

  let description;
  try {
    description = await withDeadline(handle.describe(), DESCRIBE_TIMEOUT_MS, 'Temporal Cloud');
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      throw new Error(
        `No audit with workflow ID "${workflowId}". Start one with the deep_audit tool; an ID is ` +
          "only valid for as long as Temporal keeps that run's history.",
      );
    }
    throw err;
  }

  let state;
  let queryError;
  try {
    state = await withDeadline(handle.query(AUDIT_STATE_QUERY), QUERY_TIMEOUT_MS, 'the audit worker');
  } catch (err) {
    queryError = err instanceof Error ? err.message : String(err);
  }

  return { client, handle, description, state, queryError };
}

/**
 * The one sentence a poller reads to learn what is happening right now.
 *
 * The workflow's own note wins when it has one, because only the workflow knows
 * which page it is on. It is **prefixed** rather than replaced when the run is
 * also queued, and that is the whole point of this function: since the hosted
 * worker took its activity concurrency down to one, `queued` no longer means
 * "nothing has picked this up". A run mid-audit can be waiting its turn for the
 * activity slot, and it then answers `queued: true` beside a note saying it is
 * rendering pages. Both are true, and a caller should not have to reconcile them
 * — one sentence says the run is rendering and is waiting for the slot to do it.
 *
 * The two fallbacks, for a run with no note of its own, are unchanged: a queued
 * run nothing has started, and a run whose worker was too busy to answer.
 *
 * @param {{ note?: string, queued: boolean, done: boolean, queryError?: string }} input
 * @returns {string}
 */
export function statusNote({ note, queued, done, queryError }) {
  if (note) return queued ? `queued behind another audit: ${note}` : note;
  if (queued) return 'queued — the audit is started and durable, and no worker has picked it up yet';
  if (done) return queryError ?? 'no state — the run may have ended before it reported any';
  return (
    'running — a worker has this audit in hand and was too busy to answer the progress query in ' +
    'time. Rendering a page occupies the worker, so this is normal mid-audit.'
  );
}

/**
 * The status document.
 *
 * `done` is terminal rather than successful: an audit that fails is a designed
 * outcome, so a `done` meaning COMPLETED alone would leave every failed run's
 * poller looping until it gave up. `succeeded` is the second half of that
 * sentence.
 */
async function readStatus(workflowId) {
  const { client, handle, description, state, queryError } = await readState(workflowId);

  const execution = description.status.name;
  const done = execution !== 'RUNNING';
  const succeeded = execution === 'COMPLETED';
  const startedAt = description.startTime;
  const pending = pendingFrom(description);

  // Reported as a fact with a position rather than as an error, because a caller
  // whose audit is second in line is not looking at a broken endpoint — they are
  // looking at one hosted worker running Lighthouse serially, which is the reason
  // the deep tier has its own low caps in the first place.
  const queued = !done && waitingForWorker(description);

  const status = {
    workflowId,
    url: state?.url ?? 'unknown',
    tier: 'deep',
    execution,
    phase: state?.phase ?? 'unknown',
    note: statusNote({ note: state?.note, queued, done, queryError }),
    done,
    succeeded,
    queued,
    ...(startedAt ? { startedAt: startedAt.toISOString() } : {}),
    ...(description.closeTime ? { finishedAt: description.closeTime.toISOString() } : {}),
    ...(state?.progress ? { progress: state.progress } : {}),
    ...(pending.length > 0 ? { pending } : {}),
    // The report-shape invariant, surfaced on the view a poller reads rather than
    // only inside the document it may never fetch. A finished run whose browser
    // half produced nothing has to say so here, or the caller's next move is to
    // read a degraded report as a clean one.
    ...(state?.result?.integrity ? { integrity: state.result.integrity } : {}),
  };

  if (queued) {
    const position = await queuePositionFor(client, workflowId, startedAt);
    if (position !== undefined) status.queuePosition = position;
  }
  if (done && !succeeded) {
    status.error = await failureMessage(handle, execution);
  }
  return status;
}

/**
 * The finished report, or a refusal that says which.
 *
 * A run that is still going gets an error rather than a placeholder document: an
 * agent handed a 200 and a "not ready" object will summarise it as the audit's
 * findings, and an empty finding list reads as a clean site.
 */
async function readReport(workflowId) {
  // One `readState`, not a `readStatus` plus a second read: a status document is
  // three round trips to Cloud and this path needs one field of it.
  const { handle, description, state } = await readState(workflowId);
  if (state?.result) return state.result;

  const execution = description.status.name;
  if (execution === 'RUNNING') {
    const where =
      state?.note ?? 'queued — the audit is durable and no worker has picked it up yet';
    throw new Error(
      `Audit ${workflowId} is still running (${where}). Call get_audit with view "status" again ` +
        'in a few seconds.',
    );
  }
  throw new Error(
    `Audit ${workflowId} produced no report: ${await failureMessage(handle, execution)}.`,
  );
}

/**
 * One document per view.
 *
 * The stage-2 one-`readView` rule, carried onto the public endpoint: report and
 * summary are two renderings of one document rather than two measurements, so a
 * caller reading the markdown and a caller reading the JSON cannot be told
 * different things about one audit.
 *
 * @param {string} workflowId
 * @param {'status' | 'report' | 'summary'} view
 * @param {(audit: any) => string} renderSummary injected, for the same reason
 *   the fast tier's auditor is: this file is imported by tests with no Temporal.
 */
export async function readAuditView(workflowId, view, renderSummary) {
  if (view === 'status') return `${JSON.stringify(await readStatus(workflowId), null, 2)}\n`;
  const result = await readReport(workflowId);
  return view === 'summary'
    ? `${renderSummary(result)}\n`
    : `${JSON.stringify(result, null, 2)}\n`;
}
