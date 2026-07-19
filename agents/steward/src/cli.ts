import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { Command } from 'commander';
import {
  ENABLE_BUILD_AUDIT,
  NAMESPACE,
  QUEUE_LIGHT,
  TEMPORAL_ADDRESS,
  WEB_UI,
  workflowIdFor,
  isCollection,
  COLLECTIONS,
  type Collection,
} from './config.js';
import type { ReviewStateResult, Verdict } from './lib/report.js';
import {
  reviewPost,
  approve as approveSignal,
  reject as rejectSignal,
  applyPatches as applyPatchesSignal,
  rereview as rereviewSignal,
  getReviewState,
} from './workflows/review-post.js';

async function client(): Promise<Client> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  return new Client({ connection, namespace: NAMESPACE });
}

function deepLink(slug: string, collection: Collection = 'writing'): string {
  return `${WEB_UI}/namespaces/${NAMESPACE}/workflows/${workflowIdFor(slug, collection)}`;
}

/** Parses the `<collection>` argument shared by the audit verb. */
function parseCollection(value: string): Collection {
  if (!isCollection(value)) {
    fail(`Unknown collection "${value}". Expected one of: ${COLLECTIONS.join(', ')}.`);
  }
  return value;
}

const BADGE: Record<Verdict, string> = { pass: '[ PASS]', flag: '[ FLAG]', block: '[BLOCK]' };

async function fetchReport(c: Client, slug: string, collection: Collection = 'writing') {
  const handle = c.workflow.getHandle(workflowIdFor(slug, collection));
  const state = await handle.query(getReviewState);
  return { handle, state };
}

/** Spec §10 rendering: plain text, no TUI framework. */
async function render(
  c: Client,
  slug: string,
  state: ReviewStateResult,
  collection: Collection = 'writing',
) {
  const report = await readArchivedReport(slug, state);
  const label = collection === 'writing' ? slug : `${collection}/${slug}`;
  const modeTag = report?.mode === 'audit' ? '  ·  mode: audit (advisory — nothing will be applied)' : '';
  console.log('');
  console.log(
    `  ${label}  —  state: ${state.state}${state.overall ? `  ·  overall: ${state.overall}` : ''}${modeTag}`,
  );
  console.log(`  ${deepLink(slug, collection)}`);
  console.log('');
  if (state.summary) console.log(`  ${state.summary}`);
  console.log('');

  if (report) {
    for (const pass of report.passes) {
      const counts = pass.findings.length;
      console.log(`  ${pass.pass} — ${pass.verdict} (${counts} finding${counts === 1 ? '' : 's'}, ${pass.durationMs}ms)`);
    }
    console.log('');
    const findings = report.passes.flatMap((p) => p.findings);
    if (findings.length === 0) {
      console.log('  No findings.');
    }
    for (const f of findings) {
      const patch = report.patches.find((p) => p.findingId === f.id);
      const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
      console.log(`  ${BADGE[f.severity]} ${f.pass}${where} ${f.message}${patch ? ` (${patch.id})` : ''}`);
      if (f.excerpt) console.log(`          ${f.excerpt}`);
    }
    if (report.patches.length) {
      console.log('');
      console.log('  Proposed patches:');
      for (const p of report.patches) {
        console.log(`    ${p.id}  "${p.oldText}" → "${p.newText}"  — ${p.rationale}`);
      }
    }
  }

  if (state.staleReason) {
    console.log('');
    console.log(`  ! ${state.staleReason}`);
  }
  if (state.reportPath) {
    console.log('');
    console.log(`  report: ${state.reportPath}`);
  }
  console.log('');
}

