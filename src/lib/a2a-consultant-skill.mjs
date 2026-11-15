/**
 * Steward's conversation with a caller, as A2A: one session is one context, and each turn is a
 * Task that completes with the answer as its artifact.
 *
 * The model is a Claude-driven agent that runs as a Temporal workflow on its own worker
 * (`agents/consultant/`; "the consultant" is its name in the code). It decides the path: whether
 * to audit, which tier, when to ask the caller a question. This file maps that conversation onto
 * A2A, and holds none of the agent.
 *
 * **Ids.** The session's workflow id, minted by this site (src/lib/consultant-task-id.mjs), is the
 * `contextId` of every response. Turn N's task id is that id plus `-tN`. A message with the
 * session's `contextId` and no task id is the next turn. A bare session id is still accepted as a
 * task id, from the time a session was one task, and stands for the session's latest turn.
 *
 * **States of one turn's task.**
 *
 * | The turn | Task state | Carries |
 * |---|---|---|
 * | Started, and no worker has picked it up | `submitted` | a status message |
 * | Running | `working` | a status message |
 * | Steward asked a question | `input-required`, `metadata.awaiting: "answer"` | the question |
 * | Steward asks to run a deep audit | `input-required`, `metadata.awaiting: "approval"` | the request |
 * | Answered | `completed` | the answer, as the artifact `answer`, and no status message |
 * | Open when `CancelTask` closed the session | `canceled` | a status message |
 * | Open when the session failed or timed out | `failed` | a status message |
 *
 * An answered turn stays `completed` whatever happens to the session afterwards: a finished task
 * does not change state. `metadata.session` reads `"closed"` once the session takes no more
 * messages, and `metadata.ended` names a cap or the idle close.
 *
 * **A send waits for its turn.** After the message is delivered, the send reads the session's
 * Queries until the turn leaves `working`, then returns the finished or interrupted task. The
 * whole request has `WAIT_BUDGET_MS`; past it the send returns `working`, and `GetTask` reads the
 * rest. A caller that sets `configuration.returnImmediately` (or the 0.x `blocking: false`) gets
 * `working` at once.
 *
 * **What a read costs.** A read is a describe and two Queries, `agent_status` and
 * `consultant_session`. It sends no Update, so `GetTask` and the wait write nothing into the
 * session's history however often they run.
 *
 * **A session read from an older worker** has `lastReply` and no `replies`. The latest turn reads
 * from `lastReply`; an earlier turn reads `completed` with a line saying its text is not kept.
 *
 * **What a session costs, and who pays.** A new session is charged once, on the session tier of the
 * shared limiter (src/lib/mcp-rate-limit.mjs), before anything starts: a refused caller costs no
 * workflow and no model call. Later messages on the session are bounded by the agent's own caps.
 * The agent's audits go through `/mcp` on the audit tiers like any other caller.
 *
 * PURE. The engine (src/lib/a2a-consultant-temporal.mjs), the limiter, the clock and the id
 * factory are injected. The wait's clock defaults to the real one.
 */

import {
  AGENT_CARD_URL,
  ERROR_CODES,
  badRequest,
  errorInfo,
  errorResponse,
} from './a2a-rpc.mjs';
import { ASK_SKILL_ID, AUDIT_SKILL_ID, CONSULTANT_SKILL_ID } from './a2a-audit-skill.mjs';
import {
  consultantTurnTaskId,
  isConsultantSessionId,
  isConsultantTaskId,
  parseConsultantTaskId,
} from './consultant-task-id.mjs';

export { CONSULTANT_SKILL_ID };

/** The method that closes a session, in its A2A 1.0 spelling, and the 0.x alias. */
export const CANCEL_TASK_METHOD = 'CancelTask';
export const LEGACY_CANCEL_TASK_METHODS = Object.freeze(['tasks/cancel']);

export { isConsultantTaskId };

