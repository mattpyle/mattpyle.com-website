import { z } from 'zod';

/**
 * The ai-tells taxonomy (spec §9.2).
 *
 * **Why this lives in `lib/` and not beside the pass that produces it.** Both
 * the editorial activity and `steward stats` need these names, and stats must
 * not import `activities/editorial.ts` — that module pulls in `lib/llm.ts` and
 * therefore the API client, which would make a command that performs no network
 * calls depend on an API key being present. A shared leaf module is the cheap
 * fix; the alternative is two hand-maintained copies of an enum whose whole job
 * is to be counted consistently across a corpus.
 */

/**
 * The eight tells the rubric scores.
 *
 * **Frozen for the validation study.** The study design fixes one rubric for the
 * whole corpus and forbids tuning between runs, because tuning toward separation
 * is the exact failure mode a validation study exists to detect. Changing this
 * list — or the rubric text it mirrors — invalidates comparison against any
 * scores already collected and requires a new pre-registered run.
 */
export const TellCategory = z.enum([
  'NOT_X_BUT_Y',
  'ZINGER_BOLDING',
  'RULE_OF_THREE',
  'EM_DASH_DENSITY',
  'UNIFORM_RHYTHM',
  'HEDGED_SYMMETRY',
  'STOCK_TRANSITIONS',
  'LIST_INFLATION',
]);
export type TellCategory = z.infer<typeof TellCategory>;

export const TELL_CATEGORIES = TellCategory.options;

/**
 * Tells that fire on the *changelog house format* rather than on voice.
 *
 * Changelog entries are structurally formulaic by design — enum'd frontmatter,
 * a 1–2 sentence summary, short sectioned bodies (see the 3b build-log entry).
 * These three will read high on a changelog entry regardless of who wrote it.
 *
 * Separating them is what lets the analysis ask whether the scorer detects
 * *provenance* or merely *genre*, and it does so **at analysis time, without
 * touching the rubric** — which the study design forbids changing. The scorer is
 * never told about this split.
 */
export const FORMAT_DRIVEN_TELLS: readonly TellCategory[] = [
  'UNIFORM_RHYTHM',
  'RULE_OF_THREE',
  'LIST_INFLATION',
];

/** Tells that are claims about voice rather than about document shape. */
export const VOICE_DRIVEN_TELLS: readonly TellCategory[] = [
  'NOT_X_BUT_Y',
  'STOCK_TRANSITIONS',
  'HEDGED_SYMMETRY',
  'ZINGER_BOLDING',
];

/**
 * `EM_DASH_DENSITY` is deliberately in NEITHER list, and that is a finding
 * rather than an oversight.
 *
 * It is the one tell that is plainly a voice marker *and* plainly this author's
 * long-established habit — the site's published prose and every build log in
 * this project are dense with em dashes, predating the Steward entirely. So it
 * cannot honestly be called format (it is not the changelog template) and it
 * cannot honestly be called AI voice (it is Matt's). Assigning it to either
 * bucket would settle by fiat a question the study is supposed to be asking. It
 * is reported in the per-category breakdown and excluded from both aggregates.
 */
export const UNCLASSIFIED_TELLS: readonly TellCategory[] = ['EM_DASH_DENSITY'];
