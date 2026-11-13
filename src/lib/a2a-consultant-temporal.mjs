/**
 * The audit consultant's Temporal half of `/a2a`: start a session, read it, and deliver a caller's
 * reply, by the agent harness's raw call names.
 *
 * A Temporal client and nothing else, on the same module-scope client `/mcp` and the audit skill
 * use (src/lib/mcp-temporal.mjs). It imports no harness package and nothing from
 * `agents/consultant/`: the agent's Updates, Queries and Signal are called by name, which record
 * MPW-566 showed is all a client needs.
 *
 * | What | Call |
 * |---|---|
 * | New session | Update-with-Start: `AuditConsultant`, then `send_agent_message` |
 * | Read | `describe()`, then the `agent_status` and `consultant_session` Queries |
 * | Answer a question | Update `provide_callback_result` |
 * | Decide a deep audit | Update `tool_approval` |
 * | Next turn | Update `send_agent_message` |
 * | Cancel | Signal `close` |
 *
 * **No stream poll.** The reply text is `lastReply` on `consultant_session`. A stream poll is an
 * Update, and an accepted Update is written into the workflow's history with its result, so a
 * caller who looped GetTask on an idle task would grow the history without bound. A Query writes
 * nothing.
 *
 * **Nothing the caller sends reaches the start.** The workflow id is minted here from a random
 * UUID, the queue and type are constants, and the start passes `[{}]`: no AgentConfig, so the
 * agent's own caps and its 30-minute idle close hold, and no `close_after_idle` override is
 * possible. The caller's text reaches the agent only as a message payload.
 *
 * **Every call has a deadline.** An Update to a run no worker is polling is retried by the client
 * for ever, and a Query to one never answers. A caller is told so rather than handed a gateway
 * timeout.
 */

import { WithStartWorkflowOperation, WorkflowNotFoundError } from '@temporalio/client';
import { randomUUID } from 'node:crypto';
import {
  CONSULTANT_SESSION_QUERY,
  CONSULTANT_TASK_QUEUE,
  CONSULTANT_WORKFLOW_TYPE,
  consultantTaskIdFor,
  isConsultantTaskId,
} from './consultant-task-id.mjs';
import { getClient, withDeadline } from './mcp-temporal.mjs';

/** The harness's call names. `agent-protocol/agent-interface` in `@temporalio/agent-harness` 0.5.0. */
export const SEND_AGENT_MESSAGE_UPDATE = 'send_agent_message';
export const TOOL_APPROVAL_UPDATE = 'tool_approval';
export const PROVIDE_CALLBACK_RESULT_UPDATE = 'provide_callback_result';
export const AGENT_STATUS_QUERY = 'agent_status';
export const CLOSE_SIGNAL = 'close';

/**
 * The backstop on every session: well above the agent's own 2-hour lifetime cap and its 60-second
 * close grace. A session started while no worker polls would otherwise sit open for ever, since
 * the lifetime cap is a timer the worker sets. A run that reaches it reads `TASK_STATE_FAILED`.
 * If `CONSULTANT_CAP_LIFETIME_SECONDS` is ever raised past this, raise this with it.
 */
export const SESSION_EXECUTION_TIMEOUT = '3 hours';

const CALL_TIMEOUT_MS = 6_000;
const QUERY_TIMEOUT_MS = 4_000;

/** Thrown for an id that is not a readable consultant session, whatever the reason. */
export class ConsultantNotFound extends Error {
  constructor(taskId) {
    super(`No consultant session with id "${taskId}".`);
    this.name = 'ConsultantNotFound';
  }
}

