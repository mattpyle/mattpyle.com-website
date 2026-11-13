/**
 * The audit consultant: one harness agent, driven by Claude through the Strands integration.
 * Workflow code. Deterministic only; every call to the outside world is an activity.
 *
 * The model owns the path: whether to audit, which tier, when to ask the caller. The workflow owns
 * the bounds:
 *
 * - Caps come from the worker through the `consultantSettings` local activity, never from the
 *   caller, and are written into history once.
 * - Turns, tokens and tool calls are counted here. Strands' own `limits` stop a turn's model loop
 *   before it passes the tool-call or token budget, so a cap bites mid-turn, not only after it.
 * - A deep audit is gated: `deep_audit` is not inherently safe, so the harness parks the call until
 *   the caller approves it with the `tool_approval` Update. `setup` reinstates the policy, so a
 *   starter's config cannot widen it.
 * - A cap ends the session: the answer to the turn still goes out, `consultant_session` reports the
 *   reason, and later messages get a fixed reply with no model call. After a grace period, the
 *   harness's own `close` signal closes the agent. An activity sends it, because a workflow cannot
 *   signal itself.
 */
import { z } from 'zod';
import { ApplicationFailure, defineQuery, proxyActivities, proxyLocalActivities, setHandler, sleep, workflowInfo } from '@temporalio/workflow';
import {
  TextMessage,
  TextReply,
  ToolApprovalPolicy,
  defineAgent,
  handler,
  tool,
} from '@temporalio/agent-harness';
import { asStrandsTool, harnessStrandsAgent } from '@temporalio/agent-harness/ai-sdks/strands-agents-harness';
import type { ConsultantActivities } from './activities.js';
import {
  DEFAULT_CAPS,
  capReached,
  modelCallsPerTurn,
  newSession,
  tokensLeft,
  type EndReason,
  type Session,
} from './caps.js';
import { AGENT_NAME, MODEL, SESSION_QUERY } from './names.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { ToolResult, UrlInput, refused, type Refusal } from './tools.js';

export { AGENT_NAME, MODEL, SESSION_QUERY };
export const sessionQuery = defineQuery<Session>(SESSION_QUERY);

/**
 * The model activity's options. The heartbeat timeout is what lets a dead worker's model call
 * retry in seconds, not after the start-to-close timeout: the harness heartbeats per chunk only
 * when one is set.
 */
export const MODEL_ACTIVITY_OPTIONS = { startToCloseTimeout: '2 minutes', heartbeatTimeout: '20 seconds' } as const;

const settings = proxyLocalActivities<ConsultantActivities>({ startToCloseTimeout: '10 seconds' });
const fast = proxyActivities<ConsultantActivities>({
  startToCloseTimeout: '90 seconds',
  retry: { maximumAttempts: 2 },
});
const deepStart = proxyActivities<ConsultantActivities>({
  startToCloseTimeout: '60 seconds',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});
const deepAwait = proxyActivities<ConsultantActivities>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 5 },
});
const control = proxyActivities<ConsultantActivities>({ startToCloseTimeout: '30 seconds' });

/** The harness hands a Strands MaxTokensError to workflow code as a typed ApplicationFailure. */
const isMaxTokens = (err: unknown) =>
  err instanceof ApplicationFailure ? err.type === 'MaxTokensError' : (err as Error | null)?.name === 'MaxTokensError';

const TOO_LONG_TEXT =
  'My answer ran past its length limit, so I stopped. Ask again for a shorter answer or one part of it.';

const ENDED_TEXT = (reason: EndReason) =>
  `This session has ended (${reason}). Start a new session to continue.`;

