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
 * entry rules (`fix-log-rules.ts`), sends a failing draft back with its reasons, and
 * has a second, independent model call review the passing draft against its sources.
 *
 * SHAPED AS AN ACTIVITY. Slice 3 of the fix log writer runs this as `draftFixLogEntry`
 * in `findingWorkflow`; today only `steward fix-log backfill` calls it. So: plain JSON
 * in and out, the models behind injected `send` and `review`, the caller's cancellation
 * `signal` passed to each call, `onAttempt` and `onReview` hooks where an activity
 * heartbeats, and the last failure non-retryable (Temporal skill, `core/ai-patterns.md`).
 * Every loop is bounded inside the call, so a Temporal retry starts a fresh conversation.
 * One call makes at most 2 x {@link FIX_LOG_MAX_ATTEMPTS} writer turns and
 * {@link FIX_LOG_REVIEW_ROUNDS} reviews; slice 3 sizes the activity's timeout for that.
 *
 * WHAT THE MODEL WRITES. Only the text: title, lead, `visual`, `screen`, one measure or
 * one changed-text pair, and the story. Steward writes every fact from the finding and
 * the pull request, and derives the slug from the title, so a clash or a slug over the
 * limit is a title problem and the correction asks for a new title.
 *
 * THE REVIEW. The mechanical checks hold the rules a program can test; the first
 * backfill met all of them and still invented judgement and numbers. So a passing draft
 * goes to a reviewer: a separate call that reads the brief, the finding, the pull
 * request, the facts Steward wrote (as true) and the writer's fields, and none of the
 * writer's conversation, so it does not inherit the writer's reasoning. It answers
 * accept or a list of problems. A problem that quotes only a fact is dropped, since no
 * correction can change a fact. The rest go back as one correction turn, and the new
 * draft runs the checks and the review again: at most {@link FIX_LOG_REVIEW_ROUNDS}
 * reviews. A draft the reviewer still objects to at the bound is returned with the
 * problems as `reviewNotes`, because a person mends one sentence faster than a fourth
 * try. A returned draft never fails a mechanical check: if the corrected draft cannot
 * pass them, the last one that did is returned with the problems that prompted the
 * correction.
 *
 * The brief is the caller's to read, from `master` only: the fixer must not steer what
 * Steward publishes by editing the brief in its own pull request.
 */

/** Writer turns within one round: the first draft and two mechanical corrections. */
export const FIX_LOG_MAX_ATTEMPTS = 3;
/** Reviews of one entry: the first draft's, and the corrected draft's. */
export const FIX_LOG_REVIEW_ROUNDS = 2;
/** The diff the model reads, cut here with a marker line. */
export const DIFF_MAX_CHARS = 60_000;

export interface DraftFixLogEntryInput {
  finding: { key: string; text: string };
  pr: { number: number; title: string; body: string; diff: string; opened: string; merged: string | null };
  /** `agents/steward/briefs/fix-log.md`, as `master` holds it. */
  brief: string;
  /** The titles and slugs every other entry holds. */
  taken: Taken;
  /** Today, as an ISO date or time. Defaults to now; the brief's tense rule reads it. */
  today?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The writer's and the reviewer's tokens, counted apart. */
export interface DraftUsage {
  writer: TokenUsage;
  reviewer: TokenUsage;
}

/** One problem the reviewer found: the writer's text, the brief's rule, and why. */
export interface ReviewProblem {
  quote: string;
  rule: string;
  reason: string;
}

export interface DraftFixLogEntryResult {
  key: string;
  /** Repository-relative: `src/content/fixes/<key>.md`. */
  path: string;
  text: string;
  title: string;
  slug: string;
  /** Writer turns used. 1 means the first draft passed every check and the review. */
  attempts: number;
  /** Reviews run: 1 or 2. */
  reviewRounds: number;
  /** The reviewer's problems a person must read before merging. Empty when it accepted. */
  reviewNotes: ReviewProblem[];
  usage: DraftUsage;
}

export interface DraftDeps {
  send: FixLogSend;
  /** The reviewer's model. Defaults to `send`; the same model setting serves both. */
  review?: FixLogSend;
  signal?: AbortSignal;
  /** Called before each writer turn; an activity heartbeats here. */
  onAttempt?: (attempt: number) => void;
  /** Called before each review; an activity heartbeats here. */
  onReview?: (round: number) => void;
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

/** The reviewer's answer. */
export const reviewSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('accept') }).strict(),
  z
    .object({
      verdict: z.literal('problems'),
      problems: z
        .array(z.object({ quote: z.string().min(1), rule: z.string().min(1), reason: z.string().min(1) }).strict())
        .min(1),
    })
    .strict(),
]);

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

