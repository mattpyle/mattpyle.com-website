import { ApplicationFailure } from '@temporalio/activity';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  checkEntry,
  entryData,
  entryFileText,
  entryPath,
  findingFacts,
  measureSchema,
  slugFromTitle,
  textPairSchema,
  type FindingFacts,
  type RuleFailure,
  type Taken,
} from './fix-log-rules.js';
import { stripFences, type FixLogSend } from './llm.js';

/**
 * Drafts one fix log entry with the model, checks it against Steward's copy of the
 * entry rules (`fix-log-rules.ts`), and sends a failing draft back with its reasons.
 *
 * SHAPED AS AN ACTIVITY. Slice 3 of the fix log writer runs this as `draftFixLogEntry`
 * in `findingWorkflow`; today only `steward fix-log backfill` calls it. So: plain JSON
 * in and out, the model behind an injected `send`, the caller's cancellation `signal`
 * passed to each call, an `onAttempt` hook where an activity heartbeats, and the last
 * failure non-retryable (Temporal skill, `core/ai-patterns.md`). The correction loop is
 * bounded inside the call, so a Temporal retry starts a fresh conversation.
 *
 * WHAT THE MODEL WRITES. Only the text: title, lead, `visual`, `screen`, one measure or
 * one changed-text pair, and the story. Steward writes every fact from the finding and
 * the pull request, and derives the slug from the title, so a clash or a slug over the
 * limit is a title problem and the correction asks for a new title.
 *
 * The brief is the caller's to read, from `master` only: the fixer must not steer what
 * Steward publishes by editing the brief in its own pull request.
 */

/** Model turns in one call: the first draft and two corrections. */
export const FIX_LOG_MAX_ATTEMPTS = 3;
/** The diff the model reads, cut here with a marker line. */
export const DIFF_MAX_CHARS = 60_000;

export interface DraftFixLogEntryInput {
  finding: { key: string; text: string };
  pr: { number: number; title: string; body: string; diff: string; opened: string; merged: string | null };
  /** `agents/steward/briefs/fix-log.md`, as `master` holds it. */
  brief: string;
  /** The titles and slugs every other entry holds. */
  taken: Taken;
}

