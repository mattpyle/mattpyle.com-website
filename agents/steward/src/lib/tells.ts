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

// ---------------------------------------------------------------------------
// Deterministic counters (spec §9.2 amendment, design rule 9 / "the promotion
// path"): "anything mechanically computable must be computed in code and
// handed to the model as input, never asked of the model."
//
// Before this, EVERY tell — including EM_DASH_DENSITY, which the rubric
// describes with a literal arithmetic threshold ("count per 100 words; flag
// > 1.5") — was counted by asking the LLM to count it itself. The validation
// study found a 0% detection rate for EM_DASH_DENSITY against 6 true
// positives, and zero variance on UNIFORM_RHYTHM and HEDGED_SYMMETRY. That
// was never a broken regex: there was no regex. It was the model
// undercounting its own rubric instructions.
//
// Five of the eight tells have a structural definition precise enough to
// count in code: EM_DASH_DENSITY, STOCK_TRANSITIONS, RULE_OF_THREE,
// LIST_INFLATION, UNIFORM_RHYTHM. The remaining three — NOT_X_BUT_Y,
// ZINGER_BOLDING, HEDGED_SYMMETRY — are judgments about rhetorical intent
// ("used as an applause line", "where the post doesn't actually need
// balance") that code cannot decide, and stay with the LLM rubric.
// ---------------------------------------------------------------------------

/** Tells now counted deterministically in this file, never asked of the model. */
export const DETERMINISTIC_TELLS: readonly TellCategory[] = [
  'EM_DASH_DENSITY',
  'STOCK_TRANSITIONS',
  'RULE_OF_THREE',
  'LIST_INFLATION',
  'UNIFORM_RHYTHM',
];

/** Tells that remain LLM judgment calls — the rubric only asks about these. */
export const LLM_JUDGED_TELLS: readonly TellCategory[] = [
  'NOT_X_BUT_Y',
  'ZINGER_BOLDING',
  'HEDGED_SYMMETRY',
];

/**
 * Same shape as the report's `Finding`, minus `id`/`pass` — those are assigned
 * by the caller, which also owns id-numbering across the deterministic and
 * LLM-judged findings together.
 */
export interface DeterministicTellFinding {
  category: TellCategory;
  line: number;
  excerpt: string;
  message: string;
  evidence: string;
}

const EXCERPT_MAX = 200;

function excerptOf(line: string): string {
  return line.trim().slice(0, EXCERPT_MAX);
}

/**
 * Blanks the YAML frontmatter block (the run of lines between the file's
 * first `---` and the next `---`), keeping line numbers intact.
 *
 * Frontmatter is metadata, not prose — `date: 2026-07-18` is not a sentence,
 * and `description: "..."` is not a paragraph a rhythm counter should compare
 * against the body. `stats.ts`'s `wordCount` already strips it for the same
 * reason (via `gray-matter`); this does the same job on the raw text these
 * counters scan, without pulling in a YAML parser for a fixed two-delimiter
 * block.
 */
function maskFrontmatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== '---') return lines;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return lines;
  return lines.map((l, i) => (i <= end ? '' : l));
}

/**
 * Blanks out fenced code blocks (keeping line numbers intact) so a code
 * sample's `--` or a comment reading "moreover" cannot be counted as prose.
 */
