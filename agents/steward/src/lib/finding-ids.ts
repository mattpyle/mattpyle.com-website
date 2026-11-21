import { isFindingSlug } from './findings.js';

/**
 * How a person names a finding in a command, and where a list of ids ends and
 * the words begin. Pure.
 *
 * Three spellings:
 *
 * - a short id: letters, an optional hyphen, digits, in any case (`MP-121`,
 *   `mp121`), normalized to `MP-121`;
 * - a full key: a finding slug that contains `--`, as every key does between
 *   the finding and its page;
 * - `site/key`, for a key two sites share.
 *
 * Anything else is a word.
 */

export type FindingRef =
  | { kind: 'short'; short: string; text: string }
  | { kind: 'key'; key: string; site?: string; text: string };

const SHORT = /^([a-z]+)-?(\d+)$/i;

/** `MP-121` from any accepted spelling of it, or null. */
export function normalizeShortId(value: string): string | null {
  const match = SHORT.exec(value.trim());
  return match ? `${match[1].toUpperCase()}-${Number(match[2])}` : null;
}

/** The finding a token names, or null when the token is a word. */
export function parseFindingRef(token: string): FindingRef | null {
  const short = normalizeShortId(token);
  if (short) return { kind: 'short', short, text: short };
  const lower = token.toLowerCase();
  const slash = lower.indexOf('/');
  if (slash > 0) {
    const site = lower.slice(0, slash);
    const key = lower.slice(slash + 1);
    return isFindingSlug(site) && isFindingSlug(key) ? { kind: 'key', site, key, text: lower } : null;
  }
  return lower.includes('--') && isFindingSlug(lower) ? { kind: 'key', key: lower, text: lower } : null;
}

export interface IdsAndWords {
  refs: FindingRef[];
  /** Everything after the last leading id, as typed. */
  words: string;
}

/**
 * The leading ids of `text` and the words after them. Ids are separated by
 * spaces or commas; the first token that is not an id starts the words. An id
 * named twice counts once.
 */
export function splitIdsAndWords(text: string): IdsAndWords {
  const refs: FindingRef[] = [];
  const seen = new Set<string>();
  let rest = text.trim();
  while (rest !== '') {
    const match = /^([^\s,]+)[\s,]*/.exec(rest);
    if (!match) break;
    const ref = parseFindingRef(match[1]);
    if (!ref) break;
    if (!seen.has(ref.text)) {
      seen.add(ref.text);
      refs.push(ref);
    }
    rest = rest.slice(match[0].length);
  }
  return { refs, words: rest.trim() };
}
