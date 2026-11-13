/**
 * Drive one audit-consultant session through a plain Temporal client, by the harness's raw call
 * names. No harness package is imported: this is the shape the A2A adapter will take. Used by the
 * tests and by `scripts/converse.ts`.
 *
 *   Update  send_agent_message       {type: "ask", payload: {text}}
 *   Query   agent_status             turn_active, pending_turns, pending_callbacks, pending_approvals, close_reason
 *   Update  provide_callback_result  {tool_id, result, error}
 *   Update  tool_approval            {tool_id, approved, reason}
 *   Update  __temporal_workflow_stream_poll {topics, from_offset}: the reply text lives only here
 *   Query   consultant_session       this package's caps and counts
 */
import type { Client, WorkflowHandle } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import proto from '@temporalio/proto';
import type { Session as SessionCounts } from '../src/caps.js';
import { AGENT_NAME, SESSION_QUERY } from '../src/names.js';

export interface PendingItem {
  tool_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface AgentStatus {
  turn_active: boolean;
  current_turn: number;
  pending_turns: unknown[];
  pending_callbacks: PendingItem[];
  pending_approvals: PendingItem[];
  close_reason: string | null;
}

export interface StreamEvent {
  type?: string;
  [key: string]: unknown;
}

/** What the caller does when the agent asks a question or asks for approval. */
export interface Caller {
  answer(question: string): string | Promise<string>;
  approve(item: PendingItem): boolean | Promise<boolean>;
}

export interface TurnResult {
  reply: string;
  events: StreamEvent[];
  questions: string[];
  approvals: string[];
}

export class ConsultantSession {
  #offset = 0;

  constructor(readonly handle: WorkflowHandle) {}

  static async start(client: Client, taskQueue: string, workflowId: string): Promise<ConsultantSession> {
    const handle = await client.workflow.start(AGENT_NAME, { workflowId, taskQueue, args: [{}] });
    return new ConsultantSession(handle);
  }

  status(): Promise<AgentStatus> {
    return this.handle.query<AgentStatus>('agent_status');
  }

  session(): Promise<SessionCounts> {
    return this.handle.query<SessionCounts>(SESSION_QUERY);
  }

  async poll(): Promise<StreamEvent[]> {
    const res = await this.handle.executeUpdate<{ items: { data: string; offset: number; topic: string }[]; next_offset: number }, [unknown]>('__temporal_workflow_stream_poll', { args: [{ topics: [], from_offset: this.#offset }] });
    this.#offset = res.next_offset;
    return res.items.map((item) => {
      const payload = proto.temporal.api.common.v1.Payload.decode(Buffer.from(item.data, 'base64'));
      const data = defaultPayloadConverter.fromPayload(payload) as { event?: StreamEvent } | null;
      return data?.event ?? { type: item.topic };
    });
  }

  /** Send one message and run the turn to its end, answering questions and approvals. */
  async ask(text: string, caller: Caller, { pollMs = 250 } = {}): Promise<TurnResult> {
    const sent = await this.handle.executeUpdate<{ turn_number: number; accepted_offset?: number }, [unknown]>(
      'send_agent_message',
      { args: [{ type: 'ask', payload: { text } }] },
    );
    this.#offset = Math.max(this.#offset, sent.accepted_offset ?? 0);
    const questions: string[] = [];
    const approvals: string[] = [];
    for (;;) {
      const s = await this.status();
      const cb = s.pending_callbacks[0];
      if (cb) {
        const question = String(cb.tool_input.question ?? '');
        questions.push(question);
        const result = await caller.answer(question);
        await this.handle.executeUpdate('provide_callback_result', {
          args: [{ tool_id: cb.tool_id, result, error: null }],
        });
        continue;
      }
      const ap = s.pending_approvals[0];
      if (ap) {
        approvals.push(ap.tool_name);
        const approved = await caller.approve(ap);
        await this.handle.executeUpdate('tool_approval', {
          args: [{ tool_id: ap.tool_id, approved, reason: approved ? null : 'declined by the caller' }],
        });
        continue;
      }
      if (!s.turn_active && s.pending_turns.length === 0 && s.current_turn >= sent.turn_number) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const events = await this.poll();
    const end = [...events].reverse().find((e) => e.type === 'message_handler_end');
    const output = end?.output as { text?: string } | undefined;
    return { reply: output?.text ?? '', events, questions, approvals };
  }
}

