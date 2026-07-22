import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { REVIEWS_DIR, SITE_DIR, postRelPath } from '../config.js';
import { AMBER, CYAN, DIM, GREEN, paint } from './render-report.js';
import type { Collection } from './report.js';
import { summariseTells, type TellSummary } from './stats.js';
import { TELL_CATEGORIES, type TellCategory } from './tells.js';

/**
 * Storage and aggregation for the ai-tells validation study.
 *
 * **Why the study does not write `latest.json`.** The obvious implementation is
 * "run an audit twice and read the archive". Two things rule it out:
 *
 * 1. `latest.json` holds exactly one report, so a second run overwrites the
 *    first — and the study's whole first hypothesis is about run-to-run noise.
 *    The aggregate would silently become "run 2 only".
 * 2. For `hello-world` the archive belongs to a **live parked review** with 257
 *    events that is load-bearing for the publish finale. The study must not be
 *    able to touch it, and the cheapest way to guarantee that is to never write
 *    to that path at all.
 *
 * **Why every piece goes through this same path, including the published ones.**
 * A workflow-ID collision means `hello-world` cannot be audited through a
 * workflow while its review is parked. Scoring the draft one way and the other
 * eleven pieces another would put a method difference exactly where the corpus
 * is most asymmetric — between the piece whose provenance is best known and
 * everything it is compared against. One method for the whole corpus is worth
 * more than the marginal realism of running eleven of them through the fan-out.
 */

const STUDY_DIR = path.join(REVIEWS_DIR, '_study');

export interface StudyRun {
  run: number;
  aiLikenessScore: number;
  tellCounts: Record<TellCategory, number>;
  durationMs: number;
  rubricSha256: string;
  model: string;
  at: string;
}

export interface StudyPiece {
  collection: Collection;
  slug: string;
  /** `ai` = drafted with heavy AI assistance; `human` = substantially human-edited. */
  provenance: string;
  draft: boolean;
  words: number;
  runs: StudyRun[];
}

function fileFor(collection: Collection, slug: string): string {
  return path.join(STUDY_DIR, `${collection}__${slug}.json`);
}

/**
 * Body word count and draft status, read from the file itself.
 *
 * Body words ONLY — frontmatter is metadata, and counting it inflates a 91-word
 * changelog entry far more than a 1,600-word essay, which is exactly the
 * distortion the per-100-words normalisation exists to remove.
 *
 * `draft` is read here rather than passed in: it is a fact about the file, and
 * the first version of this took it from the previously-saved study record,
 * which meant it was silently always `false` on a first run.
 */
export async function readPieceMeta(
  collection: Collection,
  slug: string,
): Promise<{ words: number; draft: boolean }> {
  const raw = await fs.readFile(path.join(SITE_DIR, postRelPath(slug, collection)), 'utf8');
  const parsed = matter(raw);
  return {
    words: parsed.content.split(/\s+/).filter(Boolean).length,
    draft: parsed.data.draft === true,
  };
}

export async function loadPiece(collection: Collection, slug: string): Promise<StudyPiece | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(collection, slug), 'utf8')) as StudyPiece;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Design rule 11: a study file that exists but will not parse is a bug, not
    // an absence. Returning null would quietly drop a piece from the corpus and
    // change the ranking without saying so.
    throw new Error(`Could not read the study file for ${collection}/${slug}: ${(err as Error).message}`);
  }
}

export async function savePiece(piece: StudyPiece): Promise<string> {
  await fs.mkdir(STUDY_DIR, { recursive: true });
  const target = fileFor(piece.collection, piece.slug);
  await fs.writeFile(target, `${JSON.stringify(piece, null, 2)}\n`, 'utf8');
  return target;
}

export async function loadAll(): Promise<StudyPiece[]> {
  let names: string[];
  try {
    names = await fs.readdir(STUDY_DIR);
  } catch {
    return [];
  }
  const pieces: StudyPiece[] = [];
  for (const n of names.filter((f) => f.endsWith('.json'))) {
    pieces.push(JSON.parse(await fs.readFile(path.join(STUDY_DIR, n), 'utf8')) as StudyPiece);
  }
  return pieces;
}

export interface PieceAnalysis {
  piece: StudyPiece;
  scores: number[];
  meanScore: number;
  /** Absolute gap between the two runs — hypothesis (a), bound +/-10. */
  spread: number;
  /** Hypothesis (a'): a piece over the bound is not rankable. */
  stable: boolean;
  /** Tell counts summed across runs, then averaged per run. */
  meanTellCounts: Record<TellCategory, number>;
  density: TellSummary;
}

export const STABILITY_BOUND = 10;

/**
 * Per-piece analysis. Pure, so the study's arithmetic is testable and so the
 * readout cannot quietly diverge from what was pre-registered.
 *
 * Densities come from `summariseTells` — the same normaliser `steward stats`
 * uses for E-Prime — rather than being recomputed here. The corpus has a ~9x
 * genre gap in length, so a second implementation of "per 100 words" is how a
 * ranking silently becomes a length measurement.
 */
export function analysePiece(piece: StudyPiece): PieceAnalysis {
  const scores = piece.runs.map((r) => r.aiLikenessScore);
  const meanScore = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const spread = scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0;

  const meanTellCounts = Object.fromEntries(
    TELL_CATEGORIES.map((c) => [
      c,
      piece.runs.reduce((acc, r) => acc + (r.tellCounts[c] ?? 0), 0) / (piece.runs.length || 1),
    ]),
  ) as Record<TellCategory, number>;

  return {
    piece,
    scores,
    meanScore: Number(meanScore.toFixed(1)),
    spread,
    stable: spread <= STABILITY_BOUND,
    meanTellCounts,
    density: summariseTells(meanTellCounts, piece.words),
  };
}

