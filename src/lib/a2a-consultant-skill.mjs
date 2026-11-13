/**
 * The endpoint's third skill: a conversation with the audit consultant, as an A2A Task.
 *
 * The consultant is a Claude-driven agent that runs as a Temporal workflow on its own worker
 * (`agents/consultant/`). The model decides the path: whether to audit, which tier, when to ask the
 * caller a question. This file maps that conversation onto A2A, and holds none of the agent.
 *
 * **The Task id is the session's workflow id**, minted by this site (src/lib/consultant-task-id.mjs),
 * for the reason the audit skill gives: the durable run is the task.
 *
 * **States.** A2A 1.0 makes `completed`, `canceled` and `failed` terminal, so a session that waits
 * for the caller is never one of them:
 *
 * | The session | Task state | `metadata.awaiting` or `ended` |
 * |---|---|---|
 * | A turn is running | `working` | |
 * | The agent asked a question | `input-required`, the question | awaiting `answer` |
 * | The agent asks to run a deep audit | `input-required`, the request | awaiting `approval` |
 * | The turn is answered, the session open | `input-required`, the reply | awaiting `message` |
 * | A cap ended it, during its grace or after | `completed`, the last reply | ended `cap:<name>` |
 * | It sat idle until the agent closed it | `completed`, the last reply | ended `idle` |
 * | `CancelTask` closed it | `canceled`, the last reply | |
 * | It failed, timed out or was terminated | `failed` | |
 *
 * **What a read costs.** `GetTask` is a describe and two Queries, `agent_status` and
 * `consultant_session`, and the reply text is `consultant_session.lastReply`. It sends no Update,
 * so it writes nothing into the session's history however often it is called.
 *
 * **What a session costs, and who pays.** A new session is charged once, on the session tier of the
 * shared limiter (src/lib/mcp-rate-limit.mjs), before anything starts: a refused caller costs no
 * workflow and no model call. Later messages on the session are bounded by the agent's own caps.
 * The agent's audits go through `/mcp` on the audit tiers like any other caller.
 *
 * PURE. The engine (src/lib/a2a-consultant-temporal.mjs), the limiter, the clock and the id
 * factory are injected.
 */

import {
  AGENT_CARD_URL,
  ERROR_CODES,
  badRequest,
  errorInfo,
  errorResponse,
} from './a2a-rpc.mjs';
import { CONSULTANT_SKILL_ID } from './a2a-audit-skill.mjs';
import { isConsultantTaskId } from './consultant-task-id.mjs';

export { CONSULTANT_SKILL_ID };

/** The method that closes a session, in its A2A 1.0 spelling, and the 0.x alias. */
export const CANCEL_TASK_METHOD = 'CancelTask';
export const LEGACY_CANCEL_TASK_METHODS = Object.freeze(['tasks/cancel']);

export { isConsultantTaskId };

/** The longest message the skill passes on. The agent's answer to a question takes 4,000 at most. */
export const MAX_MESSAGE_CHARS = 4000;

const STATES = Object.freeze({
  submitted: { current: 'TASK_STATE_SUBMITTED', legacy: 'submitted' },
  working: { current: 'TASK_STATE_WORKING', legacy: 'working' },
  input_required: { current: 'TASK_STATE_INPUT_REQUIRED', legacy: 'input-required' },
  completed: { current: 'TASK_STATE_COMPLETED', legacy: 'completed' },
  canceled: { current: 'TASK_STATE_CANCELED', legacy: 'canceled' },
  failed: { current: 'TASK_STATE_FAILED', legacy: 'failed' },
});

const TERMINAL = new Set(['completed', 'canceled', 'failed']);

const APPROVE_WORDS = new Set(['yes', 'y', 'approve', 'approved', 'ok', 'go ahead']);
const REFUSE_WORDS = new Set(['no', 'n', 'refuse', 'refused', 'decline', 'declined', 'deny']);

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

