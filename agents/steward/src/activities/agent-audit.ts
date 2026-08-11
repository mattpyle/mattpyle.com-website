import { log } from '../lib/logger.js';
import { runFastAudit, type RunAuditOptions } from '../lib/agent-audit/checks.js';
import type { AuditResult } from '../lib/agent-audit/result.js';

/**
 * The fast tier as an activity.
 *
 * Nothing calls it yet: stage 0 is a CLI verb and no workflow (hosted-mcp-server
 * card). It exists because the audit is I/O against a stranger's origin — the
 * textbook activity — and stage 1 wraps exactly this in a workflow. Writing it
 * as an activity now keeps the boundary where it belongs: `lib/agent-audit/` is
 * plain testable TypeScript with no Temporal imports, and this file is the only
 * place that knows about the runtime, the same split `audit-engine.ts` and
 * `activities/scorecard.ts` already use.
 *
 * Result size is worth watching before this goes into a workflow: the document
 * carries a bounded excerpt per check rather than any response body, which is
 * what keeps it inside Temporal's payload limits (large-data rule). If a later
 * tier wants full bodies, they go to disk and the result carries the path.
 */
export async function auditSiteFast(input: string, options: RunAuditOptions = {}): Promise<AuditResult> {
  const audit = await runFastAudit(input, options);
  log.info(
    {
      activity: 'auditSiteFast',
      origin: audit.target.origin,
      requests: audit.requests,
      durationMs: audit.durationMs,
      failed: audit.checks.filter((c) => c.status === 'fail').map((c) => c.id),
    },
    'fast agent-readiness audit complete',
  );
  return audit;
}
