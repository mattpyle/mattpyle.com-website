import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ApplicationFailure } from '@temporalio/activity';
import type { z } from 'zod';
import { FIX_LOG_MODEL, MODEL, RUBRICS_DIR } from '../config.js';
import { log } from './logger.js';

/** Spec §13: one place controls model, temperature, and max_tokens. */
export const LLM_SETTINGS = {
  model: MODEL,
  /**
   * Spec §13. Sent only when the configured model actually accepts it —
   * `temperature` is rejected outright (400) on Opus 5, Opus 4.8, Opus 4.7,
   * Sonnet 5, Fable 5, and Mythos 5. `acceptsTemperature` below is the gate,
   * and it is an allowlist so that moving `STEWARD_MODEL` forward drops the
   * field rather than 400ing.
   */
  temperature: 0.2,
  /**
   * A backstop against a runaway response, not a budget.
   *
   * `max_tokens` is a ceiling, not a reservation — billing follows tokens
   * actually generated, so a high value costs nothing until output genuinely
   * grows. And `sendRubricRequest` **throws** on `stop_reason === 'max_tokens'`
   * rather than degrading, which makes a low value a failure mode instead of a
   * safety valve.
   *
   * It sat at 4000 from the first build, and that number started shaping
   * decisions it had no business shaping: a proposal to raise the
   * eprime-alternatives suggestion count was argued down to ~25 on a token
   * calculation derived entirely from this constant. Raised to 16000, which is
   * still far below what the configured model will emit and still catches a
   * genuinely runaway generation.
   */
  maxTokens: 16000,
} as const;

/**
 * Models that still accept `temperature`. Anything else must omit it.
 *
 * An **allowlist**, deliberately. This was a denylist of the models known to
 * reject `temperature`, which inverted the rule the comment states: every model
 * *not* on the list got `temperature` sent. That fails open — `claude-opus-5`
 * postdated the list, so pointing `STEWARD_MODEL` at it 400s every editorial
 * pass, and the same is true of whatever ships next. An allowlist fails closed:
 * an unrecognised model omits the field, which is valid on every model, because
 * `temperature` is optional everywhere it is accepted at all.
 *
 * Accepted on the 4.6-and-earlier families. Rejected outright (400) on Opus 5,
 * Opus 4.8, Opus 4.7, Sonnet 5, Fable 5, and Mythos 5.
 */
export function acceptsTemperature(model: string): boolean {
  return /^claude-(opus-4-[0156]|sonnet-4-[056]|haiku-4-5|haiku-3|3-)/.test(model);
}

export interface LoadedRubric {
  name: string;
  /** Repo-relative path, for the report's `rubric.path`. */
  path: string;
  sha256: string;
  content: string;
}

/**
 * Spec §8.6 step 1, and design rule 6: prompts are versioned artifacts. The
 * report records the rubric's path *and* content hash so a verdict can always be
 * traced back to the exact text that produced it — a rubric edited after the
 * fact cannot silently claim credit for an older finding.
 */
export async function loadRubric(rubricName: string): Promise<LoadedRubric> {
  const abs = path.join(RUBRICS_DIR, `${rubricName}.md`);
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf8');
  } catch {
    throw new Error(`No rubric named "${rubricName}" at ${abs}.`);
  }
  return {
    name: rubricName,
    path: path.posix.join('agents/steward/src/rubrics', `${rubricName}.md`),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    content,
  };
}

/**
 * Spec §8.6 step 2: the post is handed to the model with line numbers prepended
 * to every line, so a cited `line` is verifiable rather than a guess. Without
 * this the model counts lines itself and is reliably wrong on long posts.
 */
export function withLineNumbers(text: string): string {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width, ' ')}| ${line}`).join('\n');
}

/** Any fenced block anywhere in the response. Global, so the last one can win. */
const FENCED_BLOCK = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

/**
 * Strips ```json fences, which models add despite being told not to.
 *
 * The usual case is a response that is entirely one fenced block. **When there
 * is more than one, the LAST wins.** Observed live on the first real
 * `eprime-alternatives` run: the model emitted a complete answer, then wrote
 * "Wait, let me reconsider properly.", then emitted a second, better one. The
 * previous whole-string pattern was anchored `^…$` and so matched from the first
 * fence to the last, capturing the prose and the inner fences along with it —
 * `JSON.parse` died on that, and the single in-activity retry came back with a
 * *worse* answer than the one already sitting in the discarded response. A model
 * that reconsiders means the reconsidered block, so the last one is the answer.
 *
 * Scanning for blocks rather than special-casing the whole-string shape is what
 * fixes it: the common case is simply "exactly one block found".
 *
 * A response with no fence at all is returned untouched, so a plain JSON reply —
 * including one containing a literal ``` inside a string — is unaffected.
 */
export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const blocks = [...trimmed.matchAll(FENCED_BLOCK)];
  if (blocks.length) return blocks[blocks.length - 1][1].trim();
  return trimmed;
}

/**
 * The injectable transport. Exported so callers can declare a test double
 * without importing the Anthropic SDK's types themselves.
 */
export type RubricSend = (messages: Anthropic.MessageParam[]) => Promise<string>;

export interface CallRubricOptions<T> {
  rubric: LoadedRubric;
  /** The post, already line-numbered. */
  userContent: string;
  schema: z.ZodType<T>;
  /** Injected in tests so the validation/retry path runs with no network. */
  send?: RubricSend;
}

export interface CallRubricResult<T> {
  data: T;
  /** How many times the model had to be asked. 1 = valid first try. */
  attempts: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Spec §8.6 steps 2–3, and design rule 5: structured output or failure.
 *
 * A response that fails Zod validation is retried **once**, in-activity, with
 * the validation error appended as a new turn — models correct a named schema
 * error far more often than they repeat a random one. A second failure throws,
 * which fails the activity and lets Temporal's retry policy take over. Nothing
 * is fuzzily parsed around: there is no "best effort" branch that salvages a
 * malformed response, because a half-parsed editorial verdict is worse than no
 * verdict.
 */
export async function callRubric<T>(options: CallRubricOptions<T>): Promise<CallRubricResult<T>> {
  const send = options.send ?? defaultSend(options.rubric.content);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: options.userContent },
  ];

  let lastError = '';
  let usage: CallRubricResult<T>['usage'];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await send(messages);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripFences(raw));
    } catch (err) {
      lastError = `response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt === 2) break;
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `Your previous response failed validation: ${lastError}. Respond with ONLY the JSON object described in your instructions — no prose, no markdown fences.`,
      });
      log.warn({ rubric: options.rubric.name, attempt, error: lastError }, 'llm response invalid, retrying');
      continue;
    }

    const result = options.schema.safeParse(parsedJson);
    if (result.success) {
      return { data: result.data, attempts: attempt, usage };
    }

    lastError = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    if (attempt === 2) break;
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `Your previous response failed validation: ${lastError}. Respond with ONLY the corrected JSON object — no prose, no markdown fences.`,
    });
    log.warn({ rubric: options.rubric.name, attempt, error: lastError }, 'llm response invalid, retrying');
  }

  throw new Error(
    `The ${options.rubric.name} rubric returned an invalid response twice. Last validation error: ${lastError}`,
  );
}

