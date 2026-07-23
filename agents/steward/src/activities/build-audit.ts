import path from 'node:path';
import fs from 'node:fs/promises';
import { Context, CancelledFailure } from '@temporalio/activity';
import {
  REPO_ROOT,
  STEWARD_DIR,
  WORKTREE_DIR,
  postRelPath,
  urlPathFor,
  type Collection,
} from '../config.js';
import { syncWorktree, needsInstall, recordInstall } from '../lib/git.js';
import { runCancellable } from '../lib/proc.js';
import { serveStatic, type StaticServer } from '../lib/serve.js';
import { auditUrl } from '../lib/audit-engine.js';
import {
  axeFindings,
  lighthouseFindings,
  overallVerdict,
  isExpectedDraftSeoPenalty,
} from '../lib/audit-map.js';
import type { Finding, PassResult } from '../lib/report.js';
import { log } from '../lib/logger.js';

/**
 * `buildAndAuditDraft` (spec §8.5) — the heavy-queue activity.
 *
 * The check that exists nowhere else on this site: drafts are excluded from the
 * production build, so no draft has ever been audited. This builds one with
 * `SHOW_DRAFTS=true`, serves it, and runs axe and Lighthouse against the real
 * rendered page.
 *
 * **Why this activity is shaped the way it is.** It is minutes long and spawns
 * child processes, which makes it the first activity in this codebase where the
 * Temporal cancellation rules actually bite:
 *
 * - **Heartbeat between every step.** Cancellation is *delivered* via heartbeat
 *   (skill: gotchas, "Not Handling Activity Cancellation"), so an activity that
 *   never heartbeats can never learn it was cancelled. It also lets the server
 *   detect a wedged build long before `startToCloseTimeout`.
 * - **Children die with the activity.** `runCancellable` is wired to the
 *   activity's `cancellationSignal`, and `killTree` takes down the whole process
 *   tree — on Windows, killing `npm` leaves the `node` it spawned running.
 * - **Cleanup in `finally`, unconditionally.** The static server and any Chrome
 *   launched by Lighthouse are torn down whether the activity succeeded, threw,
 *   or was cancelled. Orphaned Chrome processes are exactly what this phase's
 *   verification checks for.
 *
 * A cancelled activity rethrows `CancelledFailure` after cleanup rather than
 * swallowing it: swallowing would report a bogus "pass" for work that never ran.
 */

/**
 * How to run npm without a shell, on Windows.
 *
 * `spawn('npm.cmd', …, { shell: false })` fails with `EINVAL` on modern Node:
 * the fix for CVE-2024-27980 made it refuse to launch `.cmd`/`.bat` files
 * without a shell, because argument escaping for batch files is not safely
 * expressible. Design rule 8 forbids `shell: true`, so neither half of that
 * trade is available.
 *
 * The way out is to skip the shim entirely and run npm's own JS entrypoint under
 * the Node binary already executing this worker. No shell, no batch file, no
 * argument-escaping hazard — and it pins npm to the same Node the rest of the
 * Steward runs on rather than whatever PATH resolves to.
 *
 * Found live: the first audited review failed with `spawn EINVAL` and degraded
 * to a tool-failure flag, which is how the workflow's `guard` is supposed to
 * behave, but the audit itself produced nothing.
 */
function npmCommand(args: string[]): { binary: string; args: string[] } {
  if (process.platform !== 'win32') return { binary: 'npm', args };
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { binary: process.execPath, args: [npmCli, ...args] };
}
const INSTALL_STATE = path.join(STEWARD_DIR, '.cache', 'worktree-install.json');


/** Where the Vercel adapter actually puts the static output. Not `dist/`. */
const DOC_ROOT = path.join('dist', 'client');

