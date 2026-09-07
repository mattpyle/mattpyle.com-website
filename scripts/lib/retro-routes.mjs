/**
 * The routes that get scanned in retro appearance.
 *
 * One list, two consumers: `tests/a11y/axe-retro.spec.ts`, which runs axe against each of these in
 * retro, and `scripts/retro-sweep.mjs`, which walks their computed styles for surviving modern
 * tokens. The two checks answer different questions about the same set of pages — "is retro
 * accessible here" and "is retro actually painted here" — and a page in one list and not the other
 * is a page half-checked, which is the state /steward and /projects were in when the sweep first
 * ran against them.
 *
 * The list itself mirrors the routes `.github/workflows/a11y.yml` audits with `@axe-core/cli` in
 * modern, in the order the workflow lists them. Adding a route here adds it to both checks.
 *
 * /audit APPEARS THREE TIMES, AND TWO OF THE ENTRIES CARRY A QUERY STRING. The page has three
 * rendered shapes — the form, a report, and an error — and they share almost no markup: the counts
 * grid, the fix rows, the evidence disclosures and the status marks exist only on the second, and
 * the callout only on the third. Scanning the form alone would leave the larger part of the page
 * never audited in retro and never swept.
 *
 * The report shape needs a run behind it, so the server both consumers run against has to be
 * started with AUDIT_REPORT_FIXTURE=1 (playwright.config.ts and the a11y workflow both set it;
 * `npm run sweep:retro` needs it on the server it is pointed at). The error shape needs nothing:
 * `file:///etc/hosts` is refused by the address parser before any branch that would fetch or read
 * a store, which is also why it is a safe URL to put in a CI command line.
 */
export const RETRO_ROUTES = [
  '/',
  '/about',
  '/writing',
  '/projects',
  '/changelog',
  '/changelog/public-scorecard/',
  '/scorecard',
  '/activity',
  '/steward',
  '/webmcp',
  '/audit',
  '/audit?url=https://example.com',
  '/audit?url=file:///etc/hosts',
  '/writing/accessibility-and-ai/',
];

/**
 * The routes above that answer with something other than 200, and what they answer with.
 *
 * One entry, and it is the point of the entry rather than an exception to the list: /audit's four
 * error states each answer with their own status code, because a 200 carrying an apology would be
 * a lie to every non-browser client that fetches one of these URLs (src/pages/audit.astro). The
 * page is still rendered in full, so it is still a surface retro has to paint and axe has to scan.
 *
 * `scripts/retro-sweep.mjs` reads this because it asserts the status it got: a 404 there means the
 * build is not being served and every clean sweep after it would be a sweep of nothing. Declaring
 * the one deliberate non-200 keeps that assertion doing its job instead of loosening it.
 */
export const RETRO_ROUTE_STATUS = { '/audit?url=file:///etc/hosts': 400 };
