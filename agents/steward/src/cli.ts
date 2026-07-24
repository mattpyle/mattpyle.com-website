import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, Connection, WorkflowNotFoundError, type WorkflowExecutionInfo } from '@temporalio/client';
import { Command } from 'commander';
import {
  ENABLE_AI_TELLS,
  ENABLE_BUILD_AUDIT,
  ENABLE_PUBLISH_LEG,
  NAMESPACE,
  QUEUE_LIGHT,
  TEMPORAL_ADDRESS,
  WEB_UI,
  SITEMAP_URL,
  SCORECARD_MAX_AGE_DAYS_DEFAULT,
  SCORECARD_RUNS_PATH,
  STEWARD_TIMEZONE,
  SITE_DIR,
  workflowIdFor,
  parseWorkflowId,
  isCollection,
  COLLECTIONS,
  type Collection,
} from './config.js';
import type { ReviewStateResult, Verdict } from './lib/report.js';
import { readArchivedReport, readLatestReport } from './lib/read-report.js';
import { DIM, paint, renderReport } from './lib/render-report.js';
import { deriveInboxHint } from './lib/inbox.js';
import {
  reviewPost,
  approve as approveSignal,
  reject as rejectSignal,
  applyPatches as applyPatchesSignal,
  rereview as rereviewSignal,
  getReviewState,
} from './workflows/review-post.js';
import { scorecardAuditWorkflow } from './workflows/scorecard-audit.js';
import type { ScorecardRunRecord } from './lib/scorecard-aggregate.js';

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

async function fetchReport(c: Client, slug: string, collection: Collection = 'writing') {
  const handle = c.workflow.getHandle(workflowIdFor(slug, collection));
  const state = await handle.query(getReviewState);
  return { handle, state };
}

/**
 * Spec §10 rendering: plain text, no TUI framework.
 *
 * The report itself (header, findings, patches, build audit, next hint) is
 * `renderReport` — the same pure renderer `steward report` calls — so this
 * function only adds the workflow-state framing that isn't part of the
 * archived report: the live state name, the deep link, a stale reason, and the
 * report's path. When no report has been archived yet (mid fan-out), it falls
 * back to the workflow query's own `summary`.
 */
