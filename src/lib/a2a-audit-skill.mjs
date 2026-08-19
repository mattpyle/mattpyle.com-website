/**
 * The endpoint's second skill: audit a site, as an A2A Task.
 *
 * `ask-about-site` is a deterministic kiosk — one question, one answer, no state — and it is a
 * valid but degenerate use of a protocol built for delegated work. The audit is this site's one
 * genuinely A2A-shaped workload, and this file is the whole of its A2A half.
 *
 * **Two tiers, two shapes, and each shape follows from the cost.** The fast tier is a dozen HTTP
 * round trips at the target's origin, seconds, run inside the function that answered the call: it
 * comes back as a direct `Message`, the way `ask-about-site` does. The deep tier renders up to
 * three of the target's pages in a real browser on a hosted worker and takes minutes, past what
 * any client holds a call open for: it comes back as a `Task`, and the caller polls `GetTask`
 * through `submitted` and `working` to `completed`, where the report is the task's artifact. This
 * is exactly the split `/mcp` makes between `audit_site` and `deep_audit` plus `get_audit`, over a
 * different protocol against the same machinery.
 *
 * **The Task id is the Temporal workflow id.** Not a second identifier mapped onto the first: the
 * durable run *is* the task, its id is already public through `/mcp`, and it is already the label
 * the Temporal UI shows. A caller who starts an audit over A2A and one who starts it over MCP hold
 * the same handle to the same thing, which is the cross-protocol comparison this experiment is for.
 *
 * PURE. Every piece of I/O arrives as an injected function — the fast audit, the workflow start,
 * the status read, the rate limiter, the clock, the id factory — for the same reason
 * src/lib/a2a-responder.mjs is pure: tests/a2a-audit-skill.test.mjs drives the whole lifecycle with
 * a fake workflow and no Temporal, no network and no deploy. Nothing here starts anything.
 *
 * NO MODEL, ANYWHERE. The skill starts workflows and reports state. It does not read a report, does
 * not rank findings and does not answer questions about one. That keeps a public unauthenticated
 * URL off anyone's inference bill and off the prompt-injection surface a "what should I fix first?"
 * turn would open.
 */

import {
  AGENT_CARD_URL,
  ERROR_CODES,
  badRequest,
  errorInfo,
  errorResponse,
} from './a2a-rpc.mjs';

/** The skills this endpoint declares. The Agent Card is validated against this list. */
export const ASK_SKILL_ID = 'ask-about-site';
export const AUDIT_SKILL_ID = 'audit-a-site';
export const SKILL_IDS = Object.freeze([ASK_SKILL_ID, AUDIT_SKILL_ID]);

/** The second method the endpoint answers, in its A2A 1.0 spelling, and the 0.x alias. */
export const GET_TASK_METHOD = 'GetTask';
export const LEGACY_GET_TASK_METHODS = Object.freeze(['tasks/get']);

/**
 * `auditWorkflowIdFor` in the Steward workspace writes `steward-audit-<host>-<tier>-<suffix>`.
 * Matched by its prefix rather than by the whole scheme: this guard exists so a caller who passes
 * an arbitrary string gets `TaskNotFound` instead of a Temporal lookup, and re-encoding the id
 * scheme here would be the hand-copy the deep-contract entry exists to avoid.
 */
const TASK_ID_PATTERN = /^steward-audit-[A-Za-z0-9.-]{1,240}$/;

export function isAuditTaskId(id) {
  return typeof id === 'string' && TASK_ID_PATTERN.test(id);
}

/* ------------------------------------------------------------------ asking for the skill */

/**
 * The words that ask for an audit.
 *
 * Deliberately narrow. `check`, `review`, `look at` and `assess` were all candidates and all
 * dropped: this list is only half of the guard — a message has to name a target as well — but the
 * half that is a *verb* is the half that decides whether "check the scorecard for mattpyle.com" is
 * a question about this site or a request to audit it. The Agent Card's examples teach the word,
 * and a caller who would rather not guess names the skill in `metadata.skill`.
 */
const AUDIT_VERBS = [
  'audit', 'audits', 'audited', 'auditing', 'agent-readiness', 'agent readiness', 'scan', 'scans',
];

/** Words that ask for the browser-rendered tier specifically. Anything else is the fast tier. */
const DEEP_WORDS = ['deep', 'deeper', 'lighthouse', 'axe', 'rendered', 'browser', 'thorough'];

