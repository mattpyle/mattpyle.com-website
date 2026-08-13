/**
 * The fast tier, as a package entry point the site can import.
 *
 * This file exists for exactly one consumer: `src/pages/mcp.ts` in the site
 * repo, which answers a public `audit_site` call inside a Vercel function. It is
 * the only thing `@mattpyle/steward`'s exports map publishes, and that narrowness
 * is the point — a package entry is a promise about an import graph, and this one
 * promises that the graph reaches HTTP, DNS and undici and nothing else.
 *
 * **What must never appear below this file:** `@temporalio/*`, `chrome-launcher`,
 * `lighthouse`, `@axe-core/*`, `@anthropic-ai/sdk`. Temporal because the public
 * endpoint has no worker and no client by design (hosted-mcp-stage-2 card,
 * "Decided"); the browser stack because it is tens of megabytes of dead weight in
 * a serverless bundle and, on a bad day, a build failure. The rule is checked
 * rather than asserted: `tests/steward-fast-audit-packaging.test.mjs` in the site
 * repo walks the real module graph from this file and fails on any of those
 * names.
 *
 * That check is only possible because `checks.ts` loads the deep tier through an
 * injected `loadDeep` thunk instead of a dynamic `import('./deep.js')`. A dynamic
 * import is lazy for Node and eager for every bundler, which is the difference
 * between a claim and a property.
 *
 * Steward ships as TypeScript source with no build step, so the exports map points
 * here directly and the site's Vite build transpiles it. `astro.config.mjs`
 * declares the package in `ssr.noExternal` for the same reason.
 *
 * Nothing in Steward imports this file; it re-exports, it does not implement.
 */

export {
  AUDIT_AGENT_TOKEN,
  TOOL_NAME,
  TOOL_VERSION,
  normaliseTarget,
  runFastAudit,
} from './checks.js';

export { renderMarkdownSummary } from './render.js';

export {
  AUDIT_USER_AGENT,
  BlockedTargetError,
  BudgetExhaustedError,
  DEFAULT_POLICY,
} from './safe-fetch.js';

export type { FetchPolicy } from './safe-fetch.js';

export {
  SCHEMA_VERSION,
  type AuditResult,
  type CategoryCount,
  type CheckCategory,
  type CheckEvidence,
  type CheckResult,
  type CheckStatus,
  type Severity,
} from './result.js';