// ── The fix log's model call ─────────────────────────────────────────────────

/** One attempt's ceiling: under the 5 minutes a slice 3 activity attempt allows. */
export const FIX_LOG_TIMEOUT_MS = 240_000;
/** An entry is a few hundred words; this is a backstop against a runaway answer. */
export const FIX_LOG_MAX_TOKENS = 8000;

export interface FixLogReply {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** The injectable transport of `draftFixLogEntry`. */
export type FixLogSend = (
  system: string,
  messages: Anthropic.MessageParam[],
  options?: { signal?: AbortSignal },
) => Promise<FixLogReply>;

/**
 * The fix log's model call, shaped for a Temporal activity (Temporal skill,
 * `core/ai-patterns.md`): the SDK's own retries are off, so Temporal's retry
 * policy is the only one; one call has a timeout under the activity's 5
 * minutes; the caller's `signal` (an activity's cancellation) aborts it. The
 * failures that a retry cannot mend are non-retryable `ApplicationFailure`s:
 * a missing key, a refused or malformed request (400, 401, 403, 404) and a
 * truncated answer. A rate limit, an overload, a 5xx and a timeout stay
 * retryable.
 */
export function fixLogSend(model: string = FIX_LOG_MODEL): FixLogSend {
  return async (system, messages, options = {}) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw ApplicationFailure.nonRetryable(
        'ANTHROPIC_API_KEY is not set. Drafting a fix log entry needs it.',
        'ModelKeyMissing',
      );
    }
    const client = new Anthropic({ maxRetries: 0, timeout: FIX_LOG_TIMEOUT_MS });
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model,
          max_tokens: FIX_LOG_MAX_TOKENS,
          ...(acceptsTemperature(model) ? { temperature: LLM_SETTINGS.temperature } : {}),
          system,
          messages,
        },
        { signal: options.signal },
      );
    } catch (err) {
      throw classifyModelError(err);
    }
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    log.info({ model: response.model, ...usage, stopReason: response.stop_reason }, 'fix log model call complete');
    if (response.stop_reason === 'max_tokens') {
      throw ApplicationFailure.nonRetryable(
        `The model hit max_tokens (${FIX_LOG_MAX_TOKENS}) while drafting a fix log entry.`,
        'ModelTruncated',
      );
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage };
  };
}

/** The status codes a retry cannot mend: a malformed request, a refused key, a model that does not exist. */
const PERMANENT_MODEL_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

/** A model client error as Temporal should treat it. Exported for the tests. */
export function classifyModelError(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIError && typeof err.status === 'number' && PERMANENT_MODEL_STATUSES.has(err.status)) {
    return ApplicationFailure.nonRetryable(`The model refused the request (${err.status}): ${err.message}`, 'ModelRequestRefused');
  }
  if (err instanceof Anthropic.APIError) {
    return ApplicationFailure.retryable(`The model call failed (${err.status ?? 'no status'}): ${err.message}`, 'ModelUnavailable');
  }
  return err;
}

/**
 * The real Anthropic call. Kept behind the injectable `send` seam so every unit
 * test in this repo runs offline (spec §11: Steward's tests must not touch
 * the network).
 */
function defaultSend(system: string) {
  return async (messages: Anthropic.MessageParam[]): Promise<string> => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. The editorial pass needs it; set it in agents/steward/.env.',
      );
    }
    const client = new Anthropic();
    const response = await client.messages.create({
      model: LLM_SETTINGS.model,
      max_tokens: LLM_SETTINGS.maxTokens,
      ...(acceptsTemperature(LLM_SETTINGS.model)
        ? { temperature: LLM_SETTINGS.temperature }
        : {}),
      system,
      messages,
    });

    log.info(
      {
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason,
      },
      'llm call complete',
    );

    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `The model hit max_tokens (${LLM_SETTINGS.maxTokens}) and the JSON is truncated. Raise LLM_SETTINGS.maxTokens or shorten the post.`,
      );
    }

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  };
}