/** The longest message the skill passes on. The agent's answer to a question takes 4,000 at most. */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * How long one send may take, from the request's arrival to its reply, waiting for the turn.
 *
 * Under the 45 seconds the fast audit already takes on this function (src/lib/fast-audit.mjs) and
 * the 60-second floor that budget assumes. Turns with a fast audit measured 14 and 7 seconds.
 */
export const WAIT_BUDGET_MS = 40_000;

/** The pause between two reads of a waiting send. */
export const WAIT_INTERVAL_MS = 750;

const STATES = Object.freeze({
  submitted: { current: 'TASK_STATE_SUBMITTED', legacy: 'submitted' },
  working: { current: 'TASK_STATE_WORKING', legacy: 'working' },
  input_required: { current: 'TASK_STATE_INPUT_REQUIRED', legacy: 'input-required' },
  completed: { current: 'TASK_STATE_COMPLETED', legacy: 'completed' },
  canceled: { current: 'TASK_STATE_CANCELED', legacy: 'canceled' },
  failed: { current: 'TASK_STATE_FAILED', legacy: 'failed' },
});

const TERMINAL = new Set(['completed', 'canceled', 'failed']);
const RUNNING = new Set(['working', 'submitted']);

const APPROVE_WORDS = new Set(['yes', 'y', 'approve', 'approved', 'ok', 'go ahead']);
const REFUSE_WORDS = new Set(['no', 'n', 'refuse', 'refused', 'decline', 'declined', 'deny']);

const WORKING_TEXT = 'Steward is working on your message.';
const CANCELED_TEXT = 'The session was canceled.';
const FAILED_TEXT = 'The session failed before this turn was answered.';
const UNANSWERED_TEXT = 'The session ended before this turn was answered.';
const NOT_KEPT_TEXT =
  'This turn was answered. Its text is not kept for this session; the latest answer is on the ' +
  "session's latest task.";

/**
 * The caller's decision on a deep audit, or null when the message is neither. `metadata.approve`
 * wins; otherwise the whole text must be one of the words, so "yes, but audit a different site"
 * is not read as a yes.
 */
