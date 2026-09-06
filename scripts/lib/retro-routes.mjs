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
 * /audit APPEARS TWICE, AND THE SECOND ENTRY CARRIES A QUERY STRING. The page has two shapes —
 * the form, and a rendered report — and they share almost no markup: the counts grid, the fix
 * rows, the evidence disclosures and the status marks exist only on the second. Scanning the
 * form alone would leave the larger half of the page never audited in retro and never swept.
 * The report shape needs a run behind it, so the server both consumers run against has to be
 * started with AUDIT_REPORT_FIXTURE=1 (playwright.config.ts and the a11y workflow both set it;
 * `npm run sweep:retro` needs it on the server it is pointed at).
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
  '/writing/accessibility-and-ai/',
];
