import fs from 'node:fs/promises';
import path from 'node:path';
import { COLLECTIONS, SITE_DIR, postRelPath, type Collection } from '../config.js';
import { loadAll, readPieceMeta } from './study.js';
import { AMBER, CYAN, DIM, GREEN, paint } from './render-report.js';
import { computeDeterministicTells, DETERMINISTIC_TELLS, LLM_JUDGED_TELLS } from './tells.js';

/**
 * `DETERMINISTIC_TELLS` is typed `readonly TellCategory[]`, so indexing it
 * with `[number]` widens back to the full 8-category union rather than the
 * 5-member subset it actually holds at runtime. This alias names that subset
 * explicitly — matching `lib/tells.ts`'s own `DETERMINISTIC_TELLS` array
 * literal — so `Record<DeterministicTellCategory, ...>` below is checked
 * against exactly the 5 keys this module ever produces.
 */
type DeterministicTellCategory =
  | 'EM_DASH_DENSITY'
  | 'STOCK_TRANSITIONS'
  | 'RULE_OF_THREE'
  | 'LIST_INFLATION'
  | 'UNIFORM_RHYTHM';

/** `DETERMINISTIC_TELLS` narrowed to the alias above, for indexing `Record<DeterministicTellCategory, ...>`. */
const DETERMINISTIC_TELL_LIST = DETERMINISTIC_TELLS as readonly DeterministicTellCategory[];

/**
 * The free, deterministic corpus scan (spec §9.2 amendment 2026-07-21 (7)).
 *
 * Everything in this file runs the pure counters from `lib/tells.ts` directly
 * against the content tree on disk. **No LLM call, no Anthropic client
 * import, no `reviews/_study/` write.** `steward score`/`steward study` both
 * read or write archived rubric responses; this reads only markdown files and
 * (read-only) the existing study archive for provenance labels already on
 * record. It is safe to run as often as wanted, at zero cost.
 */

/** Same fixture-exclusion rule as `stats.ts` / README rule 4: fixtures are planted defects, not writing. */
const FIXTURE = /smoke-test|fixture/;

export interface CorpusScanRow {
  collection: Collection;
  slug: string;
  /**
   * From the existing `reviews/_study/` archive when a piece has one (the
   * corrected labels — spec §9.2, 2026-07-21 (5)). `'unlabelled'` for a
   * corpus file that has never been through `steward score`; the scan still
   * counts it; it just has no known ground truth to group by.
   */
  provenance: string;
  words: number;
  tellCounts: Record<DeterministicTellCategory, number>;
  /** Null only when `words` is 0 — an unnormalisable file, not a missing measurement. */
  tellsPer100: Record<DeterministicTellCategory, number> | null;
}

/** Every real (non-fixture) slug in a collection, read straight off disk. */
async function collectionSlugs(collection: Collection): Promise<string[]> {
  const dir = path.join(SITE_DIR, 'src', 'content', collection);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((slug) => !FIXTURE.test(slug));
}

/**
 * Scans every real writing + changelog file for the 5 deterministic tells.
 * Zero API calls: `computeDeterministicTells` is a pure function over the
 * file's own text, and the only other I/O is reading markdown off disk plus
 * one read of the already-archived study provenance labels.
 */
export async function scanCorpusDeterministic(): Promise<CorpusScanRow[]> {
  // Provenance ground truth already lives in reviews/_study/ (assigned by
  // Matt via `--provenance` at score time, corrected 2026-07-21 (5)). Read
  // once and matched by collection+slug — reading it is not scoring it.
  const studyPieces = await loadAll();
  const provenanceOf = new Map<string, string>();
  for (const p of studyPieces) provenanceOf.set(`${p.collection}/${p.slug}`, p.provenance);

  const rows: CorpusScanRow[] = [];
  for (const collection of COLLECTIONS) {
    const slugs = await collectionSlugs(collection);
    for (const slug of slugs) {
      const file = postRelPath(slug, collection);
      const text = await fs.readFile(path.join(SITE_DIR, file), 'utf8');
      const { words } = await readPieceMeta(collection, slug);

      const tellCounts = Object.fromEntries(DETERMINISTIC_TELL_LIST.map((c) => [c, 0])) as Record<
        DeterministicTellCategory,
        number
      >;
      // `computeDeterministicTells` only ever tags a finding with one of the 5
      // deterministic categories (it does not run the 3 LLM-judged counters,
      // which don't exist as functions), but its return type carries the full
      // `TellCategory` union because it shares `DeterministicTellFinding`
      // with the rest of `lib/tells.ts`.
      for (const f of computeDeterministicTells(text)) {
        tellCounts[f.category as DeterministicTellCategory] += 1;
      }

      const tellsPer100 =
        words > 0
          ? (Object.fromEntries(
              DETERMINISTIC_TELL_LIST.map((c) => [c, Number(((tellCounts[c] / words) * 100).toFixed(3))]),
            ) as Record<DeterministicTellCategory, number>)
          : null;

      rows.push({
        collection,
        slug,
        provenance: provenanceOf.get(`${collection}/${slug}`) ?? 'unlabelled',
        words,
        tellCounts,
        tellsPer100,
      });
    }
  }

  return rows;
}