/** The query returns a summary; the full findings live in the archived JSON. */
async function readArchivedReport(slug: string, state: ReviewStateResult) {
  if (!state.reportPath) return null;
  const fs = await import('node:fs/promises');
  const { resolveArchivePath } = await import('./config.js');

  // A workflow parked before the reviews/<collection>/<slug>/ migration has the
  // *old* path baked into its history, and history is immutable — so the
  // recorded path points at a file that has moved. Falling back to the migrated
  // location keeps those reviews readable.
  //
  // This mattered in practice, not in theory: the live `hello-world` review was
  // parked across the migration and rendered a correct summary with a silently
  // empty findings table, which is the worst possible failure for this function.
  const candidates = [state.reportPath];
  const migrated = state.reportPath.replace(
    /^(agents\/steward\/reviews)\/(?!writing\/|changelog\/)/,
    '$1/writing/',
  );
  if (migrated !== state.reportPath) candidates.push(migrated);

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(resolveArchivePath(candidate), 'utf8');
      return JSON.parse(raw) as import('./lib/report.js').ReviewReport;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Finds an audit-mode review of `slug` in any collection, if one exists.
 *
 * Deliberately queries every collection rather than taking one as an argument:
 * `apply` is invoked with a bare slug, and the failure this guards against is a
 * human reaching for the verb they know from gate reviews. Refusing only when
 * they happen to name the right collection would miss exactly that case.
 */
async function findAuditedReport(
  c: Client,
  slug: string,
): Promise<{ collection: Collection; reportPath?: string } | null> {
  for (const collection of COLLECTIONS) {
    try {
      const handle = c.workflow.getHandle(workflowIdFor(slug, collection));
      const state = await handle.query(getReviewState);
      const report = await readArchivedReport(slug, state);
      if (report?.mode === 'audit') return { collection, reportPath: state.reportPath };
    } catch {
      // No workflow for this collection, or it predates the query — not an audit.
    }
  }
  return null;
}

const TERMINAL: ReviewStateResult['state'][] = [
  'approved',
  // An audit completes on its own the moment the report is archived — it is
  // terminal without any human decision, which is the whole point of the mode.
  'audited',
  'published',
  'rejected',
  'failed',
];

async function pollUntil(
  c: Client,
  slug: string,
  wanted: (s: ReviewStateResult) => boolean,
  intervalMs = 1000,
  timeoutMs = 15 * 60 * 1000,
  collection: Collection = 'writing',
): Promise<ReviewStateResult> {
  const handle = c.workflow.getHandle(workflowIdFor(slug, collection));
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const state = await handle.query(getReviewState);
    if (state.state !== last) {
      if (last) console.log(`  → ${state.state}`);
      last = state.state;
    }
    if (wanted(state)) return state;
    if (Date.now() > deadline) throw new Error(`Timed out waiting on ${slug} (last state: ${state.state})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const program = new Command();
program.name('steward').description('Editorial agent for mattpyle.com').version('0.1.0');

program
  .command('review')
  .argument('<slug>')
  .option('--skip-build-audit', 'skip the heavy build+audit pass (SHOW_DRAFTS build, axe, Lighthouse)')
  .description('Start a review and render the report when the fan-out finishes')
  .action(async (slug: string, opts: { skipBuildAudit?: boolean }) => {
    const c = await client();
    const workflowId = workflowIdFor(slug);

    // "Already open" has to be decided by the execution *status*, not by whether
    // a query succeeds: a completed, terminated, or failed workflow still answers
    // `getReviewState` perfectly happily, so a query-based guard permanently
    // refuses to start a second review of any slug ever reviewed.
    try {
      const description = await c.workflow.getHandle(workflowId).describe();
      if (description.status.name === 'RUNNING') {
        const existing = await c.workflow.getHandle(workflowId).query(getReviewState);
        fail(
          `A review of "${slug}" is already open (state: ${existing.state}).\n  Use \`steward status ${slug}\`, or send \`rereview\` to re-run against the current file.`,
        );
      }
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError) && !/not found|no such workflow/i.test(String(err))) {
        throw err;
      }
    }

    await c.workflow.start(reviewPost, {
      workflowId,
      taskQueue: QUEUE_LIGHT,
      // Duplicates while a review is *open* are refused by the status guard
      // above. Once a review has closed, starting a new one for the same slug is
      // the normal case (the post got edited), so the server-side policy must
      // allow it — ALLOW_DUPLICATE_FAILED_ONLY would permanently lock out any
      // slug whose review completed.
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      // Both gates collapse to one boolean here, because the workflow sandbox
      // cannot read config: the phase gate turns the pass on at all, and the
      // flag lets a human skip it for a fast mechanical-only review.
      args: [
        {
          slug,
          collection: 'writing',
          mode: 'gate',
          skipBuildAudit: opts.skipBuildAudit === true || !ENABLE_BUILD_AUDIT,
        },
      ],
    });

    console.log(`  started ${workflowId}`);
    const state = await pollUntil(c, slug, (s) => s.state !== 'running');
    await render(c, slug, state);
    await c.connection.close();
  });

program
  .command('audit')
  .argument('<collection>', `one of: ${COLLECTIONS.join(', ')}`)
  .argument('<slug>')
  .option('--skip-build-audit', 'skip the heavy build+audit pass (build, axe, Lighthouse)')
  .description('Review already-published content. Advisory only — no verdict, no patches applied.')
  .action(async (collectionArg: string, slug: string, opts: { skipBuildAudit?: boolean }) => {
    const collection = parseCollection(collectionArg);
    const c = await client();
    const workflowId = workflowIdFor(slug, collection);

    try {
      const description = await c.workflow.getHandle(workflowId).describe();
      if (description.status.name === 'RUNNING') {
        fail(`A review of "${collection}/${slug}" is already open. Use \`steward status\`.`);
      }
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError) && !/not found|no such workflow/i.test(String(err))) {
        throw err;
      }
    }

    await c.workflow.start(reviewPost, {
      workflowId,
      taskQueue: QUEUE_LIGHT,
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      args: [
        {
          slug,
          collection,
          mode: 'audit',
          skipBuildAudit: opts.skipBuildAudit === true || !ENABLE_BUILD_AUDIT,
        },
      ],
    });

    console.log(`  started ${workflowId} (audit)`);
    // An audit has no verdict to park on: it archives the report and completes.
    // A closed workflow still answers queries, so polling to the terminal state
    // is safe even if it finishes before the first poll.
    const state = await pollUntil(c, slug, (s) => TERMINAL.includes(s.state), 1000, 15 * 60 * 1000, collection);
    await render(c, slug, state, collection);
    console.log('  Advisory only. Findings are not applied — take them through your normal git flow.\n');
    await c.connection.close();
  });