/**
 * Extensions that make a dotted token a filename rather than a hostname.
 *
 * Load-bearing, and the reason target matching is a denylist of last labels rather than an
 * allowlist of TLDs: half of what `ask-about-site` is asked about is spelled like a hostname.
 * "What does agents.md say?" and "does this site have an llms.txt?" both carry a dotted token, and
 * without this list both would be read as a request to audit a site called `agents.md`.
 */
const FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'txt', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts',
  'tsx', 'jsx', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'woff2', 'zip',
]);

/** A dotted token with a plausible final label: two or more letters, and not a file extension. */
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{2,5})?(?:\/\S*)?$/i;

/**
 * The question, split into tokens with the punctuation a sentence puts around a URL removed.
 *
 * Not the responder's `normalize`: that flattens `:` and `/` to spaces, which is right for keyword
 * matching and destroys exactly the characters a URL is made of.
 */
function tokenize(text) {
  return String(text ?? '')
    .split(/[\s,;]+/)
    .map((token) => token.replace(/^[('"`<[{]+/, '').replace(/[)'"`>\]}.,;:!?]+$/, ''))
    .filter(Boolean);
}

/**
 * The first token in the message that names a site, or null.
 *
 * A token with a scheme wins outright wherever it appears, because a caller who typed
 * `https://…` has been explicit. Otherwise the first bare hostname is taken.
 */
export function targetIn(text) {
  const tokens = tokenize(text);
  const explicit = tokens.find((token) => /^https?:\/\/\S+$/i.test(token));
  if (explicit) return explicit;
  for (const token of tokens) {
    if (!HOST_PATTERN.test(token)) continue;
    const host = token.split(/[/:]/)[0];
    const last = host.split('.').pop().toLowerCase();
    if (last.length < 2 || !/^[a-z]+$/.test(last) || FILE_EXTENSIONS.has(last)) continue;
    return token;
  }
  return null;
}

/** Whether a lowercased, space-padded message contains any of `words` as whole tokens. */
function mentions(padded, words) {
  return words.some((word) => padded.includes(` ${word} `));
}

/**
 * Which skill this message is for, and on what terms.
 *
 * Two ways in, and the explicit one wins. A caller may name the skill in `metadata.skill` (on the
 * request or on the message) and the tier in `metadata.tier`, which is the form a client built
 * from the Agent Card will reach for. Plain text works too, because most callers will type a
 * sentence: it needs an audit verb **and** a token that names a site, and needing both is what
 * keeps `ask-about-site` exactly as it was — none of its pinned questions names a site, and this
 * function is asked before the keyword classifier is.
 *
 * @param {object} params the SendMessage params
 * @returns {{ skill: string, tier?: 'fast' | 'deep', target?: string | null, explicit: boolean }}
 */
export function routeMessage(params, text) {
  const metadata = { ...(params?.metadata ?? {}), ...(params?.message?.metadata ?? {}) };
  const named = typeof metadata.skill === 'string' ? metadata.skill : null;
  const padded = ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9.+:/-]+/g, ' ')} `;
  const tierNamed = metadata.tier === 'deep' || metadata.tier === 'fast' ? metadata.tier : null;

  if (named === AUDIT_SKILL_ID) {
    return {
      skill: AUDIT_SKILL_ID,
      tier: tierNamed ?? (mentions(padded, DEEP_WORDS) ? 'deep' : 'fast'),
      target: typeof metadata.target === 'string' ? metadata.target : targetIn(text),
      explicit: true,
    };
  }
  if (named === ASK_SKILL_ID) return { skill: ASK_SKILL_ID, explicit: true };

  const target = targetIn(text);
  if (target && mentions(padded, AUDIT_VERBS)) {
    return {
      skill: AUDIT_SKILL_ID,
      tier: tierNamed ?? (mentions(padded, DEEP_WORDS) ? 'deep' : 'fast'),
      target,
      explicit: false,
    };
  }
  return { skill: ASK_SKILL_ID, explicit: false };
}

/* ------------------------------------------------------------------ A2A shapes, both dialects */

/**
 * The task states this skill can be in, in both spellings.
 *
 * 1.0 serializes the proto enum names (`TASK_STATE_WORKING`); 0.x used lowercase strings
 * (`working`). Same rule as the Message shapes in the responder: a reply uses the dialect of the
 * request, because a 1.0 envelope on the 0.x path is a 200 the caller cannot read.
 */
export const TASK_STATES = Object.freeze({
  submitted: { current: 'TASK_STATE_SUBMITTED', legacy: 'submitted' },
  working: { current: 'TASK_STATE_WORKING', legacy: 'working' },
  completed: { current: 'TASK_STATE_COMPLETED', legacy: 'completed' },
  failed: { current: 'TASK_STATE_FAILED', legacy: 'failed' },
  canceled: { current: 'TASK_STATE_CANCELED', legacy: 'canceled' },
});

function textPart(text, legacy, mediaType = 'text/markdown') {
  return legacy ? { kind: 'text', text } : { text, mediaType };
}

function dataPart(data, legacy) {
  return legacy ? { kind: 'data', data } : { data, mediaType: 'application/json' };
}

function agentMessage({ text, messageId, contextId, taskId, legacy, parts }) {
  const body = parts ?? [textPart(text, legacy, 'text/plain')];
  return legacy
    ? {
        kind: 'message',
        messageId,
        role: 'agent',
        contextId,
        ...(taskId ? { taskId } : {}),
        parts: body,
      }
    : {
        role: 'ROLE_AGENT',
        messageId,
        contextId,
        ...(taskId ? { taskId } : {}),
        parts: body,
      };
}

/**
 * Which A2A state one durable run is in, from the status document `/mcp` already assembles.
 *
 * The mapping the card fixed, and each line of it is a claim about the run rather than a
 * convenience:
 *
 * - **queued → `submitted`.** The run is durable and accepted and nothing is working on it. That
 *   is what `submitted` means, and reporting it as `working` would make a caller behind somebody
 *   else's audit read a four-minute wait as a slow site.
 * - **running → `working`.**
 * - **COMPLETED with a report → `completed`.**
 * - **COMPLETED with no report → `failed`.** A completed task whose artifact is missing is a lie
 *   the caller can only find out about by reading an empty artifact list as a clean site.
 * - **CANCELED or TERMINATED → `canceled`; anything else terminal → `failed`.**
 */
export function taskStateFor(status, hasReport) {
  if (!status.done) return status.queued ? 'submitted' : 'working';
  if (status.succeeded) return hasReport ? 'completed' : 'failed';
  return status.execution === 'CANCELED' || status.execution === 'TERMINATED'
    ? 'canceled'
    : 'failed';
}

/** The one line a poller reads. The run's own note, with the failure reason when there is one. */
function statusText(status, state) {
  if (state === 'completed') return `The audit of ${status.url} finished. The report is attached.`;
  if (state === 'failed' || state === 'canceled') {
    return status.error ?? `The audit of ${status.url} ended without a report (${status.execution}).`;
  }
  const position = status.queuePosition === undefined ? '' : ` Position ${status.queuePosition}.`;
  return `${status.note}${position}`;
}

/**
 * One durable audit as an A2A `Task`.
 *
 * The report rides as an artifact with **two parts of one measurement**, not two artifacts: the
 * markdown summary for a caller that is going to read it to a person, and the canonical JSON for
 * one that wants to reason about individual checks. The markdown is a pure function of the JSON,
 * so the two cannot disagree — the same rule `/mcp` follows by putting them in `content` and
 * `structuredContent` of one result.
 *
 * @param {{ status: object, result?: object }} snapshot what the deep tier knows about the run
 * @param {{ contextId: string, legacy: boolean, newId: () => string, now: () => string,
 *           renderSummary: (audit: object) => string }} context
 */
export function taskFrom(snapshot, { contextId, legacy, newId, now, renderSummary }) {
  const { status, result } = snapshot;
  const taskId = status.workflowId;
  const state = taskStateFor(status, Boolean(result));
  const spelling = TASK_STATES[state][legacy ? 'legacy' : 'current'];

  const task = {
    ...(legacy ? { kind: 'task' } : {}),
    id: taskId,
    contextId,
    status: {
      state: spelling,
      message: agentMessage({
        text: statusText(status, state),
        messageId: newId(),
        contextId,
        taskId,
        legacy,
      }),
      timestamp: now(),
    },
    metadata: {
      skill: AUDIT_SKILL_ID,
      tier: 'deep',
      target: status.url,
      workflowId: taskId,
      execution: status.execution,
      ...(status.queuePosition === undefined ? {} : { queuePosition: status.queuePosition }),
      ...(status.progress ? { progress: status.progress } : {}),
      ...(status.pending ? { pending: status.pending } : {}),
      ...(status.integrity ? { integrity: status.integrity } : {}),
    },
  };

  if (state === 'completed') {
    task.artifacts = [
      {
        artifactId: `${taskId}-report`,
        name: 'agent-readiness-report',
        description:
          `The agent-readiness audit of ${status.url}, deep tier: the HTTP-level checks plus ` +
          'Lighthouse per-axis scores and axe-core violation counts from the rendered pages. ' +
          'The first part is the report as markdown; the second is the same report as its ' +
          'canonical JSON.',
        parts: [textPart(renderSummary(result), legacy), dataPart(result, legacy)],
      },
    ];
  }

  return task;
}

/**
 * One finished fast audit as a direct `Message`.
 *
 * A Message rather than a Task for the same reason `ask-about-site` is one: the work is over
 * before the response is written, so a Task would be a handle to nothing, and a caller would poll
 * a completed run to learn what this reply already carries.
 */
export function fastMessageFrom(audit, { contextId, legacy, newId, renderSummary }) {
  return agentMessage({
    messageId: newId(),
    contextId,
    legacy,
    parts: [textPart(renderSummary(audit), legacy), dataPart(audit, legacy)],
  });
}

/* ------------------------------------------------------------------ the handlers */

/** A JSON-RPC result in the dialect of the request: 1.0 wraps, 0.x hands the object over bare. */
function sendMessageResult(id, payload, legacy, key) {
  return { jsonrpc: '2.0', id, result: legacy ? payload : { [key]: payload } };
}

/**
 * Turn a refused rate-limit verdict into an error a caller can act on.
 *
 * The verdict comes from src/lib/mcp-rate-limit.mjs unchanged — the same function, the same keys
 * and the same counters `/mcp` uses, which is the whole of the shared-budget decision. A deep slot
 * spent here is spent there.
 */
function rateLimited(id, tier, verdict) {
  return errorResponse(
    id,
    ERROR_CODES.serverError,
    `Rate limited: ${verdict.reason}. Try again in ${verdict.retryAfterSeconds} seconds. ` +
      'This budget is shared with the MCP endpoint at https://www.mattpyle.com/mcp; a deep audit ' +
      'started on either protocol spends the same slot.',
    [
      errorInfo('RATE_LIMITED', {
        tier,
        scope: verdict.scope,
        retryAfterSeconds: String(verdict.retryAfterSeconds),
        ...(verdict.limit === undefined ? {} : { limit: String(verdict.limit) }),
      }),
    ]
  );
}

/**
 * `SendMessage` addressed to the audit skill.
 *
 * @param {{ id: string | number | null, route: object, contextId: string, legacy: boolean,
 *           newId: () => string, now: () => string, audit: object }} input
 * @returns {Promise<{ outcome: string, payload: object }>}
 */
export async function handleAuditMessage({ id, route, contextId, legacy, newId, now, audit }) {
  if (!route.target) {
    return {
      outcome: 'invalid-params/audit-no-target',
      payload: errorResponse(
        id,
        ERROR_CODES.invalidParams,
        'Invalid parameters. The audit skill needs a site to audit, and no hostname or URL was ' +
          'found in the message. Try "audit example.com", or "run a deep audit of ' +
          'https://example.com" for the browser-rendered tier.',
        [
          badRequest([
            {
              field: 'message.parts',
              description: 'Must name the site to audit, as a hostname or an https URL.',
            },
          ]),
        ]
      ),
    };
  }

  let origin;
  try {
    origin = audit.originFor(route.target);
  } catch (error) {
    return {
      outcome: 'invalid-params/audit-target',
      payload: errorResponse(
        id,
        ERROR_CODES.invalidParams,
        `Invalid parameters. ${error instanceof Error ? error.message : String(error)}`,
        [
          badRequest([
            { field: 'message.parts', description: 'Must name an http or https site to audit.' },
          ]),
        ]
      ),
    };
  }

  // Before the audit and before the workflow start, never after: a refused caller must cost this
  // site nothing at the target's origin and nothing on the worker. Same ordering as /mcp, and the
  // same counters.
  const verdict = await audit.checkLimit(route.tier);
  if (!verdict.allowed) {
    return {
      outcome: `rate-limited/${route.tier}/${verdict.scope}`,
      payload: rateLimited(id, route.tier, verdict),
    };
  }

  if (route.tier === 'deep') {
    let started;
    try {
      started = await audit.startDeep(origin, route.target);
    } catch (error) {
      return {
        outcome: 'audit-unavailable/deep',
        payload: errorResponse(
          id,
          ERROR_CODES.internal,
          `The deep tier could not start an audit of ${origin}: ` +
            `${error instanceof Error ? error.message : String(error)}. The fast tier runs in this ` +
            'function and is unaffected — ask again without the word "deep".',
          [errorInfo('DEEP_TIER_UNAVAILABLE', { origin })]
        ),
      };
    }

    // Reported as `submitted` rather than `working`, and not because the state is unknown: the
    // start command has been written to Temporal and nothing has picked the run up yet, which is
    // what `submitted` means. The first GetTask is what turns it into `working`.
    const task = taskFrom(
      {
        status: {
          workflowId: started.workflowId,
          url: origin,
          execution: 'RUNNING',
          done: false,
          succeeded: false,
          queued: true,
          note:
            `accepted — the audit of ${origin} is durable and starting. Poll GetTask with id ` +
            `"${started.workflowId}" until the state is TASK_STATE_COMPLETED; expect a few minutes.`,
        },
      },
      { contextId, legacy, newId, now, renderSummary: audit.renderSummary }
    );

    return {
      outcome: 'ok/audit-deep',
      payload: sendMessageResult(id, task, legacy, 'task'),
    };
  }

  let report;
  try {
    report = await audit.runFast(route.target);
  } catch (error) {
    return {
      outcome: 'audit-failed/fast',
      payload: errorResponse(
        id,
        ERROR_CODES.internal,
        `The fast audit of ${origin} did not finish: ` +
          `${error instanceof Error ? error.message : String(error)}.`,
        [errorInfo('AUDIT_FAILED', { origin })]
      ),
    };
  }

  const message = fastMessageFrom(report, {
    contextId,
    legacy,
    newId,
    renderSummary: audit.renderSummary,
  });
  return { outcome: 'ok/audit-fast', payload: sendMessageResult(id, message, legacy, 'message') };
}

/**
 * `GetTask`: one durable audit, read back.
 *
 * Free, and deliberately: it is a read of a run the caller already spent a slot to start, it makes
 * no request at anybody's origin, and charging it would refuse a caller who polls politely before
 * their own audit finishes. `/mcp` leaves `get_audit` uncounted for exactly this reason.
 *
 * @param {{ id: string | number | null, params: object, legacy: boolean, contextId: string,
 *           newId: () => string, now: () => string, audit: object }} input
 */
export async function handleGetTask({ id, params, legacy, contextId, newId, now, audit }) {
  const taskId = params?.id;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    return {
      outcome: 'invalid-params/task-id',
      payload: errorResponse(
        id,
        ERROR_CODES.invalidParams,
        `Invalid parameters. ${GET_TASK_METHOD} takes the task's id, which is the id returned by ` +
          'the audit skill, e.g. {"id":"steward-audit-example.com-deep-1a2b3c4d"}.',
        [badRequest([{ field: 'id', description: 'Must be a non-empty task id string.' }])]
      ),
    };
  }

  if (!isAuditTaskId(taskId)) {
    return {
      outcome: 'task-not-found/malformed',
      payload: taskNotFound(id, taskId),
    };
  }

  let snapshot;
  try {
    snapshot = await audit.readTask(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no audit with workflow id/i.test(message)) {
      return { outcome: 'task-not-found/unknown', payload: taskNotFound(id, taskId) };
    }
    return {
      outcome: 'task-unreadable',
      payload: errorResponse(
        id,
        ERROR_CODES.internal,
        `Task "${taskId}" could not be read: ${message}.`,
        [errorInfo('TASK_UNREADABLE', { taskId })]
      ),
    };
  }

  const task = taskFrom(snapshot, {
    // The caller's own thread id, echoed, or a fresh one. This endpoint stores nothing between
    // calls, so there is no server-side context to look the task's original one up in — which is
    // the honest shape for a task whose entire durable state lives in Temporal.
    contextId,
    legacy,
    newId,
    now,
    renderSummary: audit.renderSummary,
  });

  return { outcome: `ok/task/${taskStateFor(snapshot.status, Boolean(snapshot.result))}`, payload: { jsonrpc: '2.0', id, result: task } };
}

function taskNotFound(id, taskId) {
  return errorResponse(
    id,
    ERROR_CODES.taskNotFound,
    `No task with id "${taskId}". Task ids on this endpoint are the ids the audit skill returns, ` +
      'and one is only valid for as long as Temporal keeps that run\'s history. Start an audit ' +
      `with SendMessage, e.g. "run a deep audit of example.com"; the Agent Card at ${AGENT_CARD_URL} ` +
      'describes both skills.',
    [errorInfo('TASK_NOT_FOUND', { taskId })]
  );
}