const REVIEW_CONTRACT = `## Your task: review a fix log entry

Above is the brief a writer followed. You review one entry the writer drafted. You did not write it.

The user turn gives you the finding, the fix pull request (title, body, diff), the facts Steward wrote into the entry, and the writer's fields.

1. The facts Steward wrote are true: the dates, "changes", "checks", "type", "status" and the rest. They are sources, beside the finding and the pull request. Do not judge them and never quote them, because the writer cannot change them. A problem that quotes a fact is dropped.
2. Judge only the writer's fields: "title", "lead", "measure" or "text", "visual", "screen" and "story".
3. Your main question: does the finding, the pull request or the facts hold every claim the writer's fields make? A claim no source holds is a problem, however plausible.
4. Then check each field against the brief's rules.

The first run of this writer failed most often in two ways. Look hardest for both.

1. A judgement about how the fault looked, sounded or reflected on the site. Example: "The stale heading made the page look unmaintained." The brief asks for what the reader could not do instead.
2. A number or an event that no source holds. Example: "Sections the page named that exist: 2 of 5", where the 5 counts the lines the fix added, not anything on the site.

When you doubt that a source holds a claim, search the finding and the pull request for it. In the reason, quote the closest source line you found, or name what you searched for and say no source holds it. A person reads your reason and must see what was searched.

## What you return

Return one JSON object and nothing else: no prose and no code fences. Either:

- {"verdict": "accept"} when every claim is held and every rule is met; or
- {"verdict": "problems", "problems": [{"quote", "rule", "reason"}]}, one item per problem. "quote" is the writer's text exactly as it appears in a field, short enough to find. "rule" names the brief's rule, or "unsupported" for a claim no source holds. "reason" says why, as above.

Report only real problems. Do not rewrite the entry, and ask for no change the brief does not ask for.`;

/** The system prompt: the brief, then the answer's shape. */
export function systemPrompt(brief: string): string {
  return `${brief.trim()}\n\n${OUTPUT_CONTRACT}\n`;
}

/** The reviewer's system prompt: the brief, then the review's task and shape. */
export function reviewSystemPrompt(brief: string): string {
  return `${brief.trim()}\n\n${REVIEW_CONTRACT}\n`;
}

function cutDiff(diff: string): string {
  if (diff.length <= DIFF_MAX_CHARS) return diff;
  return `${diff.slice(0, DIFF_MAX_CHARS)}\n[The diff is cut here: ${diff.length - DIFF_MAX_CHARS} more characters.]`;
}

const DAY_MS = 86_400_000;

/** The dates the tense rule reads: the merge (or the opening), today, and the days between. */
export function timing(input: Pick<DraftFixLogEntryInput, 'pr' | 'today'>): string {
  const fixed = input.pr.merged ?? input.pr.opened;
  const today = input.today ?? new Date().toISOString();
  const days = Math.floor((Date.parse(today) - Date.parse(fixed)) / DAY_MS);
  const what = input.pr.merged ? 'merged' : 'was opened, not yet merged,';
  return `The fix pull request ${what} at ${fixed}. Today is ${today.slice(0, 10)}, ${Number.isFinite(days) ? days : 'an unknown number of'} days later.`;
}

function sources(input: DraftFixLogEntryInput): string[] {
  return [
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
  ];
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
    timing(input),
    '',
    ...sources(input),
    '',
    '## The titles of the existing entries',
    '',
    'Your title must differ from each of these, and must not open with the same thing.',
    '',
    ...input.taken.titles.map((t) => `- ${t}`),
  ].join('\n');
}