function maskCodeFences(lines: string[]): string[] {
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

/**
 * Every counter below scans this masked text but cites the *original* line
 * for the excerpt, since the masking exists only to suppress false
 * positives, not to change what a citation shows.
 */
function preparedLines(text: string): string[] {
  return maskCodeFences(maskFrontmatter(text.split('\n')));
}

/**
 * EM_DASH_DENSITY: one finding per em-dash character.
 *
 * Matches U+2014 (—) only. A double-hyphen (`--`) is a distinct, deliberate
 * ASCII substitution some writers use instead of a real em dash, and an en
 * dash (–, U+2013) is a different character with a different job (ranges,
 * "10–12") — conflating either with this tell would count a habit the rubric
 * never described. `summariseTells` turns this raw count into the >1.5-per-
 * 100-words density the rubric's own threshold names.
 */
export function findEmDashDensity(text: string): DeterministicTellFinding[] {
  const original = text.split('\n');
  const findings: DeterministicTellFinding[] = [];
  preparedLines(text).forEach((masked, i) => {
    const hits = masked.match(/—/g);
    if (!hits) return;
    for (let k = 0; k < hits.length; k++) {
      findings.push({
        category: 'EM_DASH_DENSITY',
        line: i + 1,
        excerpt: excerptOf(original[i]),
        message: 'em dash (—)',
        evidence: 'Mechanically counted: an em dash character on this line.',
      });
    }
  });
  return findings;
}

/** The rubric's own phrase list, verbatim. Extend here if the rubric text changes. */
const STOCK_TRANSITION_PATTERNS: RegExp[] = [
  /\bmoreover\b/i,
  /\bfurthermore\b/i,
  /\bin today'?s\s+(?:[\w-]+\s+)?landscape\b/i,
  /\blet'?s\s+dive\s+in\b/i,
  /\bthe result\?/i,
];

/** STOCK_TRANSITIONS: one finding per matched phrase per line. */
export function findStockTransitions(text: string): DeterministicTellFinding[] {
  const original = text.split('\n');
  const findings: DeterministicTellFinding[] = [];
  preparedLines(text).forEach((masked, i) => {
    for (const pattern of STOCK_TRANSITION_PATTERNS) {
      if (pattern.test(masked)) {
        findings.push({
          category: 'STOCK_TRANSITIONS',
          line: i + 1,
          excerpt: excerptOf(original[i]),
          message: 'stock transition phrase',
          evidence: `Mechanically matched against the rubric's known phrase list (${pattern.source}).`,
        });
      }
    }
  });
  return findings;
}

/**
 * RULE_OF_THREE: an explicit "x, y, and z" (or Oxford-comma-less "x, y and
 * z") triad — at least one comma before "and" joins the final item, which
 * rules out plain two-item "x and y" lists.
 *
 * This is a structural proxy, not the rubric's full definition. The rubric
 * also asks whether the triad is "used rhythmically rather than
 * informatively" — that is a judgment about intent no regex can make, so this
 * counts every explicit triad and leaves the rhythm-vs-information call
 * unmade. Documented here rather than silently narrowed.
 */
const RULE_OF_THREE_PATTERN = /[^,.!?\n]+,\s*[^,.!?\n]+?,?\s+and\s+[^,.!?\n]+/gi;

export function findRuleOfThree(text: string): DeterministicTellFinding[] {
  const original = text.split('\n');
  const findings: DeterministicTellFinding[] = [];
  preparedLines(text).forEach((masked, i) => {
    const matches = masked.match(RULE_OF_THREE_PATTERN);
    if (!matches) return;
    for (const m of matches) {
      findings.push({
        category: 'RULE_OF_THREE',
        line: i + 1,
        excerpt: excerptOf(m),
        message: 'triadic "x, y, and z" construction',
        evidence: 'Mechanically matched: at least one comma-joined item before "and" closes the list.',
      });
    }
  });
  return findings;
}

/**
 * LIST_INFLATION: a bulleted (`-`/`*`) list item long enough (>=8 words) and
 * punctuated (ends `.`/`!`/`?`) to read as a full sentence rather than a
 * label.
 *
 * The rubric's other clause — "lists restating the preceding paragraph" — is
 * a semantic comparison against surrounding prose, which is a judgment call,
 * not a structural one. This counter does not attempt it; it catches the
 * full-sentence-bullet half of the definition only.
 */
const LIST_ITEM_PATTERN = /^\s*(?:[-*]|\d+\.)\s+(.+)$/;
const LIST_INFLATION_MIN_WORDS = 8;

export function findListInflation(text: string): DeterministicTellFinding[] {
  const original = text.split('\n');
  const findings: DeterministicTellFinding[] = [];
  preparedLines(text).forEach((masked, i) => {
    const match = LIST_ITEM_PATTERN.exec(masked);
    if (!match) return;
    const item = match[1].trim();
    const words = item.split(/\s+/).filter(Boolean).length;
    if (words >= LIST_INFLATION_MIN_WORDS && /[.!?]$/.test(item)) {
      findings.push({
        category: 'LIST_INFLATION',
        line: i + 1,
        excerpt: excerptOf(original[i]),
        message: 'bulleted list item reads as a full sentence',
        evidence: `Mechanically counted: ${words} words ending in sentence punctuation, inside a list item.`,
      });
    }
  });
  return findings;
}

interface Paragraph {
  startLine: number;
  text: string;
  words: number;
  sentences: number;
}

/**
 * Groups prose into paragraphs for `findUniformRhythm`: a paragraph is a run
 * of consecutive non-blank, non-structural lines, ended by a blank line or a
 * structural one (heading, list item, blockquote, a fenced block — already
 * masked).
 *
 * **Deliberately not "one line = one paragraph."** That looked right against
 * `src/content/writing/hello-world.md`, whose paragraphs happen to be
 * unwrapped single lines — but `tests/fixtures/posts/known-good.md` is
 * hard-wrapped (one paragraph spans three source lines), and treating each
 * wrapped line as its own paragraph fragmented real prose into near-identical
 * chunks purely because they share a wrap width, firing UNIFORM_RHYTHM on a
 * fixture whose whole point is to produce zero findings from every pass. A
 * blank-line-delimited paragraph is correct regardless of wrap style; joining
 * wrapped lines with a space before measuring is what fixed it.
 */
function paragraphsOf(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let buffer: string[] = [];
  let startLine = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ');
    paragraphs.push({
      startLine,
      text: joined,
      words: joined.split(/\s+/).filter(Boolean).length,
      sentences: joined.match(/[.!?]+(?=\s|$)/g)?.length || 1,
    });
    buffer = [];
  };

  preparedLines(text).forEach((line, i) => {
    const trimmed = line.trim();
    const isStructural = /^\s*(#{1,6}\s|[-*]\s|\d+\.\s|>)/.test(line);
    if (!trimmed || isStructural) {
      flush();
      return;
    }
    if (buffer.length === 0) startLine = i + 1;
    buffer.push(trimmed);
  });
  flush();

  return paragraphs;
}

/** Two paragraphs read as "the same shape" within a tolerant word-count and sentence-count band. */
function sameShape(a: Paragraph, b: Paragraph): boolean {
  const wordTolerance = Math.max(3, Math.round(Math.max(a.words, b.words) * 0.2));
  return Math.abs(a.words - b.words) <= wordTolerance && Math.abs(a.sentences - b.sentences) <= 1;
}

const UNIFORM_RHYTHM_MIN_RUN = 3;
const UNIFORM_RHYTHM_MIN_WORDS = 5;

/**
 * UNIFORM_RHYTHM: a run of 3+ consecutive prose paragraphs whose word count
 * and sentence count stay within a tolerant band of each other. One finding
 * per qualifying run (not per paragraph), cited at the run's first paragraph.
 *
 * Paragraphs under `UNIFORM_RHYTHM_MIN_WORDS` words are excluded — a run of
 * short fragments (e.g. consecutive one-line asides) is not the "uniform
 * paragraph rhythm" the rubric describes.
 */
export function findUniformRhythm(text: string): DeterministicTellFinding[] {
  const paras = paragraphsOf(text).filter((p) => p.words >= UNIFORM_RHYTHM_MIN_WORDS);
  const findings: DeterministicTellFinding[] = [];
  let runStart = 0;

  for (let i = 1; i <= paras.length; i++) {
    const continuesRun = i < paras.length && sameShape(paras[i], paras[i - 1]);
    if (continuesRun) continue;

    const runLength = i - runStart;
    if (runLength >= UNIFORM_RHYTHM_MIN_RUN) {
      const first = paras[runStart];
      findings.push({
        category: 'UNIFORM_RHYTHM',
        line: first.startLine,
        excerpt: excerptOf(first.text),
        message: `${runLength} consecutive paragraphs of near-identical length and sentence count`,
        evidence: `Mechanically detected: paragraphs starting at line ${first.startLine} run ${runLength} deep within a tolerant word-count and sentence-count band of each other.`,
      });
    }
    runStart = i;
  }

  return findings;
}

/** All five deterministic tells, run over one file's raw text. */
export function computeDeterministicTells(text: string): DeterministicTellFinding[] {
  return [
    ...findEmDashDensity(text),
    ...findStockTransitions(text),
    ...findRuleOfThree(text),
    ...findListInflation(text),
    ...findUniformRhythm(text),
  ];
}
