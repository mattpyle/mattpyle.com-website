/**
 * The page matrix for the a11y suite: every page template, plus every page with
 * interactive behaviour of its own. Pages that share a template still get their
 * own row when their interactive furniture differs (e.g. /projects and /changelog
 * both list rows but carry different FilterPills groups).
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
    why: 'Homepage template: hero, writing rows, project cards, the live scorecard panel, agent surfaces, changelog',
    // The homepage ships ONE tree as of 2026-08-28 (one-dom phase 2): both
    // appearances style the same five sections, so these selectors are the whole
    // page in either appearance and the legacy hero/activity-log/recent-writing
    // rows they used to also list are gone with their components. What is still
    // appearance-specific is retro-only FURNITURE — the marquee, the counter and
    // the guest book block — which is display: none in modern and so absent from
    // the tree these rows capture.
    snapshotKeepFirst: ['.writing .row', '.projects .card', '.changelog .row'],
    snapshotRedact: [
      '.writing .row',
      '.projects .card',
      '.changelog .row',
      // Every scorecard run rewrites these three, and /scorecard's own golden
      // already guards the numbers' shape. The four GATE NAMES are not
      // content-variable and are deliberately left readable — they are the part
      // of this panel worth a golden.
      '.headline-number',
      '.headline-caption',
      '.gate-score',
    ],
  },
  {
    name: 'about',
    path: '/about',
    why: 'About template: the reading column, reach grid and portrait rail, one tree styled by both appearances',
    // ONE TREE as of 2026-08-29 (one-dom phase 5): the legacy PageHeader and
    // AboutGrid bio grid are deleted, so the hero and body below are the whole
    // page in either appearance. The h1 reads "About" in both now; it was
    // "Matt Pyle" in retro while the legacy tree shipped.
    //
    // Nothing on this page is content-variable: the copy is authored in the
    // template, not rendered from a collection, so there is nothing to redact and
    // no count to protect.
  },
  {
    name: 'writing-index',
    path: '/writing',
    why: 'Index template: the year-grouped archive, one tree styled by both appearances',
    // ONE TREE as of 2026-08-29 (one-dom phase 3): the legacy ArticleList and its
    // tag FilterPills radiogroup are deleted, so these selectors are the whole
    // page body in either appearance.
    snapshotKeepFirst: ['.archive .row'],
    // The year header carries a post COUNT, which every published post changes.
    snapshotRedact: ['.archive .row', '.archive .year-head'],
  },
  {
    name: 'projects-index',
    path: '/projects',
    why: 'Index template: the card grid both appearances read',
    // One tree since 2026-08-29, so this golden is the same in either
    // appearance. The legacy grid, its status FilterPills and its tag pills are
    // deleted, and their prune rules with them.
    snapshotKeepFirst: ['.board .card'],
    snapshotRedact: ['.board .card'],
  },
  {
    name: 'changelog-index',
    path: '/changelog',
    why: 'Index template: the year-grouped log, its type FilterPills and its pager, all read by both appearances',
    // One tree since 2026-08-29, so this golden is the same in either
    // appearance. The legacy ledger, its significance legend, its own
    // FilterPills instance and its tag pills are deleted, and their prune rules
    // with them — including a stale `.year-rule` entry the ledger never
    // rendered under that name.
    snapshotKeepFirst: [
      '[data-module="changelog-log"] .log-row',
      '[data-module="changelog-log"] .year-group',
    ],
    // ONLY THE ROWS ARE REDACTED. Three regions on this page carry a COUNT that
    // every published entry changes — the hero's "N entries, latest …" line,
    // the year head, and the pager's "showing X of Y" — and redacting a count
    // is the one thing that must not happen to it: `·` asserts nothing, so a
    // pager that rendered empty, or a hero that lost its number, would pass.
    // They are hand-written regexes in the golden instead, the way
    // steward.aria.yml holds its own counts. See the note in that golden's
    // sibling spec about what a forced regeneration does to them.
    snapshotRedact: [
      '[data-module="changelog-log"] .log-row',
      '.filter-status',
    ],
  },
  {
    name: 'writing-entry',
    path: `/writing/${WRITING_ENTRY}`,
    why: 'Article template: the sticky rail (in-page contents plus the four actions), one tree styled by both appearances',
    // ONE TREE as of 2026-08-29 (one-dom phase 3): the legacy header, its tag
    // list and the ArticleActions section are deleted, and the rail is shown in
    // both appearances because it is the only copy of the four actions now.
    snapshotDrop: ['.prose > *'],
    // The content-variable regions. The rail's contents list is built from the
    // post's h2s, so it is the article by another name; its SHAPE — a nav named
    // "On this page", one link per section — is what this golden is guarding,
    // and that survives redaction.
    //
    // The fixture post is the oldest one, so it never has a next-post row and
    // this golden does not cover it. `.post-next` is listed anyway, so the day
    // an older post exists the golden records a shape rather than a title.
    snapshotRedact: [
      '.post-title',
      '.post-lead',
      '.rail-contents',
      '.post-next',
    ],
  },
  {
    name: 'changelog-entry',
    path: `/changelog/${CHANGELOG_ENTRY}`,
    why: 'Changelog entry template: the head, the prose and the prev/next steps, all read by both appearances',
    // One tree since 2026-08-29. The legacy header and footer are deleted, and
    // with them the sig-chip, the type pill and the tag pills; their prune rules
    // go too.
    snapshotDrop: ['.prose > *'],
    snapshotRedact: [
      // Prev/next links are recomputed every time an entry ships either side.
      '.entry-nav',
      // The head's own content-variable regions.
      '.entry-title',
      '.entry-lead',
      '.entry-meta',
    ],
  },
  {
    name: 'scorecard',
    path: '/scorecard',
    why: 'Scorecard template: the redesigned gate row and previous-runs list, plus the legacy details/summary run history disclosures',
    // Two trees ship here and the hidden one is absent from the accessibility
    // tree, so this golden records whichever appearance the run is in — these
    // rows are taken in modern. The legacy selectors are kept so the pruning
    // still applies if a run ever takes this snapshot in retro.
    //
    // Every scorecard run rewrites src/data/scorecard-runs.json, so every number,
    // date and commentary line on this page is content-variable by construction.
    // The four GATE NAMES are not, and they are the part worth guarding.
    //
    // THE GATE SCORES ARE NOT REDACTED and must not be: `100` and `4/4` are the
    // denominator rule this page shares with the homepage panel, and `·` would
    // assert nothing about either. They are hand-written regexes in the golden,
    // the way steward.aria.yml holds its counts.
    //
    // The Agent traffic tables are gone from this page entirely — they moved to
    // /activity on 2026-08-22, which has its own row below.
    snapshotKeepFirst: ['.run', '.history-run'],
    // `.run-date` and `.run-note`, never `.run` itself: the middle cell of a previous-run row is
    // its gates-passing COUNT, and `·` would assert nothing about it. It stays in the golden as a
    // hand-written regex, the way the changelog pager's count does.
    snapshotRedact: [
      '.provenance',
      '.findings',
      '.run-date',
      '.run-note',
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
    name: 'activity',
    path: '/activity',
    why: 'Activity template: the 24-column hour chart, the last-hour table and the four count tables, plus the legacy traffic block retro wears',
    // Two trees ship here and the hidden one is absent from the accessibility
    // tree, so this golden records whichever appearance the run is in — these
    // rows are taken in modern. The legacy selectors are kept so the pruning
    // still applies if a run ever takes this snapshot in retro.
    //
    // This page reads a live store per request, so every figure on it is
    // content-variable. The suite serves it with AGENT_TRAFFIC_FIXTURE set (see
    // playwright.config.ts), which makes the row COUNTS deterministic and the
    // shape of a row worth guarding — one row per table, cells redacted.
    //
    // THE CHART IS PRUNED TO ONE COLUMN, not redacted away: 24 columns of
    // fixture counts would churn the golden on every run (each column's
    // accessible name carries its own UTC hour, and the hour moves with the
    // clock), while one column still records that a column is an hour label
    // followed by a count.
    //
    // ONE SELECTOR PER TABLE, never a shared class. `keepFirst` thins a selector's matches to the
    // first one in the document, so two tables sharing a class would lose the second table's rows
    // from the golden entirely rather than keeping one of each.
    snapshotKeepFirst: [
      '.chart-col',
      '.hour-table tbody tr',
      '.surface-table tbody tr',
      '.bot-page-table tbody tr',
      '.client-table tbody tr',
      '.markdown-table tbody tr',
      'table[aria-labelledby="traffic-surfaces-title"] tbody tr',
      'table[aria-labelledby="traffic-bot-pages-title"] tbody tr',
      'table[aria-labelledby="traffic-clients-title"] tbody tr',
      'table[aria-labelledby="traffic-markdown-title"] tbody tr',
    ],
    snapshotRedact: [
      '.stamp-rendered',
      '.count-number',
      '.chart-col',
      '.hour-table tbody tr',
      '.surface-table tbody tr',
      '.bot-page-table tbody tr',
      '.client-table tbody tr',
      '.markdown-table tbody tr',
      '.freshness',
      '#agent-traffic .num',
      '#agent-traffic tbody tr',
    ],
  },
  {
    name: 'steward',
    path: '/steward',
    why: 'Steward template: the check list, the log-identity and limits tables, and two focusable code blocks that must not wrap mid-token',
    // ONE TREE as of 2026-08-29 (one-dom phase 5): the legacy PageHeader and the inline
    // `.steward-shell` are deleted, so the hero and the five bands below are the whole page in
    // either appearance. `.check-plain` was the legacy tree's gloss and went with it; the
    // surviving gloss is `.check-detail`.
    //
    // The one-sentence gloss on each check is editorial copy; the check titles beside it are
    // Steward's own words, and agents/steward/tests/lib/agent-audit-checks.test.ts already fails if
    // the list drifts from the audit. Redacting the gloss keeps this golden a guard on the
    // template's shape rather than a second, weaker copy of that assertion.
    //
    // THE COUNTS ARE NOT REDACTED and must not be: the check count, the per-category counts and the
    // four rate-limit caps are the whole point of the tables that carry them. They are hand-written
    // regexes in the golden, so the shape is pinned and the value is free.
    snapshotRedact: ['.check-detail'],
  },
  {
    name: 'webmcp',
    path: '/webmcp',
    why: 'The most interactive page: aria-pressed choice buttons, inputs, run buttons, focusable scroll regions',
    // ONE CARD, not six. Six would be six copies of one template, and the
    // catalog is generated, so a seventh tool is a data change rather than a
    // template one. The kept card is `describe_site`, the first — which is the
    // no-inputs shape, so the schema table is deliberately outside this golden.
    //
    // Only the redesigned tree reaches this snapshot. Both trees ship and both
    // carry `.tool-card`, but the hidden one is absent from the accessibility
    // tree, so `keepFirst` sees the modern cards only. Its choice control is a
    // pair of `aria-pressed` toggle buttons; the legacy tree keeps the roving
    // radiogroup, and that tree is never what this file records.
    snapshotKeepFirst: ['.tool-card'],
  },
];

export function pageByName(name: string): PageSpec {
  const spec = PAGES.find(p => p.name === name);
  if (!spec) throw new Error(`No page spec named ${name}`);
  return spec;
}