/**
 * Which state one reading of a session is in.
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
    return { state: 'submitted', text: 'The session is started and durable, and waiting for the consultant\'s worker.' };
  }
  const question = status.pending_callbacks?.[0];
  if (question) {
    return {
      state: 'input_required',
      awaiting: 'answer',
      text: String(question.tool_input?.question ?? 'The consultant has a question.'),
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
        `The consultant asks to run a deep audit of ${url}: pages rendered in a real browser, which ` +
        'takes minutes. Reply "yes" to approve it or "no" to refuse.',
      toolId: approval.tool_id,
      turn,
    };
  }
  if (status.turn_active || (status.pending_turns?.length ?? 0) > 0 || !last) {
    return { state: 'working', text: 'The consultant is working on your message.', turn };
  }
  return { state: 'input_required', awaiting: 'message', text: lastText, turn };
}

function textPart(text, legacy) {
  return legacy ? { kind: 'text', text } : { text, mediaType: 'text/markdown' };
}

/** One session as an A2A `Task`, in the dialect of the request. */
export function consultantTaskFrom(taskId, view, { contextId, legacy, newId, now }) {
  const message = {
    ...(legacy ? { kind: 'message', role: 'agent' } : { role: 'ROLE_AGENT' }),
    messageId: newId(),
    contextId,
    taskId,
    parts: [textPart(view.text, legacy)],
  };
  return {
    ...(legacy ? { kind: 'task' } : {}),
    id: taskId,
    contextId,
    status: { state: STATES[view.state][legacy ? 'legacy' : 'current'], message, timestamp: now() },
    metadata: {
      skill: CONSULTANT_SKILL_ID,
      workflowId: taskId,
      ...(view.awaiting ? { awaiting: view.awaiting } : {}),
      ...(view.ended ? { ended: view.ended } : {}),
      ...(view.turn === undefined ? {} : { turn: view.turn }),
    },
  };
}

function taskNotFound(id, taskId) {
  return errorResponse(
    id,
    ERROR_CODES.taskNotFound,
    `No task with id "${taskId}". A consultant session's id is the one SendMessage returned when it ` +
      `started the session, and it is valid while Temporal keeps that run's history. Start a session ` +
      `with SendMessage and metadata {"skill":"${CONSULTANT_SKILL_ID}"}; the Agent Card at ` +
      `${AGENT_CARD_URL} describes every skill.`,
    [errorInfo('TASK_NOT_FOUND', { taskId })]
  );
}

function unavailable(id, error, taskId) {
  return errorResponse(
    id,
    ERROR_CODES.internal,
    `The consultant could not be reached: ${error instanceof Error ? error.message : String(error)}.`,
    [errorInfo('CONSULTANT_UNAVAILABLE', taskId ? { taskId } : undefined)]
  );
}

function wrapTask(id, task, legacy, inSendMessage) {
  return { jsonrpc: '2.0', id, result: inSendMessage && !legacy ? { task } : task };
}

/** Read a session, turning a missing one into the refusal and a failed read into an error. */
async function readOrRefuse(id, taskId, consultant) {
  if (!isConsultantTaskId(taskId)) return { refusal: { outcome: 'task-not-found/malformed', payload: taskNotFound(id, taskId) } };
  try {
    return { reading: await consultant.read(taskId) };
  } catch (error) {
    if (error?.name === 'ConsultantNotFound') {
      return { refusal: { outcome: 'task-not-found/unknown', payload: taskNotFound(id, taskId) } };
    }
    return { refusal: { outcome: 'consultant-unavailable', payload: unavailable(id, error, taskId) } };
  }
}

function tooLong(id) {
  return {
    outcome: 'invalid-params/consultant-too-long',
    payload: errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `Invalid parameters. A message to the consultant is ${MAX_MESSAGE_CHARS} characters at most.`,
      [badRequest([{ field: 'message.parts', description: `At most ${MAX_MESSAGE_CHARS} characters of text.` }])]
    ),
  };
}

/**
 * `SendMessage` to the consultant: a new session when the message carries no task id, otherwise
 * the caller's text delivered to the open session as what it is waiting for.
 *
 * @param {{ id: any, params: object, text: string, taskId: string | null, contextId: string,
 *           legacy: boolean, newId: () => string, now: () => string,
 *           consultant: { checkLimit: () => Promise<object>, engine: object } }} input
 */