const PROVENANCE_ORDER = ['human', 'mixed', 'ai'];
const PROVENANCE_COLOR: Record<string, string> = { human: GREEN, mixed: CYAN, ai: AMBER };

/** Same grouping shape as `study.ts`'s `groupByProvenance`, kept local to avoid a circular import. */
export function groupByProvenance(rows: CorpusScanRow[]): Map<string, CorpusScanRow[]> {
  const groups = new Map<string, CorpusScanRow[]>();
  for (const row of rows) {
    if (!groups.has(row.provenance)) groups.set(row.provenance, []);
    groups.get(row.provenance)!.push(row);
  }
  const known = PROVENANCE_ORDER.filter((p) => groups.has(p));
  const rest = [...groups.keys()].filter((p) => !PROVENANCE_ORDER.includes(p)).sort();
  const ordered = new Map<string, CorpusScanRow[]>();
  for (const key of [...known, ...rest]) ordered.set(key, groups.get(key)!);
  return ordered;
}

/** Short column headers — mirrors `study.ts`'s `TELL_ABBR`, restricted to the 5 deterministic tells. */
export const DETERMINISTIC_TELL_ABBR: Record<DeterministicTellCategory, string> = {
  EM_DASH_DENSITY: 'EMD',
  STOCK_TRANSITIONS: 'STK',
  RULE_OF_THREE: 'R3',
  LIST_INFLATION: 'LST',
  UNIFORM_RHYTHM: 'UNI',
};

function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * Pure text render: one section per provenance group, one row per piece, one
 * column per deterministic tell (per 100 words). The three LLM-judged tells
 * are named explicitly as not measured here, rather than omitted silently —
 * a reader comparing this table against `study`'s should not have to guess
 * why 3 of 8 categories are missing.
 */
export function renderCorpusScan(rows: CorpusScanRow[]): string {
  const lines: string[] = [];
  const groups = groupByProvenance(rows);

  const header =
    `  ${'piece'.padEnd(35)}  ${'coll'.padEnd(9)}  ${'words'.padStart(5)}  ` +
    DETERMINISTIC_TELL_LIST.map((c) => DETERMINISTIC_TELL_ABBR[c].padStart(6)).join(' ');

  lines.push('');
  lines.push(
    paint(
      '  === Free deterministic scan: 5 tells / 100 words, NO API call, grouped by provenance ===',
      DIM,
    ),
  );
  lines.push('');
  lines.push(paint(header, DIM));

  for (const [provenance, groupRows] of groups) {
    const color = PROVENANCE_COLOR[provenance] ?? DIM;
    lines.push('');
    lines.push(paint(`  -- ${provenance.toUpperCase()} (n=${groupRows.length}) --`, color));
    for (const row of groupRows) {
      const cells = DETERMINISTIC_TELL_LIST.map((c) =>
        row.tellsPer100 ? fmt(row.tellsPer100[c]).padStart(6) : '   n/a',
      );
      lines.push(
        `  ${row.slug.slice(0, 35).padEnd(35)}  ${row.collection.padEnd(9)}  ` +
          `${String(row.words).padStart(5)}  ` +
          cells.join(' '),
      );
    }
  }

  lines.push('');
  lines.push(
    paint(
      `  LLM-only — not measured here: ${LLM_JUDGED_TELLS.join(', ')}.`,
      DIM,
    ),
  );
  lines.push(
    paint('  Zero Anthropic API calls made. Densities only (per 100 words), never raw counts.', DIM),
  );
  return lines.join('\n');
}