export function approvalFrom(params, text) {
  const metadata = { ...(params?.metadata ?? {}), ...(params?.message?.metadata ?? {}) };
  if (typeof metadata.approve === 'boolean') return metadata.approve;
  const word = String(text ?? '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (APPROVE_WORDS.has(word)) return true;
  if (REFUSE_WORDS.has(word)) return false;
  return null;
}

/** Whether the caller asked for the reply at once: 1.0 `returnImmediately`, 0.x `blocking: false`. */
export function wantsImmediateReturn(params) {
  const configuration = params?.configuration;
  if (!configuration || typeof configuration !== 'object') return false;
  return configuration.returnImmediately === true || configuration.blocking === false;
}

/**
 * Which state one reading of a session is in, as a whole: what the session is doing now.
 * `awaiting: "message"` means the latest turn is answered and the session waits for the next.
 *
 * @param {{ execution: string, status: object | null, session: object | null }} reading
 * @returns {{ state: keyof typeof STATES, text: string, awaiting?: string, ended?: string,
 *             toolId?: string, turn?: number }}
 */
export function consultantStateFor(reading) {
  const { execution, status, session } = reading;
  const last = session?.lastReply ?? null;
  const lastText = last?.text ?? '';
  const turn = last?.turn;

  if (execution === 'FAILED' || execution === 'TIMED_OUT' || execution === 'TERMINATED') {
    return { state: 'failed', text: lastText || `The session ended ${execution}.`, ended: execution.toLowerCase(), turn };
  }
  if (execution === 'CANCELED') return { state: 'canceled', text: lastText || 'The session was canceled.', turn };

  // A cap ends the session at once, even while the agent still answers for its grace period.
  if (session?.ended) {
    return { state: 'completed', text: lastText || 'The session has ended.', ended: session.ended.reason, turn };
  }
  const closeReason = status?.close_reason ?? null;
  if (execution !== 'RUNNING' || closeReason) {
    if (closeReason === 'idle_timeout_expired') {
      return { state: 'completed', text: lastText || 'The session closed after sitting idle.', ended: 'idle', turn };
    }
    if (closeReason === 'requested') return { state: 'canceled', text: lastText || 'The session was closed.', turn };
    // Closed, and no worker answered to say why.
    return { state: 'completed', text: lastText || 'The session has closed.', ended: 'closed', turn };
  }

  if (!status) {
    return { state: 'submitted', text: "The session is started and durable, and waiting for Steward's worker." };
  }
  const question = status.pending_callbacks?.[0];
  if (question) {
    return {
      state: 'input_required',
      awaiting: 'answer',
      text: String(question.tool_input?.question ?? 'Steward has a question.'),
      toolId: question.tool_id,
      turn,
    };
  }
  const approval = status.pending_approvals?.[0];
  if (approval) {
    const url = typeof approval.tool_input?.url === 'string' ? approval.tool_input.url : 'the site';
    return {
      state: 'input_required',
      awaiting: 'approval',
      text:
        `Steward asks to run a deep audit of ${url}: pages rendered in a real browser, which ` +
        'takes minutes. Reply "yes" to approve it or "no" to refuse.',
      toolId: approval.tool_id,
      turn,
    };
  }
  if (status.turn_active || (status.pending_turns?.length ?? 0) > 0 || !last) {
    return { state: 'working', text: WORKING_TEXT, turn };
  }
  return { state: 'input_required', awaiting: 'message', text: lastText, turn };
}

/** Every turn's answer the session holds: `replies`, or `lastReply` alone from an older worker. */
function repliesOf(session) {
  if (Array.isArray(session?.replies)) return session.replies;
  return session?.lastReply ? [session.lastReply] : [];
}

/**
 * The turn the session is on: the count of turns it has started, from the session Query. Null
 * when no worker answered the Query, so the count is not known.
 */
function latestTurnOf(session) {
  return typeof session?.turns === 'number' ? session.turns : null;
}

/**
 * One turn of a session, as the state of that turn's task.
 *
 * @param {{ execution: string, status: object | null, session: object | null }} reading
 * @param {number | null} turn the turn asked for; null for a bare session id, the latest turn
 * @param {{ sent?: boolean }} [options] `sent` marks a turn this call just delivered a message
 *   for, which may not have started yet
 * @returns {{ state: keyof typeof STATES, turn: number | null, text: string, answer?: string,
 *             awaiting?: string, ended?: string, closed?: boolean, toolId?: string } | null}
 *   null when the session has no such turn
 */
export function consultantTurnFor(reading, turn, { sent = false } = {}) {
  const whole = consultantStateFor(reading);
  const latest = latestTurnOf(reading.session);
  const replies = repliesOf(reading.session);
  const replyFor = (n) => replies.find((reply) => reply.turn === n) ?? null;
  const closed = TERMINAL.has(whole.state);
  const shared = { ...(whole.ended ? { ended: whole.ended } : {}), ...(closed ? { closed: true } : {}) };

  // No worker answered the session Query: the turns cannot be told apart, so the session's own
  // state stands for whichever one was asked.
  if (latest === null) {
    if (whole.state === 'input_required' && whole.awaiting === 'message') {
      return { state: 'completed', turn: turn ?? whole.turn ?? null, text: '', answer: whole.text, ...shared };
    }
    return { ...whole, turn: turn ?? whole.turn ?? null, ...shared };
  }

  // The next turn is admitted and not yet counted: a message is queued behind a running turn, or
  // this call delivered one a moment ago.
  const nextPending =
    !closed && RUNNING.has(whole.state) && latest >= 0 && (latest === 0 || replyFor(latest) !== null);
  const asked = turn ?? (nextPending ? latest + 1 : Math.max(latest, 1));

  if (asked > latest) {
    if (asked === latest + 1 && !closed && (nextPending || sent)) {
      return { state: whole.state === 'submitted' ? 'submitted' : 'working', turn: asked, text: whole.state === 'submitted' ? whole.text : WORKING_TEXT };
    }
    return null;
  }

  const reply = replyFor(asked);
  if (asked < latest) {
    return reply
      ? { state: 'completed', turn: asked, text: '', answer: reply.text, ...shared }
      : { state: 'completed', turn: asked, text: NOT_KEPT_TEXT, ...shared };
  }

  // The latest turn. An answer on record means it is finished, whatever the session did next:
  // the answer is recorded as the turn's last act.
  if (reply) return { state: 'completed', turn: asked, text: '', answer: reply.text, ...shared };
  if (whole.state === 'input_required' && whole.awaiting === 'message') {
    // Answered, by the status, with no text on record for it.
    return { state: 'completed', turn: asked, text: NOT_KEPT_TEXT, ...shared };
  }
  // The session closed with this turn unanswered. The session's own text is an earlier turn's
  // answer, so the turn says what happened to it instead.
  if (whole.state === 'completed') return { state: 'completed', turn: asked, text: UNANSWERED_TEXT, ...shared };
  if (whole.state === 'canceled') return { state: 'canceled', turn: asked, text: CANCELED_TEXT, ...shared };
  if (whole.state === 'failed') return { state: 'failed', turn: asked, text: FAILED_TEXT, ...shared };
  return { ...whole, turn: asked, ...shared };
}

function textPart(text, legacy) {
  return legacy ? { kind: 'text', text } : { text, mediaType: 'text/markdown' };
}

/**
 * One turn as an A2A `Task`, in the dialect of the request.
 *
 * @param {string} taskId the id the response carries: the turn's, or the bare id the caller used
 * @param {string} sessionId the workflow id, which is the `contextId`
 */
export function consultantTaskFrom(taskId, sessionId, view, { legacy, newId, now }) {
  const status = { state: STATES[view.state][legacy ? 'legacy' : 'current'], timestamp: now() };
  if (view.text) {
    status.message = {
      ...(legacy ? { kind: 'message', role: 'agent' } : { role: 'ROLE_AGENT' }),
      messageId: newId(),
      contextId: sessionId,
      taskId,
      parts: [textPart(view.text, legacy)],
    };
  }
  return {
    ...(legacy ? { kind: 'task' } : {}),
    id: taskId,
    contextId: sessionId,
    status,
    ...(view.answer === undefined
      ? {}
      : {
          artifacts: [
            {
              artifactId: `${taskId}-answer`,
              name: 'answer',
              description: "Steward's answer to this turn, as markdown.",
              parts: [textPart(view.answer, legacy)],
            },
          ],
        }),
    metadata: {
      skill: CONSULTANT_SKILL_ID,
      workflowId: sessionId,
      ...(view.turn === null || view.turn === undefined ? {} : { turn: view.turn }),
      ...(view.awaiting ? { awaiting: view.awaiting } : {}),
      ...(view.ended ? { ended: view.ended } : {}),
      ...(view.closed ? { session: 'closed' } : {}),
    },
  };
}

function taskNotFound(id, taskId) {
  return errorResponse(
    id,
    ERROR_CODES.taskNotFound,
    `No task with id "${taskId}". A Steward task's id is the one SendMessage returned for that turn, ` +
      `and it is valid while Temporal keeps the session's history. Start a session by sending ` +
      `SendMessage with a line of text and no task id or context id; the Agent Card at ` +
      `${AGENT_CARD_URL} describes every skill.`,
    [errorInfo('TASK_NOT_FOUND', { taskId })]
  );
}

/**
 * The refusal when Temporal or the model's worker does not answer.
 *
 * The caller gets a fixed sentence and never the error's own text: a Temporal or gRPC error can
 * name the namespace or the address it tried, and no public text names those. The text goes to
 * `detail`, which the route writes to the function's log line and nowhere else.
 */
export const UNAVAILABLE_TEXT = 'Steward could not be reached just now. Try again in a minute.';

/**
 * The same, when the call named a task. A message, an answer or an approval that ran out of time
 * may still reach the session, so a blind resend could deliver it twice.
 */
export const UNAVAILABLE_TASK_TEXT =
  "Steward could not be reached just now. Poll GetTask with this task's id to see where " +
  'the session stands before you send the message again.';

function unavailable(id, error, taskId, outcome) {
  const detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  return {
    outcome,
    detail,
    payload: errorResponse(id, ERROR_CODES.internal, taskId ? UNAVAILABLE_TASK_TEXT : UNAVAILABLE_TEXT, [
      errorInfo('CONSULTANT_UNAVAILABLE', taskId ? { taskId } : undefined),
    ]),
  };
}

function wrapTask(id, task, legacy, inSendMessage) {
  return { jsonrpc: '2.0', id, result: inSendMessage && !legacy ? { task } : task };
}

/**
 * Read the session a task id names, turning a missing one into the refusal and a failed read into
 * an error. `named` is the id as the caller wrote it, for the refusal's text.
 */
async function readOrRefuse(id, named, sessionId, engine) {
  if (sessionId === null) return { refusal: { outcome: 'task-not-found/malformed', payload: taskNotFound(id, named) } };
  try {
    return { reading: await engine.read(sessionId) };
  } catch (error) {
    if (error?.name === 'ConsultantNotFound') {
      return { refusal: { outcome: 'task-not-found/unknown', payload: taskNotFound(id, named) } };
    }
    return { refusal: unavailable(id, error, named, 'consultant-unavailable/read') };
  }
}

function tooLong(id) {
  return {
    outcome: 'invalid-params/consultant-too-long',
    payload: errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `Invalid parameters. A message to Steward is ${MAX_MESSAGE_CHARS} characters at most.`,
      [badRequest([{ field: 'message.parts', description: `At most ${MAX_MESSAGE_CHARS} characters of text.` }])]
    ),
  };
}

