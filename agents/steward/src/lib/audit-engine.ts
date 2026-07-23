import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import { STEWARD_DIR } from '../config.js';
import { runCancellable, killTree } from './proc.js';
import {
  lighthouseMetrics,
  agenticChecks,
  isExpectedDraftNonFinding,
  type AxeViolation,
  type LighthouseLike,
  type AgenticCheck,
} from './audit-map.js';

/**
 * The shared audit engine (scorecard-audit-spec.md §4.1) — `runAxe`,
 * `runLighthouse`, and `auditUrl`, extracted out of `build-audit.ts` so both
 * the Steward's per-draft `buildAndAuditDraft` and the Scorecard's per-live-URL
 * `auditLiveUrl` run the identical tool invocations. Only the *runner* is
 * shared (spec §2) — thresholds, aggregation, and the URL set stay
 * scorecard-specific and never live here.
 *
 * No Temporal imports here on purpose: this module is plain, testable
 * TypeScript. The activities that call it (`build-audit.ts`,
 * `activities/scorecard.ts`) own the Temporal `Context`/heartbeat concerns.
 */

/** Cache dir holding Chrome profiles. Shared with build-audit.ts's own sweep. */
const CACHE_DIR = path.join(STEWARD_DIR, '.cache');

/**
 * Runs `@axe-core/cli` against a served page.
 *
 * Moved verbatim from `build-audit.ts` (spec §4.1) — see that file's git
 * history for the two Windows-specific traps this already survived (`--save`
 * path joining, `.bin` shim `EINVAL`).
 */
export async function runAxe(
  url: string,
  signal: AbortSignal,
): Promise<{ violations: AxeViolation[]; raw: AxeViolation[] }> {
  const outDir = os.tmpdir();
  const outName = `steward-axe-${process.pid}-${Date.now()}.json`;
  const outFile = path.join(outDir, outName);

  const require = createRequire(import.meta.url);
  const axeCli = require.resolve('@axe-core/cli/dist/src/bin/cli.js');

  const res = await runCancellable(
    process.execPath,
    [axeCli, url, '--exit', '--save', outName, '--chrome-options', 'headless,no-sandbox,disable-gpu'],
    { signal, cwd: outDir },
  );

  let parsed: Array<{ violations?: AxeViolation[] }> = [];
  try {
    parsed = JSON.parse(await fs.readFile(outFile, 'utf8')) as Array<{ violations?: AxeViolation[] }>;
  } catch {
    throw new Error(`axe produced no result file (exit ${res.exitCode}):\n${res.stderr.slice(-2000)}`);
  } finally {
    await fs.rm(outFile, { force: true }).catch(() => {});
  }

  const raw = parsed.flatMap((r) => r.violations ?? []);
  return { violations: raw.filter((v) => !isExpectedDraftNonFinding(v)), raw };
}

/**
 * Launches Chrome, runs Lighthouse against `url`, and tears both down.
 *
 * Extracted from `build-audit.ts` step 6 verbatim in behaviour: same explicit
 * `userDataDir` (chrome-launcher's own default trips `EPERM` on Windows — see
 * the original comment, now here), same headless flags. `signal` is accepted
 * for interface symmetry with `runAxe` but — as in the code this was extracted
 * from — is not wired into the `lighthouse()` call itself, which was never
 * cancellable mid-run; cancellation was, and remains, cooperative via the
 * caller's own heartbeat/cleanup.
 */
export async function runLighthouse(url: string, _signal: AbortSignal): Promise<LighthouseLike> {
  const { launch } = await import('chrome-launcher');
  const userDataDir = path.join(CACHE_DIR, `chrome-${process.pid}-${Date.now()}`);
  await fs.mkdir(userDataDir, { recursive: true });
  const launched = await launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    userDataDir,
  });
  try {
    const { default: lighthouse } = await import('lighthouse');
    const runnerResult = await lighthouse(url, {
      port: launched.port,
      output: 'json',
      logLevel: 'error',
    });
    return (runnerResult?.lhr ?? {}) as LighthouseLike;
  } finally {
    // `try/await/catch`, not `Promise.resolve(fn()).catch()` — the latter
    // does NOT catch a *synchronous* throw from `kill()`, because the
    // exception fires while evaluating the argument, before `Promise.resolve`
    // is even reached. Found live running the Scorecard's concurrent fan-out
    // (4 Chrome instances launched at once, vs. build-audit's one-at-a-time):
    // a Chrome that died mid-gather made `kill()` throw synchronously trying
    // to read a debug log chrome-launcher expected but Chrome never wrote,
    // and the unhandled throw took down the entire worker process — not just
    // this one activity. `killTree`/`fs.rm` below get the same treatment for
    // the same reason.
    try {
      await launched.kill();
    } catch {
      /* best-effort — see above */
    }
    try {
      killTree(launched.pid);
    } catch {
      /* best-effort */
    }
    // After Chrome is down, not before — the profile dir is locked while it runs.
    try {
      await fs.rm(userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** The raw output of auditing one URL — both tools, mapped, undecorated by any threshold policy. */
export interface RawAudit {
  url: string;
  /** The full raw Lighthouse result. Callers needing a specific audit id (e.g. `is-crawlable`) read it directly rather than this module growing a new accessor per caller. Never leaves the activity (large-data rule) — see `agenticChecks` below for the compact summary that does. */
  lhr: LighthouseLike;
  scores: Record<string, number>;
  /** The four real Agentic Browsing checks (audit-map.ts's `agenticChecks`), compact enough to flow through the workflow — unlike `lhr`, this does. */
  agenticChecks: AgenticCheck[];
  failedAudits: string[];
  /** Already filtered (`isExpectedDraftNonFinding` removed). */
  axeViolations: AxeViolation[];
  /** How many raw axe violations the filter removed. */
  axeFiltered: number;
  durations: { axeMs: number; lighthouseMs: number };
}

/**
 * Runs both tools against `url` and returns the raw, unthresholded result.
 *
 * The one function both callers share: `buildAndAuditDraft` (one local draft)
 * and `auditLiveUrl` (every live URL, nightly). Everything downstream of this
 * — floors, floors' *values*, aggregation, findings vs. metrics — is caller
 * policy, per spec §2's "share the runner, not the job" rule.
 */
export async function auditUrl(url: string, signal: AbortSignal): Promise<RawAudit> {
  const axeStarted = Date.now();
  const { violations, raw: axeRaw } = await runAxe(url, signal);
  const axeMs = Date.now() - axeStarted;

  const lhStarted = Date.now();
  const lhr = await runLighthouse(url, signal);
  const lighthouseMs = Date.now() - lhStarted;

  const metrics = lighthouseMetrics(lhr, url);

  return {
    url,
    lhr,
    scores: metrics.scores,
    agenticChecks: agenticChecks(lhr),
    failedAudits: metrics.failedAudits ?? [],
    axeViolations: violations,
    axeFiltered: axeRaw.length - violations.length,
    durations: { axeMs, lighthouseMs },
  };
}
