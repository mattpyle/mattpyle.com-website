/**
 * Activity registry. One worker process registers both queues (spec §3), so the
 * same module is used for each — the split that matters is which *stub* the
 * workflow calls, not which functions exist where.
 *
 * Phase 1a implemented the light set; Phase 1b adds `vale`, `editorial`, and
 * `patches`; Phase 1c adds `build-audit`; Phase 2 adds `publish` and
 * `verify-deploy`.
 */
export { snapshotDraft, currentContentHash } from './snapshot.js';
export { runCspell } from './cspell.js';
export { runVale } from './vale.js';
export { checkFrontmatter } from './frontmatter.js';
export { editorialPass, eprimeAlternativesPass } from './editorial.js';
export { tellCitations } from './tells.js';
export { applyPatchesActivity } from './patches.js';
export { buildAndAuditDraft } from './build-audit.js';
export { synthesizeReport } from './synthesize.js';
export { archiveReport } from './archive.js';
export { publishPost } from './publish.js';
export { verifyDeploy } from './verify-deploy.js';
export { checkPrChecks } from './publish.js';
// `auditSiteWorkflow`, all on the audit queue: the fast tier is one activity,
// and the deep tier is the fetch pass, one activity per rendered page, and
// assembly (stage 3's fan-out).
export {
  auditSiteFast,
  auditSiteFetchChecks,
  auditRenderedPage,
  assembleDeepAudit,
} from './agent-audit.js';
// Alerting (audit-stack-alerting-and-monitoring card). On the audit queue with
// the workflows that schedule them: both make one HTTP call and touch nothing
// local.
export { reportRunHealth, checkCredentialExpiry } from './health.js';
export {
  resolveAuditUrls,
  resolveRunStamp,
  auditLiveUrl,
  readPublishedScorecard,
  publishScorecardRun,
  archiveScorecardRun,
} from './scorecard.js';
