/**
 * Shared fixtures of the fix log tests: a synthetic finding, a writing that passes every
 * check, and a scripted model that answers from a queue and records what it was sent.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { FixLogSend } from '../../src/lib/llm.js';

const ORIGIN = 'https://www.mattpyle.com';

export function findingText(key: string, options: { status?: string; pr?: number; verified?: boolean } = {}): string {
  const status = options.status ?? 'resolved';
  const verification = options.verified === false
    ? ''
    : `\n## Verification\n\nSteward ran this finding's checks against production at 2026-11-20T10:00:00.000Z. Outcome: resolved.\n\n1. Pass, \`text\` on ${ORIGIN}/about/. Expected: 0 occurrences of "old line". Measured: 0 occurrences.\n`;
  return `---\nkey: synthetic-${key.toLowerCase()}\nkey_short: ${key}\nstatus: ${status}\nkind: defect\ntype: content\nfirst_seen: 2026-11-18\nverdict_at: 2026-11-19T03:04:05.678Z\nverify:\n  - url: "${ORIGIN}/about/"\n    kind: text\nlinks:\n  pr: https://github.com/mattpyle/mattpyle.com-website/pull/${options.pr ?? 900}\n---\n\n# A synthetic finding\n\n## What happened\n\n- URL: ${ORIGIN}/about/\n${verification}`;
}

export const GOOD = {
  title: 'The about page still named a section it had removed',
  lead: 'A reader looking for that section found nothing under the heading the page promised.',
  visual: false,
  measure: { label: 'Sections the page named that exist', before: '2 of 3', after: '3 of 3' },
  story: 'The about page named three sections.\n\nOne of them had been removed.',
};

export function reply(writing: Record<string, unknown>, usage = { inputTokens: 100, outputTokens: 20 }) {
  return { text: JSON.stringify(writing), usage };
}

/** A model that answers from a queue, and records what it was sent. */
export function scriptedModel(replies: Array<{ text: string; usage: { inputTokens: number; outputTokens: number } }>) {
  const calls: Array<{ system: string; messages: Anthropic.MessageParam[]; signal?: AbortSignal }> = [];
  const send: FixLogSend = async (system, messages, options) => {
    calls.push({ system, messages: [...messages], signal: options?.signal });
    const next = replies.shift();
    if (!next) throw new Error('the scripted model has no reply left');
    return next;
  };
  return { send, calls };
}

/** A reviewer that accepts every draft, and records what it was sent. */
export function acceptingReviewer(usage = { inputTokens: 50, outputTokens: 5 }) {
  const calls: Array<{ system: string; messages: Anthropic.MessageParam[] }> = [];
  const send: FixLogSend = async (system, messages) => {
    calls.push({ system, messages: [...messages] });
    return { text: JSON.stringify({ verdict: 'accept' }), usage };
  };
  return { send, calls };
}

/** A reviewer's reply with these problems. */
export function problems(list: Array<{ quote: string; rule: string; reason: string }>, usage = { inputTokens: 50, outputTokens: 5 }) {
  return { text: JSON.stringify({ verdict: 'problems', problems: list }), usage };
}
