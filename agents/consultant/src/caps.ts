/**
 * The session caps: values, the session's running counts, and the arithmetic that says which cap
 * a session has reached. Pure and deterministic, so the workflow and the unit tests share it.
 *
 * The caps bound one session. Nothing here bounds sessions per day or total spend; that belongs to
 * whatever starts sessions (the A2A adapter).
 */
import { z } from 'zod';

export const Caps = z.object({
  /** Messages (turns) one session answers. */
  turns: z.number().int().positive(),
  /** Tool calls in one turn. The model gets one more call than this, to answer. */
  toolCallsPerTurn: z.number().int().positive(),
  /** Deep audits in one session. */
  deepAudits: z.number().int().nonnegative(),
  /**
   * Tokens across every model call in the session, as the provider totals them: input, output, and
   * cache reads and writes. Strands' `limits.totalTokens` counts the same figure.
   */
  tokens: z.number().int().positive(),
  /** Output tokens in one model call. */
  maxOutputTokens: z.number().int().positive(),
  /** Seconds with no message before the session closes. */
  idleSeconds: z.number().int().positive(),
  /** Seconds from start before the session closes, whatever it is doing. */
  lifetimeSeconds: z.number().int().positive(),
  /**
   * Seconds between a cap ending the session and the agent closing. The last reply is only on the
   * stream, and a closed agent's stream cannot be read, so the caller gets this long to read it.
   */
  closeGraceSeconds: z.number().int().nonnegative(),
});
export type Caps = z.infer<typeof Caps>;

export const DEFAULT_CAPS: Caps = {
  turns: 12,
  toolCallsPerTurn: 5,
  deepAudits: 1,
  tokens: 150_000,
  maxOutputTokens: 1024,
  idleSeconds: 30 * 60,
  lifetimeSeconds: 2 * 60 * 60,
  closeGraceSeconds: 60,
};

export const END_REASONS = ['cap:turns', 'cap:tool_calls', 'cap:tokens', 'cap:lifetime'] as const;
export type EndReason = (typeof END_REASONS)[number];

/** What the `consultant_session` Query returns. */
export interface Session {
  caps: Caps;
  turns: number;
  toolCallsThisTurn: number;
  deepAudits: number;
  /** The figure the token cap counts: input, output, and cache reads and writes. */
  totalTokens: number;
  outputTokens: number;
  /** Of `totalTokens`, those read from the prompt cache. */
  cacheReadTokens: number;
  /** Charged for turns whose usage was never reported: the output limit for each. */
  unmeteredTokens: number;
  /** Set once, when a cap ends the session. Idle closes show in `agent_status.close_reason`. */
  ended: { reason: EndReason; turn: number } | null;
}

export function newSession(caps: Caps): Session {
  return {
    caps,
    turns: 0,
    toolCallsThisTurn: 0,
    deepAudits: 0,
    totalTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    unmeteredTokens: 0,
    ended: null,
  };
}

export function tokensUsed(s: Session): number {
  return s.totalTokens;
}

/** Tokens the next turn may spend: never less than 1, since Strands rejects a zero limit. */
export function tokensLeft(s: Session): number {
  return Math.max(1, s.caps.tokens - tokensUsed(s));
}

/**
 * Strands' `limits.turns` counts model calls. A turn may make `toolCallsPerTurn` tool calls, each
 * after a model call, and then one more model call to answer.
 */
export function modelCallsPerTurn(caps: Caps): number {
  return caps.toolCallsPerTurn + 1;
}

/**
 * Which cap, if any, the session has reached after a turn. `stopReason` is the Strands stop reason
 * of that turn. Order matters: a turn stopped by a limit names that limit, before the turn count.
 */
export function capReached(s: Session, stopReason: string | undefined): EndReason | null {
  if (stopReason === 'limitTurns' || s.toolCallsThisTurn > s.caps.toolCallsPerTurn) return 'cap:tool_calls';
  if (stopReason === 'limitTotalTokens' || tokensUsed(s) >= s.caps.tokens) return 'cap:tokens';
  if (s.turns >= s.caps.turns) return 'cap:turns';
  return null;
}

/** Read caps from the environment, on the worker. Each value is an integer; a bad one throws. */
export function capsFromEnv(env: Record<string, string | undefined>): Caps {
  const pick = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
    return n;
  };
  return Caps.parse({
    turns: pick('CONSULTANT_CAP_TURNS', DEFAULT_CAPS.turns),
    toolCallsPerTurn: pick('CONSULTANT_CAP_TOOL_CALLS', DEFAULT_CAPS.toolCallsPerTurn),
    deepAudits: pick('CONSULTANT_CAP_DEEP_AUDITS', DEFAULT_CAPS.deepAudits),
    tokens: pick('CONSULTANT_CAP_TOKENS', DEFAULT_CAPS.tokens),
    maxOutputTokens: pick('CONSULTANT_CAP_OUTPUT_TOKENS', DEFAULT_CAPS.maxOutputTokens),
    // Fixed: the harness takes its idle close from the agent definition, before any activity runs.
    idleSeconds: DEFAULT_CAPS.idleSeconds,
    lifetimeSeconds: pick('CONSULTANT_CAP_LIFETIME_SECONDS', DEFAULT_CAPS.lifetimeSeconds),
    closeGraceSeconds: DEFAULT_CAPS.closeGraceSeconds,
  });
}
