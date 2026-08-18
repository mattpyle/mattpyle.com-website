/**
 * The fast tier, as a package entry point the site can import.
 *
 * This file is the fast tier's surface for the site repo. Its first consumer, and the reason it
 * exists, is `src/pages/mcp.ts`, which answers a public `audit_site` call inside a Vercel
 * function; `scripts/validate-llms-txt.mjs` is the second, and reuses the llms.txt rules here
 * rather than keeping a copy. What is published is narrow on purpose — a package entry is a
 * promise about an import graph, and this one promises that the graph reaches HTTP, DNS and
 * undici and nothing else. Adding an export is cheap; adding one that widens that graph is not.
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

/**
 * The llms.txt spec conformance rules, for the site's own generated file.
 *
 * A second consumer for this entry, added 2026-08-17, and the reason the entry is now described as
 * the fast tier's surface rather than as one function for one caller. `scripts/validate-llms-txt.mjs`
 * in the site repo asserts that the file `src/pages/llms.txt.ts` generates still conforms to
 * llmstxt.org, and it reuses the parser here instead of growing a second one that drifts. It costs
 * the /mcp function bundle nothing: `checks.ts` is already the entry's first import, and
 * `llms-txt-conformance.ts` imports only that.
 */
export {
  checkLlmsTxtConformance,
  type LlmsTxtConformance,
  type LlmsTxtViolation,
} from './llms-txt-conformance.js';

export {
  AUDIT_USER_AGENT,
  AUDIT_VERSION,
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
