import { entryFileText, type FindingFacts } from './fix-log-rules.js';
import { parseFrontmatter } from './frontmatter.js';

/**
 * The fix log confirmation (STW-712, slice 4 of the fix log writer). After
 * production verifies a fix, Steward completes the entry on `master` with what is
 * only true after the merge, in a pull request it merges itself. Pure: the
 * activities in `activities/fix-log-confirm.ts` fetch, and these functions decide.
 *
 * The confirmed fields are the only ones the confirmation writes, and the only
 * ones a pull request Steward merges by itself may change. The writer's fields
 * (`title`, `slug`, `lead`, `measures`, `text`, the story) and every other fact
 * stay as they are on `master`, so a person's edit to them is never overwritten.
 */
export const CONFIRMED_FIELDS: readonly string[] = ['status', 'confirmedBy', 'verified', 'changes', 'checks'];

/** One fix pull request as `changes` lists it. */
export interface EntryChange {
  number: number;
  title: string;
  opened: string;
  merged?: string;
}

/** What the confirmation knows of the pull requests: the attempt's own, and a reader for the others' merge times. */
export interface ConfirmInput {
  /** The facts of the finding after the verify, through `findingFacts`. */
  facts: FindingFacts;
  /** The pull request of the attempt production just verified. */
  pr: EntryChange;
  /** The merge time of another listed pull request, or null when it is not merged. */
  mergedAt?: (number: number) => string | null | undefined;
}

export type ConfirmedEntry =
  | { state: 'confirmed'; text: string }
  | { state: 'already'; reason: string }
  | { state: 'unverified'; reason: string };

interface Parsed {
  data: Record<string, any>;
  story: string;
}

function parse(text: string): Parsed {
  const { data, content } = parseFrontmatter(text.replace(/\r\n/g, '\n')) as { data: Record<string, any>; content: string };
  return { data, story: content };
}

/**
 * YAML reads an unquoted date as a `Date`. Steward writes every date quoted, so
 * this only matters for an entry a person wrote; it keeps a date-only value
 * date-only when the file is written again.
 */
function plainValue(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  return value;
}

/** True when the entry already holds `verified` and lists `number` as merged: confirmed for that pull request. */
export function confirmedFor(data: Record<string, any>, number: number): boolean {
  const changes: Array<Record<string, unknown>> = Array.isArray(data.changes) ? data.changes : [];
  return Boolean(data.verified) && changes.some((c) => Number(c?.number) === number && Boolean(c?.merged));
}

/**
 * The entry on `master` with its confirmed fields completed from the finding after
 * the verify: `status`, `confirmedBy`, `verified`, `checks`, and in `changes` each
 * merged pull request's `merged` time, with the attempt's own pull request added
 * when it is not listed (a later attempt on a reopened finding). Every other key
 * keeps its value and its place; `verified` goes after `approved`.
 *
 * `already` when the entry is confirmed for this pull request by this verify. `unverified` when
 * the finding holds no verification on production.
 */
export function confirmEntry(entryText: string, input: ConfirmInput): ConfirmedEntry {
  const { facts, pr } = input;
  if (!facts.verified) return { state: 'unverified', reason: 'the finding holds no verification on production' };
  const { data, story } = parse(entryText);
  // Per pull request and per verify: a second verify of the same PR (a park resumed) confirms again.
  if (confirmedFor(data, pr.number) && same(data.verified, facts.verified)) {
    return { state: 'already', reason: `the entry is already confirmed for PR ${pr.number} by this verify` };
  }

  const listed: EntryChange[] = (Array.isArray(data.changes) ? data.changes : []).map((c: Record<string, unknown>) => {
    const change: EntryChange = { number: Number(c.number), title: String(c.title ?? ''), opened: String(plainValue(c.opened) ?? '') };
    const merged = c.merged ? String(plainValue(c.merged)) : Number(c.number) === pr.number ? pr.merged : input.mergedAt?.(Number(c.number)) ?? undefined;
    if (merged) change.merged = merged;
    return change;
  });
  if (!listed.some((c) => c.number === pr.number)) listed.push({ ...pr });

  const confirmed: Record<string, unknown> = {
    status: facts.status,
    confirmedBy: facts.confirmedBy,
    verified: facts.verified,
    changes: listed,
    checks: facts.checks,
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = key in confirmed ? confirmed[key] : plainValue(value);
    if (key === 'approved' && !('verified' in data)) out.verified = confirmed.verified;
  }
  for (const key of CONFIRMED_FIELDS) if (!(key in out)) out[key] = confirmed[key];
  return { state: 'confirmed', text: entryFileText(out, story) };
}

/** A value as the comparison reads it: a date in any form is its instant, so re-quoting a date is no change. */
function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, comparable(v)]));
  }
  return value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

/**
 * Why the change from `baseText` (the entry on `master`) to `headText` (the
 * entry in the pull request) is more than a confirmation, or null when it is
 * only that: the story and every field outside {@link CONFIRMED_FIELDS} are
 * equal, and each pull request `changes` already listed is equal apart from a
 * `merged` time it gained. New pull requests may follow the listed ones.
 */
export function confirmationDiffRefusal(baseText: string, headText: string): string | null {
  let base: Parsed;
  let head: Parsed;
  try {
    base = parse(baseText);
    head = parse(headText);
  } catch (err) {
    return `the entry's frontmatter does not parse: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (base.story.trim() !== head.story.trim()) return 'the story changed';
  const keys = new Set([...Object.keys(base.data), ...Object.keys(head.data)]);
  const changed = [...keys].filter((k) => !CONFIRMED_FIELDS.includes(k) && !same(base.data[k], head.data[k]));
  if (changed.length > 0) return `fields outside the confirmed ones changed: ${changed.join(', ')}`;
  const was: Array<Record<string, unknown>> = Array.isArray(base.data.changes) ? base.data.changes : [];
  const now: Array<Record<string, unknown>> = Array.isArray(head.data.changes) ? head.data.changes : [];
  if (now.length < was.length) return 'a pull request was removed from changes';
  for (let i = 0; i < was.length; i++) {
    const before = was[i] ?? {};
    const after = now[i] ?? {};
    const { merged: mergedBefore, ...restBefore } = before;
    const { merged: mergedAfter, ...restAfter } = after;
    if (!same(restBefore, restAfter)) return `changes[${i}] changed beyond its merge time`;
    if (mergedBefore !== undefined && !same(mergedBefore, mergedAfter)) return `changes[${i}].merged changed`;
  }
  return null;
}

/**
 * The confirmation's branch for one entry, one pull request and one verify. A
 * retry finds its own branch; a later verify of the same pull request gets a new one.
 */
export function confirmationBranch(key: string, prNumber: number, verified: string): string {
  const stamp = new Date(verified).toISOString().slice(0, 19).replace(/[-:]/g, '');
  return `steward/fix-log-confirm-${key.toLowerCase()}-pr${prNumber}-${stamp.toLowerCase()}`;
}