program
  .command('status')
  .argument('<slug>')
  .description('Query the current review state')
  .action(async (slug: string) => {
    const c = await client();
    try {
      const { state } = await fetchReport(c, slug);
      await render(c, slug, state);
    } catch (err) {
      fail(`No review found for "${slug}". Start one with \`steward review ${slug}\`.\n  (${String(err)})`);
    }
    await c.connection.close();
  });

program
  .command('approve')
  .argument('<slug>')
  .option('--force', 'approve despite blocking findings')
  .description('Approve the review')
  .action(async (slug: string, opts: { force?: boolean }) => {
    const c = await client();
    const handle = c.workflow.getHandle(workflowIdFor(slug));
    await handle.signal(approveSignal, opts.force === true);
    console.log(`  approve signal sent${opts.force ? ' (--force)' : ''}`);

    const state = await pollUntil(
      c,
      slug,
      (s) => TERMINAL.includes(s.state) || s.staleReason !== undefined,
      1000,
      2 * 60 * 1000,
    );
    await render(c, slug, state);
    if (!TERMINAL.includes(state.state)) process.exitCode = 1;
    await c.connection.close();
  });

program
  .command('reject')
  .argument('<slug>')
  .requiredOption('--reason <text>', 'why the post was rejected')
  .description('Reject the review')
  .action(async (slug: string, opts: { reason: string }) => {
    const c = await client();
    const handle = c.workflow.getHandle(workflowIdFor(slug));
    await handle.signal(rejectSignal, opts.reason);
    console.log('  reject signal sent');
    const state = await pollUntil(c, slug, (s) => TERMINAL.includes(s.state), 1000, 60 * 1000);
    await render(c, slug, state);
    await c.connection.close();
  });

program
  .command('apply')
  .argument('<slug>')
  .requiredOption('--patches <ids>', 'comma-separated patch IDs, e.g. patch-1,patch-3')
  .description('Apply selected patches to the post in the primary checkout')
  .action(async (slug: string, opts: { patches: string }) => {
    const ids = opts.patches
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) fail('No patch IDs given. Example: --patches patch-1,patch-3');

    const c = await client();

    // Refuse before signalling, and say why.
    //
    // The workflow already discards decisions in audit mode, so nothing would be
    // applied either way — but "signal sent" followed by silence is a terrible
    // way to learn that. An audit's patches are suggestions about content that
    // is already live; acting on them is a git operation the human performs,
    // not something the Steward does behind an approve.
    const auditedReport = await findAuditedReport(c, slug);
    if (auditedReport) {
      fail(
        `"${auditedReport.collection}/${slug}" was reviewed in audit mode, so \`apply\` is refused.\n` +
          `  Audit findings are advisory: the content is already published, and editing it goes\n` +
          `  through your normal git flow. The proposed patches are in the report:\n` +
          `  ${auditedReport.reportPath ?? '(see agents/steward/reviews/)'}`,
      );
    }

    const handle = c.workflow.getHandle(workflowIdFor(slug));
    await handle.signal(applyPatchesSignal, ids);
    console.log(`  applyPatches signal sent (${ids.join(', ')})`);

    // The apply lands in one of two terminal-for-this-signal states: `stale` on
    // success, or back to `awaiting_verdict` with a staleReason if the patch
    // refused to apply. Both set staleReason, so wait for either.
    const state = await pollUntil(
      c,
      slug,
      (s) => s.state === 'stale' || s.staleReason !== undefined,
      1000,
      2 * 60 * 1000,
    );
    await render(c, slug, state);

    if (state.state === 'stale') {
      console.log(`  Next: run \`steward rereview ${slug}\` to re-check the edited file.\n`);
    } else {
      process.exitCode = 1;
    }
    await c.connection.close();
  });

program
  .command('rereview')
  .argument('<slug>')
  .description('Re-run the checks against the current file and render the new report')
  .action(async (slug: string) => {
    const c = await client();
    const handle = c.workflow.getHandle(workflowIdFor(slug));
    await handle.signal(rereviewSignal);
    console.log('  rereview signal sent');

    // The fan-out passes through `running`; wait for it to start before waiting
    // for it to finish, otherwise a fast query can catch the pre-signal
    // `awaiting_verdict` and return the *old* report as if it were the new one.
    await pollUntil(c, slug, (s) => s.state === 'running', 250, 60 * 1000).catch(() => undefined);
    const state = await pollUntil(c, slug, (s) => s.state !== 'running');
    await render(c, slug, state);
    await c.connection.close();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
