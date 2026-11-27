import { findingText } from '../lib/fix-log-fixtures.js';

/**
 * A synthetic findings store for the finding-key tests: two findings with their
 * own short keys and a third sharing `MP-902`.
 */

export const SHORT = 'MP-901';
export const FULL = 'content-about-names-a-removed-section--about';
export const TWINS = ['ux-twin-one--about', 'ux-twin-two--about'];

const DIR = 'sites/mattpyle-com/findings';

/** `key_short` as given, under the full key `slug`. */
function finding(slug: string, keyShort: string): [string, string] {
  return [`${DIR}/${slug}.md`, findingText(keyShort).replace(`key: synthetic-${keyShort.toLowerCase()}`, `key: ${slug}`)];
}

export function findingStore(): Record<string, string> {
  const slugs = [FULL, ...TWINS];
  const index = ['# Findings index', '', '`key | status | title | verdict reason`', '', ...slugs.map((s) => `${s} | resolved | A finding | ok`)];
  return {
    [`${DIR}/INDEX.md`]: index.join('\n'),
    ...Object.fromEntries([finding(FULL, SHORT), ...TWINS.map((slug) => finding(slug, 'MP-902'))]),
  };
}