/** Rank 1 = highest. Ties share the lower rank number, as in competition ranking. */
export function rankBy<T>(items: T[], score: (t: T) => number): Map<T, number> {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const ranks = new Map<T, number>();
  sorted.forEach((item, i) => {
    if (i > 0 && score(item) === score(sorted[i - 1])) {
      ranks.set(item, ranks.get(sorted[i - 1])!);
    } else {
      ranks.set(item, i + 1);
    }
  });
  return ranks;
}

// --- Human-readable comparison (the ai-tells diagnostic) ---------------------
//
// `steward study`'s hypothesis test (a/b/c above) answers one narrow, aggregate
// question. It doesn't answer the question a person actually opens this tool to
// ask: "does any ONE tell category separate AI-labelled from human-labelled
// writing, and does it fire where I'd expect on the piece I know is mixed?"
// That needs a full per-piece, per-category table, grouped by provenance — not
// a rank or a p-value substitute. Built entirely from already-archived
// `StudyPiece` records (`loadAll`) and the deterministic `summariseTells`
// normaliser `steward stats` already uses; no LLM call.

/** Display order for provenance groups — known-label groups first, everything else after. */
const PROVENANCE_ORDER = ['human', 'mixed', 'ai'];

export interface ComparisonRow {
  collection: Collection;
  slug: string;
  provenance: string;
  words: number;
  /** Mean composite `aiLikenessScore` across runs. Null if the piece has no runs. */
  meanScore: number | null;
  /** Per-tell-category findings per 100 words, mean across runs. Null if `words` is 0. */
  tellsPer100: Record<TellCategory, number> | null;
}

/**
 * One row per scored piece, tell counts normalised per 100 words. Raw counts
 * are never surfaced here — the corpus has a ~9x length gap between a
 * changelog entry and a writing post, and comparing raw counts across that gap
 * is precisely the confound (b) below exists to avoid.
 */
export function buildComparisonRows(pieces: StudyPiece[]): ComparisonRow[] {
  return pieces.map((piece) => {
    const analysis = analysePiece(piece);
    return {
      collection: piece.collection,
      slug: piece.slug,
      provenance: piece.provenance,
      words: piece.words,
      meanScore: analysis.scores.length > 0 ? analysis.meanScore : null,
      tellsPer100: analysis.density.tellsPer100,
    };
  });
}

/**
 * Grouped by provenance label so AI / human / mixed cluster visibly, in a
 * fixed display order (`PROVENANCE_ORDER`) with any other/unknown label
 * (e.g. a piece scored without `--provenance`) appended last, alphabetically.
 */
export function groupByProvenance(rows: ComparisonRow[]): Map<string, ComparisonRow[]> {
  const groups = new Map<string, ComparisonRow[]>();
  for (const row of rows) {
    if (!groups.has(row.provenance)) groups.set(row.provenance, []);
    groups.get(row.provenance)!.push(row);
  }
  const known = PROVENANCE_ORDER.filter((p) => groups.has(p));
  const rest = [...groups.keys()].filter((p) => !PROVENANCE_ORDER.includes(p)).sort();
  const ordered = new Map<string, ComparisonRow[]>();
  for (const key of [...known, ...rest]) ordered.set(key, groups.get(key)!);
  return ordered;
}

/** Short column headers for the eight tell categories — full names don't fit a table row. */
export const TELL_ABBR: Record<TellCategory, string> = {
  NOT_X_BUT_Y: 'NXY',
  ZINGER_BOLDING: 'ZNG',
  RULE_OF_THREE: 'R3',
  EM_DASH_DENSITY: 'EMD',
  UNIFORM_RHYTHM: 'UNI',
  HEDGED_SYMMETRY: 'HDG',
  STOCK_TRANSITIONS: 'STK',
  LIST_INFLATION: 'LST',
};

const PROVENANCE_COLOR: Record<string, string> = { human: GREEN, mixed: CYAN, ai: AMBER };

function fmt(n: number): string {
  return n.toFixed(1);
}

/**
 * Pure text render of the grouped comparison table: one section per
 * provenance label, one row per piece, one column per tell category (per 100
 * words), plus words and composite score. Reuses `render-report.ts`'s colour
 * palette rather than a second ANSI table.
 */
export function renderComparison(rows: ComparisonRow[]): string {
  const lines: string[] = [];
  const groups = groupByProvenance(rows);

  const header =
    `  ${'piece'.padEnd(35)}  ${'coll'.padEnd(9)}  ${'words'.padStart(5)}  ${'score'.padStart(5)}  ` +
    TELL_CATEGORIES.map((c) => TELL_ABBR[c].padStart(5)).join(' ');

  lines.push('');
  lines.push(paint('  === Comparison: per-100-words tell density by piece, grouped by provenance ===', DIM));
  lines.push('');
  lines.push(paint(header, DIM));

  for (const [provenance, groupRows] of groups) {
    const color = PROVENANCE_COLOR[provenance] ?? DIM;
    lines.push('');
    lines.push(paint(`  -- ${provenance.toUpperCase()} (n=${groupRows.length}) --`, color));
    for (const row of groupRows) {
      const tells = row.tellsPer100;
      const cells = TELL_CATEGORIES.map((c) => (tells ? fmt(tells[c]).padStart(5) : '  n/a'));
      lines.push(
        `  ${row.slug.slice(0, 35).padEnd(35)}  ${row.collection.padEnd(9)}  ` +
          `${String(row.words).padStart(5)}  ${(row.meanScore === null ? '—' : String(row.meanScore)).padStart(5)}  ` +
          cells.join(' '),
      );
    }
  }

  lines.push('');
  lines.push(paint('  Densities only — raw counts are never compared across collections (see study.ts).', DIM));
  return lines.join('\n');
}