export async function handleConsultantMessage({ id, params, text, taskId, contextId, legacy, newId, now, consultant }) {
  if (text.length > MAX_MESSAGE_CHARS) return tooLong(id);
  const shape = { contextId, legacy, newId, now };
  const engine = consultant.engine;

  if (taskId === null) {
    // Before any start, never after: a refused caller costs no workflow and no model call.
    const verdict = await consultant.checkLimit();
    if (!verdict.allowed) {
      return {
        outcome: `rate-limited/session/${verdict.scope}`,
        payload: errorResponse(
          id,
          ERROR_CODES.serverError,
          `Rate limited: ${verdict.reason}. Try again in ${verdict.retryAfterSeconds} seconds.`,
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
      return { outcome: 'consultant-unavailable/start', payload: unavailable(id, error) };
    }
    const view = started.accepted
      ? { state: 'working', text: `The consultant is working on your message. Poll GetTask with id "${started.workflowId}".` }
      : { state: 'submitted', text: `The session is started and durable, and waiting for the consultant's worker. Poll GetTask with id "${started.workflowId}".` };
    return {
      outcome: `ok/consultant-start/${view.state}`,
      payload: wrapTask(id, consultantTaskFrom(started.workflowId, view, shape), legacy, true),
    };
  }

  const read = await readOrRefuse(id, taskId, consultant.engine);
  if (read.refusal) return read.refusal;
  const view = consultantStateFor(read.reading);

  if (TERMINAL.has(view.state)) {
    return {
      outcome: `task-terminal/${view.state}`,
      payload: errorResponse(
        id,
        ERROR_CODES.unsupportedOperation,
        `Task "${taskId}" has ended (${STATES[view.state].current}) and takes no more messages. ` +
          'Start a new session with SendMessage and no task id.',
        [errorInfo('TASK_TERMINAL', { taskId, state: STATES[view.state].current })]
      ),
    };
  }
  if (view.state === 'working' || view.state === 'submitted') {
    return {
      outcome: 'task-busy',
      payload: errorResponse(
        id,
        ERROR_CODES.unsupportedOperation,
        `Task "${taskId}" is still working on the last message. Poll GetTask until its state is ` +
          'TASK_STATE_INPUT_REQUIRED, then reply.',
        [errorInfo('TASK_WORKING', { taskId })]
      ),
    };
  }

  try {
    if (view.awaiting === 'answer') {
      await engine.answer(taskId, view.toolId, text);
    } else if (view.awaiting === 'approval') {
      const approved = approvalFrom(params, text);
      if (approved === null) {
        return {
          outcome: 'invalid-params/consultant-approval',
          payload: errorResponse(
            id,
            ERROR_CODES.invalidParams,
            'Invalid parameters. The consultant is waiting for a yes or a no on a deep audit. Reply ' +
              '"yes" or "no", or set metadata {"approve": true} or {"approve": false}.',
            [badRequest([{ field: 'message.parts', description: 'Must be "yes" or "no".' }])]
          ),
        };
      }
      await engine.decide(taskId, view.toolId, approved);
    } else {
      await engine.send(taskId, text);
    }
  } catch (error) {
    if (error?.name === 'ConsultantNotFound') return { outcome: 'task-not-found/unknown', payload: taskNotFound(id, taskId) };
    return { outcome: 'consultant-unavailable/send', payload: unavailable(id, error, taskId) };
  }

  const working = { state: 'working', text: 'The consultant is working on your message.', turn: view.turn };
  return {
    outcome: `ok/consultant-reply/${view.awaiting}`,
    payload: wrapTask(id, consultantTaskFrom(taskId, working, shape), legacy, true),
  };
}

/** `GetTask` on a consultant session. A describe and two Queries; no Update. */
export async function handleConsultantGetTask({ id, taskId, contextId, legacy, newId, now, consultant }) {
  const read = await readOrRefuse(id, taskId, consultant.engine);
  if (read.refusal) return read.refusal;
  const view = consultantStateFor(read.reading);
  return {
    outcome: `ok/consultant-task/${view.state}`,
    payload: wrapTask(id, consultantTaskFrom(taskId, view, { contextId, legacy, newId, now }), legacy, false),
  };
}

/** `CancelTask`: the harness's `close` Signal, for a session that is still open. */
export async function handleConsultantCancel({ id, taskId, contextId, legacy, newId, now, consultant }) {
  const read = await readOrRefuse(id, taskId, consultant.engine);
  if (read.refusal) return read.refusal;
  const view = consultantStateFor(read.reading);
  if (TERMINAL.has(view.state)) {
    return {
      outcome: `task-not-cancelable/${view.state}`,
      payload: errorResponse(
        id,
        ERROR_CODES.taskNotCancelable,
        `Task "${taskId}" has already ended (${STATES[view.state].current}), so it cannot be canceled.`,
        [errorInfo('TASK_NOT_CANCELABLE', { taskId, state: STATES[view.state].current })]
      ),
    };
  }
  try {
    await consultant.engine.close(taskId);
  } catch (error) {
    return { outcome: 'consultant-unavailable/cancel', payload: unavailable(id, error, taskId) };
  }
  const canceled = { state: 'canceled', text: view.awaiting === 'message' ? view.text : 'The session was canceled.', turn: view.turn };
  return {
    outcome: 'ok/consultant-cancel',
    payload: wrapTask(id, consultantTaskFrom(taskId, canceled, { contextId, legacy, newId, now }), legacy, false),
  };
}
