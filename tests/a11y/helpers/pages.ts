/**
 * The page matrix for the a11y suite: every page template, plus every page with
 * interactive behaviour of its own. Pages that share a template still get their
 * own row when their interactive furniture differs (e.g. /writing and /builds
 * share ArticleList-ish layout but carry different FilterPills groups).
 */

export interface PageSpec {
  /** Slug used in test titles and aria-snapshot filenames. */
  name: string;
  path: string;
  /** One-line note on why this row exists, for whoever reads a failure. */
  why: string;
  /**
   * Selectors whose matches are deleted before an aria snapshot is taken.
   * Content-variable regions only — prose bodies, data tables that a scorecard
   * run rewrites. See tests/a11y/aria-snapshot.spec.ts for the rationale.
   */
  snapshotDrop?: string[];
  /**
   * Selectors where every match after the first is deleted before an aria
   * snapshot. Keeps one representative list item so the snapshot still guards
   * the shape of a row, without churning every time a post ships.
   */
  snapshotKeepFirst?: string[];
  /**
   * Selectors whose subtree TEXT (and aria-label) is replaced with a constant
   * before an aria snapshot. Structure survives, copy does not — so the golden
   * still says "this row is a link containing a level-2 heading and a paragraph"
   * without saying which post it is. This is the difference between a snapshot
   * that guards a template and one that fails the day a post ships.
   */
  snapshotRedact?: string[];
}

export const WRITING_ENTRY = 'accessibility-and-ai';
export const CHANGELOG_ENTRY = 'public-scorecard';

export const PAGES: PageSpec[] = [
  {
    name: 'home',
    path: '/',
    why: 'Homepage template: hero, activity log, recent writing, retro furniture',
    snapshotKeepFirst: ['[data-module="activity-log"] .log-item', '.article-list .article-item'],
    snapshotRedact: [
      '[data-module="activity-log"] .log-item',
      '.article-list .article-item',
      '.filter-status',
    ],
  },
  {
    name: 'about',
    path: '/about',
    why: 'About template: headshot, bio, external contact links',
  },
  {
    name: 'writing-index',
    path: '/writing',
    why: 'Index template plus the tag FilterPills radiogroup',
    // Order matters: the row is thinned to one first, then its tag chips, whose
    // count is per-post and would otherwise churn the tree's shape.
    snapshotKeepFirst: ['[data-module="article-list"] .article-item', '.article-tags li'],
    snapshotRedact: ['[data-module="article-list"] .article-item', '.filter-status'],
  },
  {
    name: 'builds-index',
    path: '/builds',
    why: 'Index template plus the status FilterPills radiogroup',
    snapshotKeepFirst: ['[data-module="builds-grid"] .build-item', '.card-tags li'],
    snapshotRedact: ['[data-module="builds-grid"] .build-item', '.filter-status'],
  },
  {
    name: 'changelog-index',
    path: '/changelog',
    why: 'Ledger template, type FilterPills, year-rule grouping, pagination',
    snapshotKeepFirst: [
      '[data-module="changelog-ledger"] .lg-row',
      '[data-module="changelog-ledger"] .year-rule',
      '.lg-tags--desktop .tag-pill',
      '.lg-tags--mobile .tag-pill',
    ],
    snapshotRedact: ['[data-module="changelog-ledger"] .lg-row', '.filter-status'],
  },
  {
    name: 'writing-entry',
    path: `/writing/${WRITING_ENTRY}`,
    why: 'Article template plus ArticleActions (copy-markdown button, external links)',
    snapshotDrop: ['.prose > *'],
    snapshotKeepFirst: ['.article-tags li'],
    snapshotRedact: [
      '.page-title--article',
      '.article-dek',
      '.article-tags',
      '.article-meta',
      '.changelog-meta',
      // Prev/next links are recomputed every time an entry ships either side.
      '.entry-navigation',
    ],
  },
  {
    name: 'changelog-entry',
    path: `/changelog/${CHANGELOG_ENTRY}`,
    why: 'Changelog entry template, shares .prose with writing entries',
    snapshotDrop: ['.prose > *'],
    snapshotKeepFirst: ['.article-tags li'],
    snapshotRedact: [
      '.page-title--article',
      '.article-dek',
      '.article-tags',
      '.article-meta',
      '.changelog-meta',
      // Prev/next links are recomputed every time an entry ships either side.
      '.entry-navigation',
    ],
  },
  {
    name: 'scorecard',
    path: '/scorecard',
    why: 'Scorecard template, the details/summary run history disclosures, and the live Agent traffic tables',
    // Every scorecard run rewrites src/data/scorecard-runs.json, so every number,
    // date and commentary line on this page is content-variable by construction.
    // The four metric names are not, and they are the part worth guarding.
    //
    // The Agent traffic section is content-variable in a stronger sense again: it
    // reads a live store per request. The suite serves it with AGENT_TRAFFIC_FIXTURE
    // set (see playwright.config.ts), so the row COUNT is deterministic and the
    // shape of a row is worth guarding — one row per table, with its cells redacted.
    snapshotKeepFirst: [
      '.history-run',
      'table[aria-labelledby="traffic-surfaces-title"] tbody tr',
      'table[aria-labelledby="traffic-clients-title"] tbody tr',
      'table[aria-labelledby="traffic-markdown-title"] tbody tr',
    ],
    snapshotRedact: [
      '.freshness',
      '#agent-traffic .num',
      '#agent-traffic tbody tr',
      '#latest-run-title',
      '.latest-time',
      '.run-verdict',
      '.status',
      '.score-value',
      '.score-description',
      '.verification dd',
      '.current-commentary',
      '.history-header > p',
      '.history-run',
      '.history-footer > span',
    ],
  },
  {
    name: 'webmcp',
    path: '/webmcp',
    why: 'The most interactive page: per-tool radiogroups, inputs, run buttons, focusable scroll regions',
    snapshotKeepFirst: ['.tool-card'],
  },
];

export function pageByName(name: string): PageSpec {
  const spec = PAGES.find(p => p.name === name);
  if (!spec) throw new Error(`No page spec named ${name}`);
  return spec;
}
