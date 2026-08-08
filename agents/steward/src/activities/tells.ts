import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE_DIR } from '../config.js';
import type { Finding, PassResult } from '../lib/report.js';
import { timed } from '../lib/logger.js';
import { computeDeterministicTells, TELL_CATEGORIES, type TellCategory } from '../lib/tells.js';
import { bodyWordCount, citationMessage, groupTellCitations } from '../lib/tell-citations.js';

/**
 * `tellCitations(file)` — the deterministic half of the ai-tells taxonomy, run
 * on every review and audit with no flag (spec §8.6b).
 *
 * **Why this is its own activity rather than a branch of `editorialPass`.** The
 * two halves differ in everything that matters operationally: this one makes no
 * network call, needs no API key, cannot fail on a model's bad JSON, and costs
 * nothing, so it can run unconditionally. The LLM half pays for a rubric call
 * and carries `aiLikenessScore`, the composite that failed its validation study
 * (spec §9.2) and stays behind `--ai-tells`. Splitting them at the activity
 * boundary is what lets the free, auditable half be free.
 *
 * **Findings are `pass` severity — informational, not defects.** Every tell here
 * is a statement about style, and style is the author's call (design rule 1).
 * A `flag` would put every post containing a triad or an em dash into `overall:
 * flag`, which is both wrong on the merits and the fastest way to teach the
 * reader that the verdict means nothing. The citations answer "where is the
 * machine voice", never "fix this before publishing".
 */
export async function tellCitations(file: string): Promise<PassResult> {
  const { result, startedAt, durationMs } = await timed('tellCitations', async () => {
    const text = await fs.readFile(path.join(SITE_DIR, file), 'utf8');
    const raw = computeDeterministicTells(text);
    const words = bodyWordCount(text);

    const findings: Finding[] = raw.map((f, i) => ({
      id: `tell-${i + 1}`,
      pass: 'tell_citations' as const,
      severity: 'pass' as const,
      // Composed through `citationMessage` so the renderer can read the category
      // back out of an archived finding against a stated contract.
      message: citationMessage(f.category, f.message),
      file,
      line: f.line,
      excerpt: f.excerpt.slice(0, 200),
      evidence: f.evidence,
    }));

    // Seeded at zero for every category the counters cover, for the same reason
    // `mapAiTellsResponse` seeds its own: a tell that did not fire is a real
    // measurement of zero, and an absent key is a different thing entirely to
    // anything doing arithmetic over the archive later.
    const tellCounts = Object.fromEntries(TELL_CATEGORIES.map((c) => [c, 0])) as Record<
      TellCategory,
      number
    >;
    for (const f of raw) tellCounts[f.category] += 1;

    return { findings, tellCounts, words, groups: groupTellCitations(raw, words) };
  });

  return {
    pass: 'tell_citations',
    // Always `pass`: the findings are informational by construction (see above),
    // so `worstVerdict` over them would return `pass` anyway. Stated as a literal
    // so the invariant is visible here rather than inferred from the severities.
    verdict: 'pass',
    findings: result.findings,
    // Never a patch, and not by clamping: none is constructed anywhere here.
    // Citations inform; the author decides.
    patches: [],
    startedAt,
    durationMs,
    metrics: {
      // Counts and per-100-word densities, archived so the corpus accumulates
      // for the re-validation this pass exists to unblock. No composite: see the
      // docblock in `lib/tell-citations.ts`.
      tellCounts: result.tellCounts,
      words: result.words,
      densities: Object.fromEntries(result.groups.map((g) => [g.category, g.per100])),
    },
  };
}