async function query(handle, name) {
  try {
    return { value: await withDeadline(handle.query(name), QUERY_TIMEOUT_MS, 'the consultant worker') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The engine `src/lib/a2a-consultant-skill.mjs` is handed, bound to a client source.
 *
 * @param {() => Promise<import('@temporalio/client').Client>} clientFor
 * @param {{ taskQueue?: string, newUuid?: () => string }} [options] `taskQueue` exists for the
 *   integration test's worker; no route passes it.
 */
export function createConsultantEngine(clientFor, { taskQueue = CONSULTANT_TASK_QUEUE, newUuid = randomUUID } = {}) {
  /** A handle to a session that exists and is a consultant, or ConsultantNotFound. */
  async function sessionHandle(taskId) {
    if (!isConsultantTaskId(taskId)) throw new ConsultantNotFound(taskId);
    const client = await clientFor();
    const handle = client.workflow.getHandle(taskId);
    let description;
    try {
      description = await withDeadline(handle.describe(), CALL_TIMEOUT_MS, 'Temporal Cloud');
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) throw new ConsultantNotFound(taskId);
      throw err;
    }
    if (description.type !== CONSULTANT_WORKFLOW_TYPE) throw new ConsultantNotFound(taskId);
    return { handle, description };
  }

  return {
    /**
     * Start one session with its first message. Returns once the message is admitted, or, when no
     * worker answers the Update in time, once the start is durable (`accepted: false`).
     */
    async start(text) {
      const client = await clientFor();
      const workflowId = consultantTaskIdFor(newUuid());
      const startWorkflowOperation = new WithStartWorkflowOperation(CONSULTANT_WORKFLOW_TYPE, {
        workflowId,
        taskQueue,
        args: [{}],
        workflowIdConflictPolicy: 'FAIL',
        workflowExecutionTimeout: SESSION_EXECUTION_TIMEOUT,
      });
      try {
        await withDeadline(
          client.workflow.executeUpdateWithStart(SEND_AGENT_MESSAGE_UPDATE, {
            args: [{ type: 'ask', payload: { text } }],
            startWorkflowOperation,
          }),
          CALL_TIMEOUT_MS,
          'the consultant worker',
        );
        return { workflowId, accepted: true };
      } catch (err) {
        // The start may be durable even though the Update was not answered in time. A session that
        // exists is reported as submitted; one that does not is an error.
        const started = await withDeadline(startWorkflowOperation.workflowHandle(), 500, 'the start').then(
          () => true,
          () => false,
        );
        if (started) return { workflowId, accepted: false };
        throw err;
      }
    },

    /**
     * One reading: the server's account and both Queries, each best-effort.
     *
     * The Queries run one after the other, `agent_status` first, and never in parallel. Each is
     * answered at the workflow's state at that moment, so in parallel the session could be read
     * before a turn's end and the status after it, and an idle task would show the previous turn's
     * reply. In this order the session is never older than the status.
     */
    async read(taskId) {
      const { handle, description } = await sessionHandle(taskId);
      const status = await query(handle, AGENT_STATUS_QUERY);
      const session = await query(handle, CONSULTANT_SESSION_QUERY);
      return {
        execution: description.status.name,
        status: status.value ?? null,
        session: session.value ?? null,
        ...(status.error || session.error ? { queryError: status.error ?? session.error } : {}),
      };
    },

    async answer(taskId, toolId, text) {
      const { handle } = await sessionHandle(taskId);
      await withDeadline(
        handle.executeUpdate(PROVIDE_CALLBACK_RESULT_UPDATE, {
          args: [{ tool_id: toolId, result: text, error: null }],
        }),
        CALL_TIMEOUT_MS,
        'the consultant worker',
      );
    },

    async decide(taskId, toolId, approved) {
      const { handle } = await sessionHandle(taskId);
      await withDeadline(
        handle.executeUpdate(TOOL_APPROVAL_UPDATE, {
          args: [{ tool_id: toolId, approved, reason: approved ? null : 'refused by the caller' }],
        }),
        CALL_TIMEOUT_MS,
        'the consultant worker',
      );
    },

    async send(taskId, text) {
      const { handle } = await sessionHandle(taskId);
      await withDeadline(
        handle.executeUpdate(SEND_AGENT_MESSAGE_UPDATE, { args: [{ type: 'ask', payload: { text } }] }),
        CALL_TIMEOUT_MS,
        'the consultant worker',
      );
    },

    async close(taskId) {
      const { handle } = await sessionHandle(taskId);
      await withDeadline(handle.signal(CLOSE_SIGNAL), CALL_TIMEOUT_MS, 'Temporal Cloud');
    },
  };
}

/** The engine `/a2a` uses: the site's own client. Nothing a caller sends reaches the argument. */
export const consultantEngine = createConsultantEngine(getClient);