async function render(
  c: Client,
  slug: string,
  state: ReviewStateResult,
  collection: Collection = 'writing',
) {
  const report = await readArchivedReport(state);
  const label = collection === 'writing' ? slug : `${collection}/${slug}`;
  console.log('');
  console.log(`  ${label}  —  workflow state: ${state.state}`);
  console.log(`  ${deepLink(slug, collection)}`);

  if (report) {
    console.log(renderReport(report));
  } else {
    console.log('');
    if (state.summary) console.log(`  ${state.summary}`);
    console.log('');
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
    let state: ReviewStateResult;
    try {
      const handle = c.workflow.getHandle(workflowIdFor(slug, collection));
      state = await handle.query(getReviewState);
    } catch {
      // No workflow for this collection, or it predates the query — not an audit.
      continue;
    }
    // Deliberately outside the catch: per design rule 11, an unreadable report
    // for a workflow that *does* exist is a bug, not an absence, and must not be
    // downgraded to "not an audit" — that would let `apply` proceed against
    // content the audit was supposed to protect.
    const report = await readArchivedReport(state);
    if (report?.mode === 'audit') return { collection, reportPath: state.reportPath };
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
  .option('--ai-tells', 'add the ai-tells pass (unvalidated — see spec §9.2)')
  .description('Start a review and render the report when the fan-out finishes')
  .action(async (slug: string, opts: { skipBuildAudit?: boolean; aiTells?: boolean }) => {
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
          // Resolved here, never read in the workflow — design rule 10. The
          // flag turns the pass on at all; the CLI option turns it on for one
          // run without a config change, which is what the validation study
          // needs (it must not flip a global while a review sits parked).
          enableAiTells: opts.aiTells === true || ENABLE_AI_TELLS,
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
  .option('--ai-tells', 'add the ai-tells pass (unvalidated — see spec §9.2)')
  .description('Review already-published content. Advisory only — no verdict, no patches applied.')
  .action(async (collectionArg: string, slug: string, opts: { skipBuildAudit?: boolean; aiTells?: boolean }) => {
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
          enableAiTells: opts.aiTells === true || ENABLE_AI_TELLS,
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
    // Only the *query* may be reported as "no review found". Rendering is outside
    // the catch on purpose (design rule 11): an unreadable archived report would
    // otherwise be misreported as a missing review, which is the same
    // path-bug-looks-like-absence failure the rule exists to stop.
    let state: ReviewStateResult;
    try {
      ({ state } = await fetchReport(c, slug));
    } catch (err) {
      fail(`No review found for "${slug}". Start one with \`steward review ${slug}\`.\n  (${String(err)})`);
    }
    await render(c, slug, state);
    await c.connection.close();
  });

program
  .command('report')
  .argument('<slug>')
  .option('--collection <name>', `one of: ${COLLECTIONS.join(', ')}`, 'writing')
  .description('Pretty-print the latest archived report for a slug — no live workflow needed')
  .action(async (slug: string, opts: { collection: string }) => {
    const collection = parseCollection(opts.collection);
    const report = await readLatestReport(collection, slug);
    if (!report) {
      const label = collection === 'writing' ? slug : `${collection}/${slug}`;
      fail(`No report found for ${label} — run \`steward review ${slug}\` first.`);
    }
    console.log(renderReport(report));
  });

/**
 * Every RUNNING `reviewPost` execution — the "OPEN reviews" `inbox` lists by
 * default.
 *
 * `WorkflowType='reviewPost' AND ExecutionStatus='Running'` is confirmed
 * reliable against this project's dev server (verified live, alongside a
 * `WorkflowId STARTS_WITH 'steward-review-'` variant that also works — see
 * the build log). The fallback below exists for a visibility store that
 * doesn't support `WorkflowType` in a custom query at all: list everything
 * running and filter by type in code rather than trust an untested query on
 * whatever server this actually runs against.
 */
async function listOpenReviews(c: Client): Promise<WorkflowExecutionInfo[]> {
  const results: WorkflowExecutionInfo[] = [];
  try {
    for await (const info of c.workflow.list({
      query: "WorkflowType='reviewPost' AND ExecutionStatus='Running'",
    })) {
      results.push(info);
    }
    return results;
  } catch {
    for await (const info of c.workflow.list({ query: "ExecutionStatus='Running'" })) {
      if (info.type === 'reviewPost') results.push(info);
    }
    return results;
  }
}

/** Same shape, most-recently-closed first, capped — `--all`'s second section. */
async function listClosedReviews(c: Client, limit: number): Promise<WorkflowExecutionInfo[]> {
  const results: WorkflowExecutionInfo[] = [];
  try {
    for await (const info of c.workflow.list({
      query: "WorkflowType='reviewPost' AND ExecutionStatus!='Running'",
    })) {
      results.push(info);
      if (results.length >= limit) break;
    }
  } catch {
    for await (const info of c.workflow.list({ query: "ExecutionStatus!='Running'" })) {
      if (info.type !== 'reviewPost') continue;
      results.push(info);
      if (results.length >= limit) break;
    }
  }
  return results;
}

interface InboxRow {
  label: string;
  state: string;
  overall?: Verdict;
  hint: string;
  yourTurn: boolean;
  deepLink: string;
  /** True when the worker was unreachable and this row is server-truth-only. */
  degraded: boolean;
}

/**
 * Resolves one row. `getReviewState` is worker-executed (queries always are),
 * so a down worker fails it — caught here and degraded to `describe()`,
 * server-side truth that needs no worker at all (rule 5 of the brief; mirrors
 * how `status`'s README troubleshooting entry already treats this).
 */
async function inboxRow(c: Client, info: WorkflowExecutionInfo): Promise<InboxRow> {
  const { slug, collection } = parseWorkflowId(info.workflowId);
  const label = collection === 'writing' ? slug : `${collection}/${slug}`;
  const link = deepLink(slug, collection);
  const handle = c.workflow.getHandle(info.workflowId, info.runId);

  let state: ReviewStateResult;
  try {
    state = await handle.query(getReviewState);
  } catch {
    const description = await handle.describe();
    return {
      label,
      state: description.status.name,
      hint: '(worker not running — start it for the verdict, hint, and findings)',
      yourTurn: false,
      deepLink: link,
      degraded: true,
    };
  }

  // Only the parked-mid-publish shape needs the PR URL, and it comes from the
  // archived report, not from parsing `staleReason` text — the report schema
  // is the stable source, free text is not. Design rule 11: this must not be
  // swallowed into a blank hint on failure, so it is not wrapped in a catch —
  // a broken archive read here is a real bug and should crash the command.
  const prUrl =
    state.state === 'publishing' && state.staleReason
      ? (await readArchivedReport(state))?.publish.prUrl
      : undefined;

  const { yourTurn, hint } = deriveInboxHint({ state: state.state, staleReason: state.staleReason, prUrl });

  return { label, state: state.state, overall: state.overall, hint, yourTurn, deepLink: link, degraded: false };
}

program
  .command('inbox')
  .option('--all', 'also list recently-closed reviews below the open table')
  .description('One row per open review across every slug — what is waiting on you, sorted to the top')
  .action(async (opts: { all?: boolean }) => {
    const c = await client();
    const openInfos = await listOpenReviews(c);

    if (openInfos.length === 0) {
      console.log('\n  No open reviews.\n');
    } else {
      const rows = await Promise.all(openInfos.map((info) => inboxRow(c, info)));
      rows.sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn) || a.label.localeCompare(b.label));

      const yourTurnCount = rows.filter((r) => r.yourTurn).length;
      const anyDegraded = rows.some((r) => r.degraded);

      console.log(
        `\n  ${rows.length} review${rows.length === 1 ? '' : 's'} open  ·  ${yourTurnCount} waiting on you\n`,
      );
      const slugW = Math.max(...rows.map((r) => r.label.length), 4);
      const stateW = Math.max(...rows.map((r) => r.state.length), 5);
      const overallW = 7;
      for (const r of rows) {
        console.log(
          `  ${r.label.padEnd(slugW)}  ${r.state.padEnd(stateW)}  ${(r.overall ?? '—').padEnd(overallW)}  ${r.hint}`,
        );
        console.log(`  ${' '.repeat(slugW)}  ${r.deepLink}`);
      }
      console.log('');
      if (anyDegraded) {
        console.log('  ! Worker not running for one or more reviews — start it (`steward up`) for full detail.\n');
      }
    }

    if (opts.all) {
      const closed = await listClosedReviews(c, 20);
      console.log(`  --- recently closed (up to 20) ---\n`);
      if (closed.length === 0) {
        console.log('  None.\n');
      } else {
        for (const info of closed) {
          const { slug, collection } = parseWorkflowId(info.workflowId);
          const label = collection === 'writing' ? slug : `${collection}/${slug}`;
          console.log(`  ${label.padEnd(30)}  ${info.status.name.padEnd(10)}  ${info.closeTime?.toISOString() ?? '—'}`);
        }
        console.log('');
      }
    }

    await c.connection.close();
  });

program
  .command('stats')
  .description('Count archived reviews and E-Prime density (README operational rule 4)')
  .option('--tells', 'show ai-tells scores and per-100-word tell densities instead')
  .action(async (opts: { tells?: boolean }) => {
    const { collectStats } = await import('./lib/stats.js');
    const stats = await collectStats();
    const qualifying = stats.filter((s) => s.qualifies);

    if (opts.tells) {
      const { TELL_CATEGORIES } = await import('./lib/tells.js');
      const scored = stats.filter((s) => s.tellCounts !== null);

      console.log('');
      if (scored.length === 0) {
        console.log('  No archived review carries an ai_tells pass yet.');
        console.log('  Run a review or audit with --ai-tells to produce one.\n');
        return;
      }

      // Composite + the two aggregates, sorted by composite descending. RANK is
      // the unit of comparison across collections, never the raw score gap.
      console.log('  slug                        collection  words  score  all/100w  voice/100w  fmt/100w');
      for (const s of [...scored].sort((a, b) => (b.aiLikenessScore ?? 0) - (a.aiLikenessScore ?? 0))) {
        console.log(
          `  ${s.slug.padEnd(26)}  ${s.collection.padEnd(10)}  ${String(s.words).padStart(5)}  ` +
            `${String(s.aiLikenessScore ?? '—').padStart(5)}  ` +
            `${String(s.tellTotalPer100 ?? '—').padStart(8)}  ` +
            `${String(s.voiceTellsPer100 ?? '—').padStart(10)}  ` +
            `${String(s.formatTellsPer100 ?? '—').padStart(8)}`,
        );
      }

      console.log('');
      console.log('  Per-category findings per 100 words:');
      console.log(`  ${'slug'.padEnd(26)}  ${TELL_CATEGORIES.map((c) => c.slice(0, 9).padStart(9)).join(' ')}`);
      for (const s of scored) {
        console.log(
          `  ${s.slug.padEnd(26)}  ` +
            TELL_CATEGORIES.map((c) => String(s.tellsPer100?.[c] ?? '—').padStart(9)).join(' '),
        );
      }

      console.log('');
      console.log('  Raw counts are deliberately NOT shown across collections: the corpus has a ~9x');
      console.log('  genre gap in length, so a per-file total measures length first. Compare by RANK.');
      console.log('');
      return;
    }

    console.log('');
    console.log('  slug                        collection  mode   E-Prime  words  /100w  qualifies');
    for (const s of stats) {
      console.log(
        `  ${s.slug.padEnd(26)}  ${s.collection.padEnd(10)}  ${s.mode.padEnd(5)}  ` +
          `${String(s.ePrimeHits).padStart(7)}  ${String(s.words).padStart(5)}  ` +
          `${(s.ePrimePer100 ?? '—').toString().padStart(5)}  ${s.qualifies ? 'yes' : 'no'}`,
      );
    }
    console.log('');
    console.log(`  Qualifying reviews (writing · gate · not a fixture): ${qualifying.length} of 3`);
    if (qualifying.length >= 3) {
      const totalHits = qualifying.reduce((n, s) => n + s.ePrimeHits, 0);
      const totalWords = qualifying.reduce((n, s) => n + s.words, 0);
      const density = totalWords ? ((totalHits / totalWords) * 100).toFixed(2) : '—';
      console.log('');
      console.log(`  → Re-decide write-good.E-Prime. Density across qualifying reviews: ${density} hits/100 words.`);
      console.log('    Compare against PROSE baselines, not the Phase 1b 8.8/file figure — see README rule 4.');
    }
    console.log('');
  });

program
  .command('score')
  .argument('<collection>', `one of: ${COLLECTIONS.join(', ')}`)
  .argument('<slug>')
  .option('--runs <n>', 'how many times to score the piece', '2')
  .option('--provenance <label>', 'ai | human | mixed — recorded, never inferred', 'unknown')
  .description('Score one piece with the ai-tells rubric (validation study). No workflow, no verdict.')
  .action(async (collectionArg: string, slug: string, opts: { runs: string; provenance: string }) => {
    const collection = parseCollection(collectionArg);
    const runs = Number(opts.runs);
    if (!Number.isInteger(runs) || runs < 1) fail(`--runs must be a positive integer, got "${opts.runs}"`);

    const { editorialPass } = await import('./activities/editorial.js');
    const { readPieceMeta, savePiece } = await import('./lib/study.js');
    const { postRelPath } = await import('./config.js');

    const file = postRelPath(slug, collection);
    // Read from the file, not from a previous study record: `draft` is a fact
    // about the post, and taking it from the saved record made it silently
    // always false on a first run.
    const { words, draft } = await readPieceMeta(collection, slug);

    console.log(`\n  scoring ${collection}/${slug} — ${words} words, ${runs} run(s)\n`);

    const collected: import('./lib/study.js').StudyRun[] = [];
    for (let i = 1; i <= runs; i += 1) {
      const result = await editorialPass(file, 'ai-tells');
      const score = result.metrics?.aiLikenessScore as number;
      const tellCounts = result.metrics?.tellCounts as Record<string, number>;
      const dropped = result.metrics?.droppedPatches as number;

      collected.push({
        run: i,
        aiLikenessScore: score,
        tellCounts,
        durationMs: result.durationMs,
        rubricSha256: result.rubric?.sha256 ?? '',
        model: result.rubric?.model ?? '',
        at: new Date().toISOString(),
      });

      const fired = Object.entries(tellCounts)
        .filter(([, n]) => n > 0)
        .map(([c, n]) => `${c}:${n}`)
        .join(' ');
      console.log(`  run ${i}: score ${String(score).padStart(3)}  ${result.findings.length} findings  ${result.durationMs}ms`);
      console.log(`          ${fired || '(no tells fired)'}`);
      // The rubric forbids patches; a non-zero count is a finding about the
      // model, not about the post, and must not pass silently.
      if (dropped > 0) console.log(`          ! ${dropped} patch(es) proposed and dropped (clamp 3)`);
    }

    const saved = await savePiece({
      collection,
      slug,
      provenance: opts.provenance,
      draft,
      words,
      runs: collected,
    });

    const scores = collected.map((r) => r.aiLikenessScore);
    const spread = Math.max(...scores) - Math.min(...scores);
    console.log(`\n  scores: ${scores.join(', ')}   spread: ${spread}${spread > 10 ? '  ← EXCEEDS the +/-10 stability bound' : ''}`);
    console.log(`  ${saved}\n`);
  });

program
  .command('study')
  .description('Aggregate the ai-tells validation study and test it against the pre-registered hypothesis')
  .option(
    '--deterministic',
    'skip the archived LLM study entirely; scan the corpus fresh with the 5 deterministic tells (zero API calls)',
  )
  .action(async (opts: { deterministic?: boolean }) => {
    if (opts.deterministic) {
      // A dedicated early return, not a branch buried in the LLM-study output
      // below: that path imports `lib/llm.js` (for `loadRubric`) purely to
      // print the rubric text, and reads `reviews/_study/*.json`, which is
      // archived LLM output. Neither belongs anywhere near a path whose whole
      // point is "this makes zero API calls" — keeping it a separate function
      // (`scanCorpusDeterministic`, `lib/corpus-scan.ts`) makes that a
      // property of the import graph, not just a comment.
      const { scanCorpusDeterministic, renderCorpusScan } = await import('./lib/corpus-scan.js');
      const rows = await scanCorpusDeterministic();
      if (rows.length === 0) {
        console.log('\n  No writing or changelog content found under src/content/.\n');
        return;
      }
      console.log(renderCorpusScan(rows));
      console.log(`\n  ${rows.length} piece(s) scanned. Zero Anthropic API calls made.\n`);
      return;
    }

    const { loadAll, analysePiece, rankBy, STABILITY_BOUND, buildComparisonRows, renderComparison } =
      await import('./lib/study.js');
    const { TELL_CATEGORIES } = await import('./lib/tells.js');

    const pieces = await loadAll();
    if (pieces.length === 0) {
      console.log('\n  No pieces scored yet. Run `steward score <collection> <slug>`.\n');
      return;
    }

    const rows = pieces.map(analysePiece).sort((a, b) => b.meanScore - a.meanScore);

    console.log('\n  === Per-piece results ===\n');
    console.log('  piece                                 coll       prov   words  run1  run2  spread  mean  stable');
    for (const r of rows) {
      const [r1, r2] = [r.scores[0], r.scores[1]];
      console.log(
        `  ${r.piece.slug.slice(0, 35).padEnd(35)}  ${r.piece.collection.padEnd(9)}  ${r.piece.provenance.padEnd(5)}  ` +
          `${String(r.piece.words).padStart(5)}  ${String(r1 ?? '—').padStart(4)}  ${String(r2 ?? '—').padStart(4)}  ` +
          `${String(r.spread).padStart(6)}  ${String(r.meanScore).padStart(4)}  ${r.stable ? 'yes' : 'NO'}`,
      );
    }

    console.log('\n  === Per-category totals (mean findings per run) ===\n');
    console.log(`  ${'piece'.padEnd(35)}  ${TELL_CATEGORIES.map((c) => c.slice(0, 8).padStart(8)).join(' ')}`);
    for (const r of rows) {
      console.log(
        `  ${r.piece.slug.slice(0, 35).padEnd(35)}  ` +
          TELL_CATEGORIES.map((c) => r.meanTellCounts[c].toFixed(1).padStart(8)).join(' '),
      );
    }

    // --- The pre-registered hypothesis ------------------------------------
    console.log('\n  === Against the pre-registered hypothesis ===\n');

    const unstable = rows.filter((r) => !r.stable);
    console.log(`  (a) STABILITY — both runs within +/-${STABILITY_BOUND}:`);
    console.log(`      ${rows.length - unstable.length} of ${rows.length} pieces stable.` +
      (unstable.length ? `  UNSTABLE: ${unstable.map((r) => r.piece.slug).join(', ')}` : '  (a) HOLDS.'));

    // (a') binding: unstable pieces are not rankable.
    const rankable = rows.filter((r) => r.stable);
    if (unstable.length) {
      console.log(`      (a') binding: ${unstable.length} piece(s) reported UNINTERPRETABLE and excluded from (b)/(c).`);
    }

    const humans = rankable.filter((r) => r.piece.provenance === 'human');
    const changelogs = rankable.filter((r) => r.piece.collection === 'changelog');

    const report = (label: string, score: (r: (typeof rankable)[number]) => number) => {
      const ranks = rankBy(rankable, score);
      console.log(`\n  ${label}`);
      for (const h of humans) {
        const below = changelogs.filter((c) => score(c) > score(h)).length;
        const verdict = below > changelogs.length / 2 ? 'HOLDS' : 'FAILS';
        console.log(
          `      "${h.piece.slug}" ranks ${ranks.get(h)} of ${rankable.length}; ` +
            `${below} of ${changelogs.length} changelog entries score HIGHER -> ${verdict}`,
        );
      }
      if (humans.length === 0) console.log('      no piece labelled provenance=human — cannot evaluate.');
    };

    report('(b) SEPARATION — composite aiLikenessScore:', (r) => r.meanScore);
    report('(c) PROVENANCE NOT GENRE — voice-driven tells per 100 words only:', (r) => r.density.voiceTellsPer100 ?? 0);

    console.log('\n  Reminder: (b) rests on n=1 human-edited piece. Directional, not inferential.');
    console.log('  Raw counts are never compared across collections; ranks and per-100w densities only.');

    // --- The readable comparison -------------------------------------------
    // Answers a different, narrower question than (a)/(b)/(c) above: does any
    // SINGLE tell category separate the provenance groups, visible by eye,
    // without collapsing everything into one composite score. Built entirely
    // from the already-archived StudyPiece records above — no LLM call.
    console.log(renderComparison(buildComparisonRows(pieces)));
    console.log(
      '\n  Note: findings are stored as per-category COUNTS only, not per-finding text or line',
    );
    console.log(
      '  numbers — this table cannot show whether a tell fired on the AI-drafted or the human-edited',
    );
    console.log(
      '  part of a mixed-provenance piece. Answering that needs `steward score` re-run with the',
    );
    console.log('  findings inspected directly (a fresh, disclosed API call), not this archive.\n');

    // --- The lever: the actual rubric sent to the model ---------------------
    const { loadRubric } = await import('./lib/llm.js');
    const rubric = await loadRubric('ai-tells');
    console.log(paint('  === RUBRIC — src/rubrics/ai-tells.md (the actual instructions sent to the LLM) ===', DIM));
    console.log(`  path: ${rubric.path}`);
    console.log(`  sha256: ${rubric.sha256}`);
    console.log(
      '  Versioned + hash-tracked (design rule 6): every archived run records this hash, so a verdict',
    );
    console.log('  can always be traced to the exact text that produced it. UNVALIDATED — spec §9.2: the');
    console.log('  composite score is substantially a length measurement (r = 0.813 vs word count).\n');
    console.log(rubric.content.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log('');
  });

program
  .command('dict-add')
  .argument('<word>')
  .description('Add a word to the Steward project dictionary (kept sorted, deduplicated)')
  .action(async (word: string) => {
    const { addWord } = await import('./lib/dictionary.js');
    const result = await addWord(word);
    console.log('');
    console.log(
      result.added
        ? `  Added "${result.word}" to the Steward dictionary.`
        : `  "${result.word}" is already in the dictionary — nothing to do.`,
    );
    console.log(`  ${result.configPath}`);
    console.log('');
  });

program
  .command('approve')
  .argument('<slug>')
  .option('--force', 'approve despite blocking findings')
  .description('Approve the review')
  .action(async (slug: string, opts: { force?: boolean }) => {
    const c = await client();
    const handle = c.workflow.getHandle(workflowIdFor(slug));
    // The phase gate is resolved HERE, by the caller, and travels in the signal
    // payload — the same pattern as `skipBuildAudit` in the input, and for the
    // same reason: the decision ends up in history, so a replay reproduces what
    // was actually decided rather than what the flag happens to say today. See
    // the `approve` signal's own docblock for why this one rides on the signal
    // rather than the input.
    await handle.signal(approveSignal, opts.force === true, ENABLE_PUBLISH_LEG);
    console.log(`  approve signal sent${opts.force ? ' (--force)' : ''}`);
    if (!ENABLE_PUBLISH_LEG) {
      console.log('  (publish leg disabled — the decision is recorded and the review completes)');
    }

    const state = await pollUntil(
      c,
      slug,
      (s) => TERMINAL.includes(s.state) || s.staleReason !== undefined,
      1000,
      // The publish leg's verification loop sleeps 90s between attempts and may
      // legitimately run for ~15 minutes before parking, so the approve poll
      // cannot use the two-minute budget that sufficed when approve was a
      // record-and-complete.
      ENABLE_PUBLISH_LEG ? 20 * 60 * 1000 : 2 * 60 * 1000,
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

program
  .command('up')
  .description('Start the Temporal dev server + worker together, health-gated, one foreground terminal')
  .action(async () => {
    const { startStack, printReadyBanner, teardownStack } = await import('./lib/stack.js');
    const stack = await startStack();
    printReadyBanner(stack);

    let tearingDown = false;
    const onSignal = () => {
      if (tearingDown) return;
      tearingDown = true;
      teardownStack(stack);
      process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // Either child dying on its own takes the other down with it — a lone
    // worker with no server, or a server with no worker polling it, is not a
    // stack worth staying up for.
    stack.server.once('exit', (code) => {
      if (tearingDown) return;
      tearingDown = true;
      console.error(`\n  server exited unexpectedly (code ${code})`);
      teardownStack(stack);
      process.exitCode = 1;
    });
    stack.worker.once('exit', (code) => {
      if (tearingDown) return;
      tearingDown = true;
      console.error(`\n  worker exited unexpectedly (code ${code})`);
      teardownStack(stack);
      process.exitCode = 1;
    });
  });

program
  .command('down')
  .description('Force-clean any stray steward worker/server processes and free 7233/8233')
  .action(async () => {
    const { killOrphans } = await import('./lib/stack.js');
    const n = await killOrphans();
    console.log(n === 0 ? '\n  Nothing to clean up.\n' : `\n  Killed ${n} process tree(s).\n`);
  });

program
  .command('scorecard')
  .option('--dry-run', 'audit and archive only — never opens or updates a PR (spec §4.2 step 4)')
  .option('--urls <csv>', 'comma-separated URL override; skips the live sitemap fetch')
  .option('--max-age-days <n>', 'staleness threshold for the publish gate', String(SCORECARD_MAX_AGE_DAYS_DEFAULT))
  .option('--date <yyyy-mm-dd>', 'pin the run\'s date instead of using today in STEWARD_TIMEZONE — for backfilling a run to when the audit actually happened')
  .description('Audit the live site (scorecard-audit-spec.md) and open a PR on change or staleness')
  .action(async (opts: { dryRun?: boolean; urls?: string; maxAgeDays: string; date?: string }) => {
    const maxAgeDays = Number(opts.maxAgeDays);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      fail(`--max-age-days must be a positive number, got "${opts.maxAgeDays}"`);
    }
    if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
      fail(`--date must be YYYY-MM-DD, got "${opts.date}"`);
    }
    const urls = opts.urls
      ? opts.urls.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    const c = await client();
    // Timestamped, not slug-keyed: unlike a review, a scorecard run has no
    // natural single-instance identity to collide on, and each run is its own
    // execution rather than something resumed via signal.
    const workflowId = `steward-scorecard-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    console.log(`\n  starting scorecard audit${opts.dryRun ? ' (dry run — will not publish)' : ''}...`);
    if (urls) console.log(`  URL override: ${urls.join(', ')}`);
    console.log('');

    const result = await c.workflow.execute(scorecardAuditWorkflow, {
      workflowId,
      taskQueue: QUEUE_LIGHT,
      // Decisions resolved HERE, by the CLI, and frozen into the workflow
      // input (design rule 3) — the sitemap URL, publish mode, and staleness
      // threshold are never re-read from config once the workflow starts.
      args: [
        {
          urls,
          sitemapUrl: SITEMAP_URL,
          publishMode: opts.dryRun ? ('dry-run' as const) : ('pr' as const),
          maxAgeDays,
          triggeredBy: 'manual' as const,
          timeZone: STEWARD_TIMEZONE,
          date: opts.date,
        },
      ],
    });

    console.log(`  decision: ${result.decision}`);
    console.log(`  reason:   ${result.reason}`);
    if (result.prUrl) console.log(`  PR:       ${result.prUrl}`);
    console.log(`  pages audited: ${result.perPage.length}\n`);
    for (const m of result.record.metrics) {
      console.log(`  ${m.name.padEnd(20)} ${`${m.value}/${m.maximum}`.padEnd(10)} ${m.status}`);
    }
    console.log('');
    await c.connection.close();
  });

program
  .command('scorecard-history')
  .option('--limit <n>', 'how many runs to show, newest first', '20')
  .description('Pretty-print the Scorecard run-log from disk — no live workflow needed')
  .action(async (opts: { limit: string }) => {
    const limit = Number(opts.limit);
    const runsPath = path.join(SITE_DIR, SCORECARD_RUNS_PATH);

    let runs: ScorecardRunRecord[];
    try {
      runs = JSON.parse(await fs.readFile(runsPath, 'utf8'));
    } catch (err) {
      fail(`Could not read ${runsPath}: ${String(err)}`);
    }

    const shown = runs.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20);
    console.log('');
    for (const run of shown) {
      const passing = run.metrics.filter((m) => m.status === 'Pass').length;
      console.log(
        `  ${run.id.padEnd(28)} ${run.iso}  ${passing}/${run.metrics.length} passing  ${run.entry}`,
      );
    }
    console.log(`\n  showing ${shown.length} of ${runs.length} run(s) total.\n`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
