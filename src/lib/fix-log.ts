import { getCollection, type CollectionEntry } from 'astro:content';

/**
 * The fix log's shared pieces: its name and path, the order of its entries, and how a
 * page shows a time. The name may change, so every page reads it from here.
 */
export const FIX_LOG = {
  name: 'Fix log',
  path: '/fix-log/',
  description: 'Problems on this site that its agents found, and the fixes they made, each with a before and an after.',
} as const;

export type Fix = CollectionEntry<'fixes'>;

export const fixUrl = (fix: Fix) => `${FIX_LOG.path}${fix.data.slug}/`;
export const prUrl = (number: number) => `https://github.com/mattpyle/mattpyle.com-website/pull/${number}`;

export const TYPE_LABEL: Record<Fix['data']['type'], string> = {
  seo: 'search',
  'agent-readiness': 'agent readiness',
  content: 'content',
  ux: 'usability',
  accessibility: 'accessibility',
  feature: 'feature',
};

/**
 * Newest first by `verified`, the date a page shows, so the order and the date a reader
 * sees are the same field. The finding's key number breaks a tie.
 */
export function compareFixes(a: Fix, b: Fix): number {
  const byTime = b.data.verified.getTime() - a.data.verified.getTime();
  if (byTime !== 0) return byTime;
  return Number(b.data.key.slice(3)) - Number(a.data.key.slice(3));
}

export async function getFixesNewest(): Promise<Fix[]> {
  return (await getCollection('fixes')).sort(compareFixes);
}

const ZONE = 'America/Vancouver';

/** `11 Nov 2026`, the site's date format, read in Matt's zone. */
export function fixDate(date: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: 'short', year: 'numeric', timeZone: ZONE })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${p.day} ${p.month} ${p.year}`;
}

/** The calendar year of a time in Matt's zone, for grouping the index. */
export const fixYear = (date: Date): string => fixDate(date).slice(-4);