export const AuditConsultant = defineAgent({
  name: AGENT_NAME,
  approvalPolicyDefault: ToolApprovalPolicy.allowInherentlySafe(),
  closeAfterIdleDefault: `${DEFAULT_CAPS.idleSeconds} seconds`,
  handlers: {
    ask: handler({
      description: "Ask the audit consultant about a website's readiness for AI agents.",
      input: TextMessage,
      output: TextReply,
    }),
  },
  create: ({ runner }) => {
    let session = newSession(DEFAULT_CAPS);
    setHandler(sessionQuery, () => session);

    /**
     * Ends the session now and closes the agent after the grace period. Until then every message
     * gets the ended reply, with no model call, and the caller can still read the last answer.
     */
    const end = (reason: EndReason) => {
      if (session.ended) return;
      session = { ...session, ended: { reason, turn: session.turns } };
      void sleep(session.caps.closeGraceSeconds * 1000).then(() =>
        control.consultantCloseSession({ workflowId: workflowInfo().workflowId }),
      );
    };

    /** Counts a tool call; returns a refusal once the turn has used its share. */
    const admitToolCall = (): Refusal | null => {
      if (session.ended) return refused('session_ended');
      session.toolCallsThisTurn += 1;
      return session.toolCallsThisTurn > session.caps.toolCallsPerTurn ? refused('cap:tool_calls') : null;
    };

    const auditSite = tool({
      name: 'audit_site',
      description:
        'Run a fast agent-readiness audit of one website over plain HTTP. Returns check ids, ' +
        'statuses, severities and counts. Takes seconds.',
      inputSchema: UrlInput,
      outputSchema: ToolResult,
      inherentlySafe: true,
      execute: async ({ url }) => admitToolCall() ?? fast.consultantFastAudit({ url }),
    });

    const deepAudit = tool({
      name: 'deep_audit',
      description:
        'Run a deep audit of one website: everything audit_site checks, plus pages rendered in a ' +
        'real browser with Lighthouse and axe scores. Takes minutes. Needs the caller to approve it.',
      inputSchema: UrlInput,
      outputSchema: ToolResult,
      execute: async ({ url }) => {
        const gate = admitToolCall();
        if (gate) return gate;
        if (session.deepAudits >= session.caps.deepAudits) return refused('cap:deep_audits');
        session.deepAudits += 1;
        const handle = await deepStart.consultantStartDeepAudit({ url });
        if ('status' in handle) return handle;
        return deepAwait.consultantAwaitDeepAudit(handle);
      },
    });

    const askUser = tool({
      name: 'ask_user',
      description: 'Ask the caller one question and wait for the answer.',
      inputSchema: z.object({ question: z.string().min(1).max(500) }),
      outputSchema: z.string().max(4000),
      inherentlySafe: true,
    });

    const agent = harnessStrandsAgent(runner, {
      model: MODEL,
      activityOptions: MODEL_ACTIVITY_OPTIONS,
      systemPrompt: SYSTEM_PROMPT,
      tools: [auditSite, deepAudit, askUser].map((t) => asStrandsTool(runner, t)),
      printer: false,
    });

    return {
      async setup() {
        session = newSession(await settings.consultantSettings());
        // The default policy, whatever the starter's config asked for: deep_audit stays gated.
        runner.setApprovalPolicy(ToolApprovalPolicy.allowInherentlySafe());
        const lifetimeMs = session.caps.lifetimeSeconds * 1000;
        void sleep(lifetimeMs).then(() => end('cap:lifetime'));
      },

      async ask({ text }) {
        if (session.ended) return { text: ENDED_TEXT(session.ended.reason) };
        session.turns += 1;
        session.toolCallsThisTurn = 0;
        const before = agent.messages.length;
        let result;
        try {
          result = await agent.invoke(text, {
            limits: { turns: modelCallsPerTurn(session.caps), totalTokens: tokensLeft(session) },
          });
        } catch (err) {
          if (!isMaxTokens(err)) throw err;
          // The answer ran past the output limit. Strands calls that unrecoverable and leaves the
          // turn half-written, so the turn is rolled back and the caller asked for less. Its usage
          // is not reported, so the cap is charged the whole output limit for it.
          agent.messages.splice(before);
          session = { ...session, unmeteredTokens: session.unmeteredTokens + session.caps.maxOutputTokens };
          session.totalTokens += session.caps.maxOutputTokens;
          const reason = capReached(session, undefined);
          if (reason) end(reason);
          return { text: TOO_LONG_TEXT };
        }
        // Strands accumulates usage over the agent's life, so these are totals, not increments.
        const usage = result.metrics?.accumulatedUsage;
        if (usage) {
          session.totalTokens = usage.totalTokens + session.unmeteredTokens;
          session.outputTokens = usage.outputTokens;
          session.cacheReadTokens = usage.cacheReadInputTokens ?? 0;
        }
        const reply = result.lastMessage.content
          .flatMap((block) => (block.type === 'textBlock' ? [block.text] : []))
          .join('');
        const reason = capReached(session, result.stopReason);
        if (reason) end(reason);
        return { text: reply || (reason ? ENDED_TEXT(reason) : '') };
      },
    };
  },
});