/** The reviewer's one user turn: the sources, the facts as true, and the writer's fields. */
export function reviewPrompt(input: DraftFixLogEntryInput, facts: Record<string, unknown>, writing: ModelWriting): string {
  return [
    `Review the fix log entry for ${input.finding.key}.`,
    '',
    ...sources(input),
    '',
    '## The facts Steward wrote into the entry (true; do not quote them)',
    '',
    JSON.stringify(facts, null, 2),
    '',
    timing(input),
    '',
    "## The writer's fields (judge these)",
    '',
    JSON.stringify(writing, null, 2),
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

function reviewCorrection(problems: ReviewProblem[]): string {
  return [
    'A reviewer read your entry against the finding and the pull request, and found these problems:',
    '',
    ...problems.map((p) => `- "${p.quote}" (${p.rule}): ${p.reason}`),
    '',
    'Mend each one. Cut a claim no source holds rather than reword it. Return the whole corrected JSON object, and nothing else.',
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

/** The rule of the problem that stands for a review that could not be read. */
export const UNREAD_REVIEW_RULE = 'review';

const unread = (reason: string): ReviewProblem => ({ quote: '(the whole entry)', rule: UNREAD_REVIEW_RULE, reason });

/** The reviewer's reply as a list of problems: empty means accept. An unreadable reply is one problem. */
export function parseReview(raw: string): ReviewProblem[] {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (err) {
    return [unread(`the reviewer's reply is not one JSON object: ${err instanceof Error ? err.message : String(err)}`)];
  }
  const parsed = reviewSchema.safeParse(json);
  if (!parsed.success) {
    return [unread(`the reviewer's reply has the wrong shape: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(reply)'}: ${i.message}`).join('; ')}`)];
  }
  return parsed.data.verdict === 'accept' ? [] : parsed.data.problems;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Every string in a value, for finding a quote in. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

/**
 * The problems the writer can mend. A problem whose quote is in the facts and not in
 * the writer's fields is dropped: no correction turn can change a fact. A quote found in
 * neither stays, since a reviewer may paraphrase the writer. The unread-review problem
 * is never the writer's to mend.
 */
export function mendable(problems: ReviewProblem[], writing: ModelWriting, facts: Record<string, unknown>): ReviewProblem[] {
  const written = squash(strings(writing).join('\n'));
  const factText = squash(strings(facts).join('\n'));
  return problems.filter((p) => {
    if (p.rule === UNREAD_REVIEW_RULE) return false;
    const q = squash(p.quote);
    return written.includes(q) || !factText.includes(q);
  });
}

/** The fields of an entry's data that the writer wrote; every other field is a fact. */
const WRITER_FIELDS = new Set(['title', 'slug', 'lead', 'visual', 'screen', 'measures', 'text']);

function factsOf(data: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !WRITER_FIELDS.has(k)));
}

interface Passed {
  writing: ModelWriting;
  text: string;
  facts: Record<string, unknown>;
}

const addUsage = (into: TokenUsage, u: TokenUsage): void => {
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
};

/**
 * One entry, drafted, checked and reviewed. Throws `ApplicationFailure.nonRetryable` with
 * type `FixLogEntryInvalid` when the first round's last draft still fails the checks, and
 * `FindingNotInLog` when the finding has no fix pull request or names another one.
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
  const reviewSystem = reviewSystemPrompt(input.brief);
  const review = deps.review ?? deps.send;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt(input, facts) }];
  const usage: DraftUsage = { writer: { inputTokens: 0, outputTokens: 0 }, reviewer: { inputTokens: 0, outputTokens: 0 } };
  let attempts = 0;

  /** Up to FIX_LOG_MAX_ATTEMPTS writer turns, from the conversation as it stands, until a draft passes the checks. */
  const writeRound = async (): Promise<{ passed: Passed } | { failures: RuleFailure[] }> => {
    let failures: RuleFailure[] = [];
    for (let turn = 1; turn <= FIX_LOG_MAX_ATTEMPTS; turn++) {
      attempts++;
      deps.onAttempt?.(attempts);
      const reply = await deps.send(system, messages, { signal: deps.signal });
      addUsage(usage.writer, reply.usage);
      messages.push({ role: 'assistant', content: reply.text });

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
        if (failures.length === 0) return { passed: { writing: w, text, facts: factsOf(data) } };
      } else {
        failures = read.failures;
      }
      if (turn < FIX_LOG_MAX_ATTEMPTS) messages.push({ role: 'user', content: correction(failures) });
    }
    return { failures };
  };

  const done = (p: Passed, reviewRounds: number, reviewNotes: ReviewProblem[]): DraftFixLogEntryResult => ({
    key: facts.key,
    path: entryPath(facts.key),
    text: p.text,
    title: p.writing.title.trim(),
    slug: slugFromTitle(p.writing.title.trim()),
    attempts,
    reviewRounds,
    reviewNotes,
    usage,
  });

  const first = await writeRound();
  if ('failures' in first) {
    throw ApplicationFailure.nonRetryable(
      `${facts.key}: the draft still fails after ${FIX_LOG_MAX_ATTEMPTS} attempts: ${first.failures.map((f) => `${f.rule}: ${f.reason}`).join('; ')}`,
      'FixLogEntryInvalid',
      { attempts, usage, failures: first.failures },
    );
  }

  let current = first.passed;
  for (let round = 1; ; round++) {
    deps.onReview?.(round);
    const verdict = await review(reviewSystem, [{ role: 'user', content: reviewPrompt(input, current.facts, current.writing) }], {
      signal: deps.signal,
    });
    addUsage(usage.reviewer, verdict.usage);
    const problems = parseReview(verdict.text);
    const toMend = mendable(problems, current.writing, current.facts);
    const unreadable = problems.filter((p) => p.rule === UNREAD_REVIEW_RULE);
    // Accepted, or every problem quoted a fact the writer cannot change.
    if (toMend.length === 0 && unreadable.length === 0) return done(current, round, []);
    if (round >= FIX_LOG_REVIEW_ROUNDS) return done(current, round, [...unreadable, ...toMend]);
    // An unreadable review and nothing to mend: the next round reviews the same draft.
    if (toMend.length === 0) continue;

    messages.push({ role: 'user', content: reviewCorrection(toMend) });
    const next = await writeRound();
    // The corrected draft cannot pass the checks: keep the last one that did, with the problems it had.
    if ('failures' in next) return done(current, round, toMend);
    current = next.passed;
  }
}
