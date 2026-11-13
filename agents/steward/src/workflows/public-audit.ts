/**
 * The public-audit role's workflow bundle entry (STW-610).
 *
 * The public role's audit queue bundles this file in place of `index.ts`, so the
 * worker carries `auditSiteWorkflow` and no other workflow. `index.ts` is the
 * default role's entry and is unchanged. The workflow code is the same module
 * either way, so a run replays identically on both; `tests/workflows/replay.test.ts`
 * replays the audit fixture against a bundle built from this file.
 *
 * Export only `./audit-site.js` here. Anything else becomes a workflow type the
 * uncredentialed worker accepts.
 */
export * from './audit-site.js';