/**
 * Wait for one turn to leave `working`, reading the session's Queries, until `deadline`.
 *
 * Returns the turn's view: finished, interrupted, or still running when the time is up. A read
 * that fails ends the wait with the turn reported as running, because the message is already
 * delivered and `GetTask` will say where it stands.
 */
async function waitForTurn(engine, sessionId, turn, { deadline, clock }) {
  let view = { state: 'working', turn, text: WORKING_TEXT };
  for (;;) {
    const left = deadline - clock.now();
    if (left <= 0) return view;
    try {
      view = consultantTurnFor(await engine.read(sessionId, { within: left }), turn, { sent: true }) ?? view;
    } catch {
      return view;
    }
    if (!RUNNING.has(view.state)) return view;
    if (deadline - clock.now() <= WAIT_INTERVAL_MS) return view;
    await clock.sleep(WAIT_INTERVAL_MS);
  }
}

const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * `SendMessage` to Steward: a new session when the message names none, otherwise the caller's text
 * delivered to the open session as what it is waiting for. The send then waits for the turn.
 *
 * The session is named by `message.taskId` (any task of it) or by `message.contextId`. A context
 * id that is not a session's is the caller's own: the message starts a new session, and the
 * response carries the session's `contextId`.
 *
 * @param {{ id: any, params: object, text: string, taskId: string | null, contextId: string | null,
 *           legacy: boolean, newId: () => string, now: () => string,
 *           consultant: { checkLimit: () => Promise<object>, engine: object, startedAt?: number,
 *                         clock?: { now: () => number, sleep: (ms: number) => Promise<void> } } }} input
 *   `startedAt` is when the request arrived, on `clock`; the wait's budget counts from it.
 */