export interface DraftFixLogEntryResult {
  key: string;
  /** Repository-relative: `src/content/fixes/<key>.md`. */
  path: string;
  text: string;
  title: string;
  slug: string;
  /** Model turns used. 1 means the first draft passed. */
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DraftDeps {
  send: FixLogSend;
  signal?: AbortSignal;
  /** Called before each model turn; an activity heartbeats here. */
  onAttempt?: (attempt: number) => void;
}

/** The answer the model gives: the text fields, as JSON. */
export const writingSchema = z
  .object({
    title: z.string().min(1),
    lead: z.string().min(1),
    visual: z.boolean(),
    screen: z.enum(['phone', 'desktop']).optional(),
    measure: measureSchema.partial({ quoted: true }).optional(),
    text: textPairSchema.optional(),
    story: z.string().min(1),
  })
  .strict();

export type ModelWriting = z.infer<typeof writingSchema>;

const OUTPUT_CONTRACT = `## What you return

Return one JSON object and nothing else: no prose and no code fences. Its fields:

- "title": the title. Aim for 40 to 65 characters.
- "lead": the lead, one sentence under 25 words.
- "visual": true when something visible on a page changed.
- "screen": "phone" or "desktop", only when "visual" is true.
- "measure": the one measure, as {"label", "before", "after", "quoted"?, "sides"?}. Leave it out when you use "text".
- "text": the changed text, as {"before", "after"}, each a specimen: {"kind": "lines", "label", "lines": [{"text", "mark"?: "added" | "removed"}]}, {"kind": "spoken", "label", "words": [...]}, or {"kind": "missing", "label", "text"}. Leave it out when you use "measure".
- "story": the story, as markdown paragraphs separated by a blank line.

Do not return a slug. Steward makes it from your title. Do not return dates, keys, checks or pull request numbers: Steward writes every fact.`;

/** The system prompt: the brief, then the answer's shape. */
export function systemPrompt(brief: string): string {
  return `${brief.trim()}\n\n${OUTPUT_CONTRACT}\n`;
}

function cutDiff(diff: string): string {
  if (diff.length <= DIFF_MAX_CHARS) return diff;
  return `${diff.slice(0, DIFF_MAX_CHARS)}\n[The diff is cut here: ${diff.length - DIFF_MAX_CHARS} more characters.]`;
}

/** The first user turn: the facts Steward will write, the finding, the pull request and the titles taken. */
export function userPrompt(input: DraftFixLogEntryInput, facts: FindingFacts): string {
  const shown = {
    status: facts.status,
    confirmedBy: facts.confirmedBy,
    where: facts.where,
    confirmedOnProduction: facts.verified !== null,
    checks: facts.checks,
  };
  return [
    `Write the fix log entry for ${facts.key}.`,
    '',
    '## The facts Steward writes into the entry',
    '',
    JSON.stringify(shown, null, 2),
    '',
    '## The finding',
    '',
    input.finding.text.trim(),
    '',
    `## The fix pull request: #${input.pr.number} ${input.pr.title}`,
    '',
    input.pr.body.trim() || '(no body)',
    '',
    '## Its diff',
    '',
    cutDiff(input.pr.diff),
    '',
    '## The titles of the existing entries',
    '',
    'Your title must differ from each of these, and must not open with the same thing.',
    '',
    ...input.taken.titles.map((t) => `- ${t}`),
  ].join('\n');
}

function correction(failures: RuleFailure[]): string {
  return [
    'Your entry fails these checks:',
    '',
    ...failures.map((f) => `- ${f.rule}: ${f.reason}`),
    '',
    'Return the whole corrected JSON object, and nothing else.',
  ].join('\n');
}

/** The reply as writing, or the reasons it is not. */
function parseWriting(raw: string): { writing: ModelWriting } | { failures: RuleFailure[] } {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (err) {
    return { failures: [{ rule: 'json', reason: `the reply is not one JSON object: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const parsed = writingSchema.safeParse(json);
  if (parsed.success) return { writing: parsed.data };
  return {
    failures: parsed.error.issues.map((i) => ({ rule: 'shape', reason: `${i.path.join('.') || '(reply)'}: ${i.message}` })),
  };
}

/**
 * One entry, drafted and checked. Throws `ApplicationFailure.nonRetryable` with type
 * `FixLogEntryInvalid` when the last of {@link FIX_LOG_MAX_ATTEMPTS} drafts still fails,
 * and `FindingNotInLog` when the finding has no fix pull request or names another one.
 */
export async function draftFixLogEntry(input: DraftFixLogEntryInput, deps: DraftDeps): Promise<DraftFixLogEntryResult> {
  const facts = findingFacts(input.finding.text);
  if (!facts || facts.key !== input.finding.key) {
    throw ApplicationFailure.nonRetryable(`${input.finding.key}: the finding has no fix pull request, or another key.`, 'FindingNotInLog');
  }
  if (facts.pr !== input.pr.number) {
    throw ApplicationFailure.nonRetryable(
      `${facts.key}: the finding's fix pull request is #${facts.pr}, not #${input.pr.number}.`,
      'FindingNotInLog',
    );
  }
  const pr = { number: input.pr.number, title: input.pr.title, opened: input.pr.opened, merged: input.pr.merged };
  const system = systemPrompt(input.brief);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt(input, facts) }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let failures: RuleFailure[] = [];

  for (let attempt = 1; attempt <= FIX_LOG_MAX_ATTEMPTS; attempt++) {
    deps.onAttempt?.(attempt);
    const reply = await deps.send(system, messages, { signal: deps.signal });
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;

    const read = parseWriting(reply.text);
    if ('writing' in read) {
      const w = read.writing;
      const data = entryData(facts, pr, {
        title: w.title.trim(),
        lead: w.lead.trim(),
        visual: w.visual,
        ...(w.screen ? { screen: w.screen } : {}),
        ...(w.measure ? { measures: [{ ...w.measure, quoted: w.measure.quoted ?? false }] } : {}),
        ...(w.text ? { text: w.text } : {}),
        story: w.story,
      });
      const text = entryFileText(data, w.story);
      failures = checkEntry(text, input.taken, { newEntry: true });
      if (failures.length === 0) {
        return {
          key: facts.key,
          path: entryPath(facts.key),
          text,
          title: w.title.trim(),
          slug: slugFromTitle(w.title.trim()),
          attempts: attempt,
          usage,
        };
      }
    } else {
      failures = read.failures;
    }
    if (attempt < FIX_LOG_MAX_ATTEMPTS) {
      messages.push({ role: 'assistant', content: reply.text });
      messages.push({ role: 'user', content: correction(failures) });
    }
  }

  throw ApplicationFailure.nonRetryable(
    `${facts.key}: the draft still fails after ${FIX_LOG_MAX_ATTEMPTS} attempts: ${failures.map((f) => `${f.rule}: ${f.reason}`).join('; ')}`,
    'FixLogEntryInvalid',
    { attempts: FIX_LOG_MAX_ATTEMPTS, usage, failures },
  );
}
