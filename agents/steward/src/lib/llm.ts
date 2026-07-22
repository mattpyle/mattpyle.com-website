import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { MODEL, RUBRICS_DIR } from '../config.js';
import { log } from './logger.js';

/** Spec §13: one place controls model, temperature, and max_tokens. */
export const LLM_SETTINGS = {
  model: MODEL,
  /**
   * Spec §13. Valid only because `STEWARD_MODEL` defaults to a Sonnet 4.6-era
   * model — `temperature` is rejected outright (400) on Opus 4.7/4.8, Sonnet 5,
   * and Fable 5. If the model is ever moved forward, this field has to go with
   * it; `sendRubricRequest` therefore omits it rather than sending it blindly.
   */
  temperature: 0.2,
  maxTokens: 4000,
} as const;

/** Models that still accept `temperature`. Anything else must omit it. */
function acceptsTemperature(model: string): boolean {
  return !/^claude-(opus-4-[78]|sonnet-5|fable-5|mythos-5)/.test(model);
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

/** Strips ```json fences, which models add despite being told not to. */
export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
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

/**
 * The real Anthropic call. Kept behind the injectable `send` seam so every unit
 * test in this repo runs offline (spec §11: the Steward's tests must not touch
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