export async function handleConsultantMessage({ id, params, text, taskId, contextId, legacy, newId, now, consultant }) {
  if (text.length > MAX_MESSAGE_CHARS) return tooLong(id);
  const shape = { legacy, newId, now };
  const engine = consultant.engine;
  const clock = consultant.clock ?? REAL_CLOCK;
  const deadline = (consultant.startedAt ?? clock.now()) + WAIT_BUDGET_MS;
  const immediate = wantsImmediateReturn(params);

  const namedTask = taskId === null ? null : parseConsultantTaskId(taskId);
  if (taskId !== null && namedTask === null) {
    return { outcome: 'task-not-found/malformed', payload: taskNotFound(id, taskId) };
  }
  const sessionId = namedTask?.sessionId ?? (isConsultantSessionId(contextId) ? contextId : null);

  if (sessionId === null) {
    // Before any start, never after: a refused caller costs no workflow and no model call.
    const verdict = await consultant.checkLimit();
    if (!verdict.allowed) {
      return {
        outcome: `rate-limited/session/${verdict.scope}`,
        payload: errorResponse(
          id,
          ERROR_CODES.serverError,
          `Rate limited: ${verdict.reason}. Try again in ${verdict.retryAfterSeconds} seconds. ` +
            'A message that names no skill starts a Steward session, and new sessions are capped per ' +
            'caller and per day. For a raw audit report with no model, call the MCP endpoint at ' +
            'https://www.mattpyle.com/mcp, or name a skill in metadata: ' +
            `{"skill":"${AUDIT_SKILL_ID}"} for an audit, or {"skill":"${ASK_SKILL_ID}"} for a ` +
            'question about this site.',
          [
            errorInfo('RATE_LIMITED', {
              tier: 'session',
              scope: verdict.scope,
              retryAfterSeconds: String(verdict.retryAfterSeconds),
              ...(verdict.limit === undefined ? {} : { limit: String(verdict.limit) }),
            }),
          ]
        ),
      };
    }
    let started;
    try {
      started = await engine.start(text);
    } catch (error) {
      return unavailable(id, error, undefined, 'consultant-unavailable/start');
    }
    const firstTask = consultantTurnTaskId(started.workflowId, 1);
    let view = started.accepted
      ? { state: 'working', turn: 1, text: `${WORKING_TEXT} Poll GetTask with id "${firstTask}".` }
      : {
          state: 'submitted',
          turn: 1,
          text: `The session is started and durable, and waiting for Steward's worker. Poll GetTask with id "${firstTask}".`,
        };
    if (started.accepted && !immediate) {
      const waited = await waitForTurn(engine, started.workflowId, 1, { deadline, clock });
      view = RUNNING.has(waited.state) ? view : waited;
    }
    return {
      outcome: `ok/consultant-start/${view.state}`,
      payload: wrapTask(id, consultantTaskFrom(firstTask, started.workflowId, view, shape), legacy, true),
    };
  }

  const named = taskId ?? sessionId;
  const read = await readOrRefuse(id, named, sessionId, engine);
  if (read.refusal) return read.refusal;
  const whole = consultantStateFor(read.reading);

  if (TERMINAL.has(whole.state)) {
    return {
      outcome: `task-terminal/${whole.state}`,
      payload: errorResponse(
        id,
        ERROR_CODES.unsupportedOperation,
        `The session "${sessionId}" has ended (${STATES[whole.state].current}) and takes no more ` +
          'messages. Send the message again with no context id and no task id to start a new session.',
        [errorInfo('TASK_TERMINAL', { taskId: named, state: STATES[whole.state].current })]
      ),
    };
  }
  if (RUNNING.has(whole.state)) {
    return {
      outcome: 'task-busy',
      payload: errorResponse(
        id,
        ERROR_CODES.unsupportedOperation,
        `The session "${sessionId}" is still working on the last message. Poll GetTask on that ` +
          "turn's task until it leaves TASK_STATE_WORKING, then send again.",
        [errorInfo('TASK_WORKING', { taskId: named })]
      ),
    };
  }

  // The turn this message belongs to: the open one for an answer or an approval, the next one for
  // a new message.
  const latest = latestTurnOf(read.reading.session) ?? whole.turn ?? 0;
  const turn = whole.awaiting === 'message' ? latest + 1 : Math.max(latest, 1);

  try {
    if (whole.awaiting === 'answer') {
      await engine.answer(sessionId, whole.toolId, text);
    } else if (whole.awaiting === 'approval') {
      const approved = approvalFrom(params, text);
      if (approved === null) {
        return {
          outcome: 'invalid-params/consultant-approval',
          payload: errorResponse(
            id,
            ERROR_CODES.invalidParams,
            'Invalid parameters. Steward is waiting for a yes or a no on a deep audit. Reply ' +
              '"yes" or "no", or set metadata {"approve": true} or {"approve": false}.',
            [badRequest([{ field: 'message.parts', description: 'Must be "yes" or "no".' }])]
          ),
        };
      }
      await engine.decide(sessionId, whole.toolId, approved);
    } else {
      await engine.send(sessionId, text);
    }
  } catch (error) {
    if (error?.name === 'ConsultantNotFound') return { outcome: 'task-not-found/unknown', payload: taskNotFound(id, named) };
    return unavailable(id, error, named, 'consultant-unavailable/send');
  }

  const turnTask = consultantTurnTaskId(sessionId, turn);
  let view = { state: 'working', turn, text: `${WORKING_TEXT} Poll GetTask with id "${turnTask}".` };
  if (!immediate) {
    const waited = await waitForTurn(engine, sessionId, turn, { deadline, clock });
    view = RUNNING.has(waited.state) ? view : waited;
  }
  return {
    outcome: `ok/consultant-reply/${whole.awaiting}`,
    payload: wrapTask(id, consultantTaskFrom(turnTask, sessionId, view, shape), legacy, true),
  };
}

