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
  '/writing/accessibility-and-ai/',
];
