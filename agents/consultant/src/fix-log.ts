/**
 * The search over mattpyle.com's published fix log: the table that says which entries belong to an
 * audit check, the parser of `/fix-log.md`, and the matcher. Pure, and the only producer of a
 * `FixLogView`.
 *
 * The fix log carries no check id on an entry, so a check finds its entries by text: a phrase that
 * must appear in an entry's title or lead, and only a phrase in the title makes the entry `named`. Word overlap alone was tried and matched `agents.md`
 * entries to `robots-ai-agents`, so every phrase here is written out.
 *
 * What reaches the model from the page: a title and a lead, flattened and cut, and an address this
 * file builds from a fixed origin and a slug that fits `FIX_LOG_SLUG`. No other link on the page
 * is copied.
 */
import {
  CHECK_ID,
  FIX_LOG_MAX_CHECKS,
  FIX_LOG_MAX_ENTRIES,
  FIX_LOG_MAX_TEXT,
  FIX_LOG_ORIGIN,
  FIX_LOG_SLUG,
  FixLogView,
} from './tools.js';

/** The type labels the fix log prints after a lead, as the page spells them. */
export const FIX_TYPES = ['agent readiness', 'accessibility', 'content', 'search', 'usability', 'feature'] as const;
export type FixType = (typeof FIX_TYPES)[number];

export interface FixEntry {
  title: string;
  url: string;
  lead: string;
  type: FixType | null;
}

interface CheckRow {
  /** The audit check ids this row answers for. */
  checks: readonly string[];
  /**
   * An entry whose title holds one of these names the thing the check tests. In the lead alone, the
   * same phrase makes the entry related: a lead often names a file in passing.
   */
  named?: readonly string[];
  /** An entry whose title or lead holds one of these is about the same area, and no closer. */
  related?: readonly string[];
  /** Every entry of this type counts as related. */
  relatedType?: FixType;
}

/**
 * Which fix-log entries answer for which audit check. Plain data, and the only place to change.
 *
 * To add a row: list the check ids as the audit reports them, then the phrases. A phrase matches
 * whole, without regard to case, and never inside a longer word, so `MCP` does not match `WebMCP`.
 * Put a phrase under `named` only when an entry with it in its title is about the thing the check
 * tests; anything looser goes under `related`. A check with nothing in the log gets a row with no phrases,
 * so that it returns no entries on purpose. An id with no row at all matches only an entry that
 * holds every word of the id.
 */
export const CHECK_TABLE: readonly CheckRow[] = [
  { checks: ['llms-txt', 'llms-txt-links', 'llms-txt-list-items'], named: ['llms.txt'], related: ['llms-full.txt'] },
  { checks: ['agents-md'], named: ['agents.md'] },
  { checks: ['a2a-agent-card'], named: ['agent card'], related: ['A2A'] },
  { checks: ['well-known-mcp-server'], named: ['MCP document', 'MCP server card'], related: ['MCP'] },
  {
    checks: ['markdown-negotiation-home', 'markdown-negotiation-content'],
    named: ['markdown negotiation', 'text/markdown'],
    related: ['markdown'],
  },
  { checks: ['link-headers'], named: ['link header'] },
  { checks: ['sitemap'], named: ['sitemap'] },
  { checks: ['robots-txt', 'robots-ai-agents'], named: ['robots.txt'], related: ['robots'] },
  { checks: ['content-signals'], named: ['content signal', 'content signals', 'content-signal'] },
  { checks: ['axe-violations', 'lighthouse-accessibility'], relatedType: 'accessibility' },
  { checks: ['lighthouse-seo'], relatedType: 'search' },
  // Nothing in the log is about these. Their words are common, or match an entry about something
  // else: the one reading-budget entry is about a citation in a changelog entry.
  {
    checks: [
      'fetch',
      'assembly',
      'lighthouse-performance',
      'lighthouse-best-practices',
      'lighthouse-agentic-browsing',
      'reading-budget-home',
      'reading-budget-content',
      'reading-budget-page',
    ],
  },
];