/** `GetTask` on one turn of a session. A describe and two Queries; no Update. */
export async function handleConsultantGetTask({ id, taskId, legacy, newId, now, consultant }) {
  const parsed = parseConsultantTaskId(taskId);
  const read = await readOrRefuse(id, taskId, parsed?.sessionId ?? null, consultant.engine);
  if (read.refusal) return read.refusal;
  const view = consultantTurnFor(read.reading, parsed.turn);
  if (view === null) return { outcome: 'task-not-found/turn', payload: taskNotFound(id, taskId) };
  return {
    outcome: `ok/consultant-task/${view.state}`,
    payload: wrapTask(id, consultantTaskFrom(taskId, parsed.sessionId, view, { legacy, newId, now }), legacy, false),
  };
}

/**
 * `CancelTask` on any task of a session: the harness's `close` Signal, which closes the session.
 *
 * The task named comes back in its own state: `canceled` when its turn was open, and still
 * `completed`, with `metadata.session: "closed"`, when its turn was already answered.
 */
export async function handleConsultantCancel({ id, taskId, legacy, newId, now, consultant }) {
  const parsed = parseConsultantTaskId(taskId);
  const read = await readOrRefuse(id, taskId, parsed?.sessionId ?? null, consultant.engine);
  if (read.refusal) return read.refusal;
  const whole = consultantStateFor(read.reading);
  const view = consultantTurnFor(read.reading, parsed.turn);
  if (view === null) return { outcome: 'task-not-found/turn', payload: taskNotFound(id, taskId) };
  if (TERMINAL.has(whole.state)) {
    return {
      outcome: `task-not-cancelable/${whole.state}`,
      payload: errorResponse(
        id,
        ERROR_CODES.taskNotCancelable,
        `The session of task "${taskId}" has already ended (${STATES[whole.state].current}), so it cannot be canceled.`,
        [errorInfo('TASK_NOT_CANCELABLE', { taskId, state: STATES[whole.state].current })]
      ),
    };
  }
  try {
    await consultant.engine.close(parsed.sessionId);
  } catch (error) {
    return unavailable(id, error, taskId, 'consultant-unavailable/cancel');
  }
  const after =
    view.state === 'completed'
      ? { ...view, closed: true }
      : { state: 'canceled', turn: view.turn, text: CANCELED_TEXT, closed: true };
  return {
    outcome: 'ok/consultant-cancel',
    payload: wrapTask(id, consultantTaskFrom(taskId, parsed.sessionId, after, { legacy, newId, now }), legacy, false),
  };
}