export async function buildAndAuditDraft(
  slug: string,
  collection: Collection = 'writing',
): Promise<PassResult> {
  const ctx = Context.current();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const file = postRelPath(slug, collection);
  const signal = ctx.cancellationSignal;

  let server: StaticServer | undefined;

  /**
   * Heartbeating between steps is not enough here.
   *
   * `heartbeatTimeout` is 30s, but `npm ci` and the Astro build each run for
   * *minutes* as a single uninterruptible await. Heartbeats placed only between
   * steps leave gaps far longer than the timeout, so the server would declare
   * the activity dead and retry it mid-build — a self-inflicted infinite retry
   * that looks exactly like a hung build. A background pump keeps the channel
   * alive during the long awaits, which is also what keeps cancellation
   * *deliverable* while a build is in flight.
   */
  let phase = 'starting';
  const pump = setInterval(() => ctx.heartbeat(phase), 5_000);
  const step = (name: string) => {
    phase = name;
    ctx.heartbeat(name);
  };

  try {
    // --- 0. Sweep stale Chrome profiles -----------------------------------
    // The `finally` below deletes this run's profile dir, but it cannot cover
    // two cases: a SIGKILLed worker never runs `finally` at all, and even on the
    // happy path the delete sometimes loses a race with Chrome's own file locks
    // and is swallowed. Observed live — six leftover profile dirs after this
    // session's runs. Sweeping on entry is the only cleanup that covers a kill.
    await sweepStaleProfiles();

    // --- 1. Worktree ------------------------------------------------------
    step('syncing worktree');
    const sync = await syncWorktree(REPO_ROOT, WORKTREE_DIR, file);
    log.info({ slug, sha: sync.sha, created: sync.created }, 'worktree synced');

    // --- 2. npm ci (lockfile-hash cached) ---------------------------------
    step('checking dependencies');
    const install = await needsInstall(WORKTREE_DIR, INSTALL_STATE);
    if (install.needed) {
      step('npm ci');
      const ci = npmCommand(['ci']);
      const res = await runCancellable(ci.binary, ci.args, { cwd: WORKTREE_DIR, signal });
      if (res.exitCode !== 0) {
        throw new Error(`npm ci failed (exit ${res.exitCode}):\n${res.stderr.slice(-4000)}`);
      }
      await recordInstall(INSTALL_STATE, install.hash);
    }

    // --- 3. Build with drafts visible -------------------------------------
    step('building (SHOW_DRAFTS=true)');
    const buildStarted = Date.now();
    // Env via the spawn options, never a shell `VAR=x` prefix — that syntax does
    // not exist on Windows and there is no shell here by design (design rule 8).
    const runBuild = npmCommand(['run', 'build']);
    const build = await runCancellable(runBuild.binary, runBuild.args, {
      cwd: WORKTREE_DIR,
      env: { SHOW_DRAFTS: 'true' },
      signal,
    });
    if (build.exitCode !== 0) {
      throw new Error(`SHOW_DRAFTS build failed (exit ${build.exitCode}):\n${build.stderr.slice(-4000)}`);
    }
    const buildMs = Date.now() - buildStarted;

    // A draft that built but emitted no page is a real finding, and a clearer
    // one than whatever 404 the auditors would report downstream. This guard is
    // also the thing standing between a wrong per-collection URL and an audit
    // that silently scores a 404 page — it must stay ahead of the serve step.
    const urlPath = urlPathFor(slug, collection);
    const pageDir = path.join(WORKTREE_DIR, DOC_ROOT, collection, slug);
    try {
      await fs.stat(path.join(pageDir, 'index.html'));
    } catch {
      throw new Error(
        `Build succeeded but ${DOC_ROOT}${urlPath}index.html was not emitted. ` +
          `Is the ${collection} entry present, and (in gate mode) draft:true with SHOW_DRAFTS honoured?`,
      );
    }

    // --- 4. Serve ---------------------------------------------------------
    step('starting static server');
    server = await serveStatic(path.join(WORKTREE_DIR, DOC_ROOT));
    const url = `${server.origin}${urlPath}`;

    // --- 5+6. axe + Lighthouse, via the shared engine (spec §4.1) ---------
    step('running axe + Lighthouse');
    const raw = await auditUrl(url, signal);

    // --- 7. Map to findings ----------------------------------------------
    step('mapping results');
    const findings: Finding[] = [
      ...axeFindings(raw.axeViolations, file, url),
      ...lighthouseFindings(raw.scores, file, url, {
        suppressSeo: isExpectedDraftSeoPenalty(raw.lhr),
      }),
    ];

    return {
      pass: 'build_audit',
      verdict: overallVerdict(findings),
      findings,
      startedAt,
      durationMs: Date.now() - started,
      metrics: {
        url: raw.url,
        scores: raw.scores,
        agenticChecks: raw.agenticChecks,
        failedAudits: raw.failedAudits,
        axeViolations: raw.axeViolations.length,
        axeFiltered: raw.axeFiltered,
        buildMs,
        axeMs: raw.durations.axeMs,
        lighthouseMs: raw.durations.lighthouseMs,
        worktreeSha: sync.sha,
        npmCi: install.needed,
      },
    };
  } catch (err) {
    if (err instanceof CancelledFailure) {
      log.warn({ slug }, 'build audit cancelled; tearing down children');
    }
    throw err;
  } finally {
    // Guaranteed cleanup (spec §8.5 step 7). Never let a teardown failure mask
    // the real error that got us here. Chrome/Lighthouse teardown now lives
    // inside `runLighthouse` (audit-engine.ts) itself, in its own `finally` —
    // the static server is the only resource this activity still owns directly.
    await server?.close().catch(() => {});
  }
}

/** Cache dir holding Chrome profiles and the npm-ci lockfile hash. */
const CACHE_DIR = path.join(STEWARD_DIR, '.cache');

/**
 * Deletes Chrome profile directories left behind by earlier runs.
 *
 * Best-effort by design: a directory still held by a live Chrome will refuse to
 * delete, and that is the correct outcome — it means an audit is in flight, and
 * the next run will collect it instead.
 */
async function sweepStaleProfiles(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(CACHE_DIR);
  } catch {
    return; // no cache dir yet
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith('chrome-'))
      .map((name) => fs.rm(path.join(CACHE_DIR, name), { recursive: true, force: true }).catch(() => {})),
  );
}