/** One line of published text: control characters and runs of space flattened, then cut. */
function line(v: string): string {
  return v
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FIX_LOG_MAX_TEXT);
}

const HEADING = /^### \[(.+)\]\(\/fix-log\/([^/()\s]+)\/\)\s*$/;

/**
 * Read the entries out of the published `/fix-log.md`, in the page's own order, newest first.
 * An entry is a third-level heading that links to `/fix-log/<slug>/`, and the next line of text is
 * its lead, which the page ends with the entry's type. An entry whose slug does not fit
 * `FIX_LOG_SLUG`, or that has no title, is dropped. A page that is not the fix log yields nothing.
 */
export function parseFixLog(markdown: unknown): FixEntry[] {
  if (typeof markdown !== 'string') return [];
  const lines = markdown.split(/\r?\n/);
  const entries: FixEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const heading = HEADING.exec(lines[i]!);
    if (!heading) continue;
    const title = line(heading[1]!);
    const slug = heading[2]!;
    if (!title || !FIX_LOG_SLUG.test(slug) || seen.has(slug)) continue;
    seen.add(slug);

    let next = '';
    for (let j = i + 1; j < lines.length && j <= i + 3; j += 1) {
      const candidate = lines[j]!.trim();
      if (!candidate) continue;
      // Another heading, or a line that is only a link, is not a lead.
      if (!candidate.startsWith('#') && !candidate.startsWith('[')) next = candidate;
      break;
    }
    let type: FixType | null = null;
    for (const label of FIX_TYPES) {
      if (next.toLowerCase().endsWith(` ${label}`)) {
        type = label;
        next = next.slice(0, -label.length - 1);
        break;
      }
    }
    entries.push({ title, url: `${FIX_LOG_ORIGIN}/fix-log/${slug}/`, lead: line(next), type });
  }
  return entries;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `text` holds `phrase` whole: any case, and not inside a longer word. */
function holds(text: string, phrase: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escape(phrase)}(?![a-z0-9])`, 'i').test(text);
}

type Match = 'named' | 'related';

function matchOf(entry: FixEntry, check: string): Match | null {
  const text = `${entry.title}\n${entry.lead}`;
  const row = CHECK_TABLE.find((r) => r.checks.includes(check));
  if (!row) {
    // No row: only an entry that holds every word of the id, and then no closer than related.
    const words = check.split('-').filter(Boolean);
    return words.length > 0 && words.every((w) => holds(text, w)) ? 'related' : null;
  }
  if (row.named?.some((p) => holds(entry.title, p))) return 'named';
  if (row.named?.some((p) => holds(entry.lead, p))) return 'related';
  if (row.related?.some((p) => holds(text, p))) return 'related';
  if (row.relatedType && entry.type === row.relatedType) return 'related';
  return null;
}

/** The check ids a caller may search for: trimmed, lower-cased, deduplicated, and capped. */
export function cleanChecks(checks: readonly unknown[]): string[] {
  const ids = checks.flatMap((c) => (typeof c === 'string' ? [c.trim().toLowerCase()] : []));
  return [...new Set(ids.filter((id) => CHECK_ID.test(id)))].slice(0, FIX_LOG_MAX_CHECKS);
}

/**
 * The entries for each check: the named ones first, then the related ones, each group in the
 * log's own order, and at most `FIX_LOG_MAX_ENTRIES` a check. A check with no entry keeps its row,
 * with an empty list, so the model can say there is none. Throws only if the result fails its own
 * schema, which would be a bug here.
 */
export function searchFixLog(entries: readonly FixEntry[], checks: readonly unknown[]): FixLogView {
  const results = cleanChecks(checks).map((check) => {
    const matched = entries.flatMap((entry) => {
      const match = matchOf(entry, check);
      return match ? [{ title: entry.title, url: entry.url, lead: entry.lead, match }] : [];
    });
    const ordered = [...matched.filter((m) => m.match === 'named'), ...matched.filter((m) => m.match === 'related')];
    return { check, matched: ordered.length, entries: ordered.slice(0, FIX_LOG_MAX_ENTRIES) };
  });
  return FixLogView.parse({ status: 'complete', total: entries.length, results });
}
