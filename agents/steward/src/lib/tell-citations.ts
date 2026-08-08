import matter from 'gray-matter';
import { TELL_CATEGORIES, type DeterministicTellFinding, type TellCategory } from './tells.js';

/**
 * Shared shaping and rendering for the deterministic tell citations.
 *
 * Pure, and deliberately free of both the Anthropic client and the Temporal
 * client: three surfaces read it — the `tell_citations` activity, the report
 * renderer, and `steward tells` — and only one of them runs inside a workflow.
 * A shared leaf module is what keeps `steward tells` a command that needs no API
 * key, exactly as `lib/tells.ts` stays out of `activities/editorial.ts` for the
 * same reason.
 *
 * **Counts and densities, never a composite.** The one thing this module will
 * not do is add the categories together into a score. That is the number spec
 * §9.2 found to be substantially a length measurement (r = 0.813 against word
 * count), and it stays behind `--ai-tells` with the warning attached to it. A
 * per-category count beside a per-100-words density says what was measured, in
 * units the author can check against the cited lines in seconds.
 */

export interface TellCitationGroup {
  category: TellCategory;
  count: number;
  /** Every cited line, in file order, with repeats kept — two em dashes on one line are two hits. */
  lines: number[];
  /** Hits per 100 body words, or `null` when the body has no words to divide by. */
  per100: number | null;
}

/**
 * Body words only — frontmatter is metadata, not prose.
 *
 * The same denominator `lib/stats.ts` uses, and for the same reason: counting
 * `description:` and `tags:` inflates a short changelog entry far more than a
 * long post, which is the exact distortion a density is supposed to remove.
 */
export function bodyWordCount(text: string): number {
  return matter(text).content.split(/\s+/).filter(Boolean).length;
}

/** Two decimal places, or `null` when there is nothing to divide by. */
export function per100(count: number, words: number): number | null {
  if (!words || words <= 0) return null;
  return Number(((count / words) * 100).toFixed(2));
}

/**
 * The one place a citation's `Finding.message` is composed, so the renderer that
 * has to take it apart again can do so against a stated contract rather than a
 * guessed one. `Finding` carries no category field — adding one for a single
 * pass would change the archived shape of every finding in the corpus — so the
 * category rides in the message and `categoryOfMessage` reads it back.
 */
export function citationMessage(category: TellCategory, message: string): string {
  return `${category}: ${message}`;
}

const BY_NAME = new Map<string, TellCategory>(TELL_CATEGORIES.map((c) => [c, c]));

/** The inverse of `citationMessage`. Null for anything that is not a tell citation. */
export function categoryOfMessage(message: string): TellCategory | null {
  return BY_NAME.get(message.split(':')[0].trim()) ?? null;
}

function toGroups(byCategory: Map<TellCategory, number[]>, words: number): TellCitationGroup[] {
  return [...byCategory]
    .map(([category, lines]) => ({
      category,
      count: lines.length,
      lines: [...lines].sort((a, b) => a - b),
      per100: per100(lines.length, words),
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Groups raw counter output by category, commonest first, ties broken by name. */
export function groupTellCitations(
  findings: DeterministicTellFinding[],
  words: number,
): TellCitationGroup[] {
  const byCategory = new Map<TellCategory, number[]>();
  for (const f of findings) {
    if (!byCategory.has(f.category)) byCategory.set(f.category, []);
    byCategory.get(f.category)!.push(f.line);
  }
  return toGroups(byCategory, words);
}

/**
 * The same grouping, recovered from an archived report's findings.
 *
 * The report renderer only ever has `Finding`s, never the counter output they
 * were built from, so this is how a report read back off disk months later still
 * renders as counts and densities rather than as a wall of individual lines.
 */
export function groupArchivedCitations(
  findings: { message: string; line?: number }[],
  words: number,
): TellCitationGroup[] {
  const byCategory = new Map<TellCategory, number[]>();
  for (const f of findings) {
    const category = categoryOfMessage(f.message);
    if (!category || typeof f.line !== 'number') continue;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(f.line);
  }
  return toGroups(byCategory, words);
}

/** `  5   0.32/100w  EM_DASH_DENSITY  lines 51, 55, 77, 90, 127` */
export function formatTellGroup(group: TellCitationGroup): string {
  const density = group.per100 === null ? '—' : group.per100.toFixed(2);
  return (
    `${String(group.count).padStart(3)}  ${density.padStart(5)}/100w  ${group.category.padEnd(18)}` +
    `  lines ${group.lines.join(', ')}`
  );
}
