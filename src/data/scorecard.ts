import { SCORECARD_VERIFIED, formatVerifiedLabel } from './sitemap-lastmod.mjs';
import scorecardRunsJson from './scorecard-runs.json' with { type: 'json' };

export type ScorecardStatus = 'Pass' | 'Partial' | 'Fail';
export type IsoTimestamp = `${number}-${number}-${number}T${number}:${number}:${number}${
  | 'Z'
  | `+${number}:${number}`
  | `-${number}:${number}`}`;

interface ScorecardVerification {
  iso: string;
  label: string;
  /** Exact ISO 8601 audit time. Omit when the run only has a calendar date. */
  timestamp?: IsoTimestamp;
}

export interface ScorecardMetric {
  name: string;
  value: string;
  maximum: string;
  status: ScorecardStatus;
  description: string;
}

export interface ScorecardSnapshot {
  description: string;
  verified: ScorecardVerification;
  scope: string;
  tools: readonly string[];
  entry: string;
  /** The latest run's machine-authored, human-editable commentary (scorecard-audit-spec.md rule 7). Empty when the run has none — the page falls back to a fixed default caption. */
  commentary: string;
  metrics: readonly ScorecardMetric[];
}

export interface ScorecardHistoryRun {
  id: string;
  verified: ScorecardVerification;
  scope: string;
  tools: readonly string[];
  entry: string;
  commentary: string;
  metrics: readonly ScorecardMetric[];
}

/**
 * The public run-log, as committed (scorecard-audit-spec.md §5.1) — newest
 * run first. `src/data/scorecard-runs.json` is the source of truth;
 * `SCORECARD` and `SCORECARD_HISTORY` below are pure derivations of it, kept
 * only because the rendered page (`scorecard.astro`) and `llms-full.txt.ts`
 * already consume these two exported shapes.
 */
export interface ScorecardRunRecord {
  id: string;
  iso: string;
  /** Full ISO 8601 audit time, when available. */
  timestamp?: IsoTimestamp;
  scope: string;
  tools: string[];
  entry: string;
  commentary: string;
  metrics: ScorecardMetric[];
}

const RUNS = scorecardRunsJson as ScorecardRunRecord[];

function toVerification(run: ScorecardRunRecord): ScorecardVerification {
  return {
    iso: run.iso,
    label: formatVerifiedLabel(run.iso),
    timestamp: run.timestamp,
  };
}

const [latest, ...history] = RUNS;

/**
 * This website's scores on the latest deploy — derived from `RUNS[0]`.
 *
 * `verified` deliberately reuses `SCORECARD_VERIFIED` from `sitemap-lastmod.mjs`
 * rather than recomputing it here: that module is the one place the sitemap's
 * `/scorecard/` lastmod and this page's visible date are guaranteed to agree,
 * and both now read the same `RUNS[0].iso`.
 */
export const SCORECARD: ScorecardSnapshot = {
  description: "This website's scores on the latest deploy.",
  verified: SCORECARD_VERIFIED,
  scope: latest.scope,
  tools: latest.tools,
  entry: latest.entry,
  commentary: latest.commentary,
  metrics: latest.metrics,
};

/** Every run older than the latest, newest first — derived from `RUNS.slice(1)`. */
export const SCORECARD_HISTORY: readonly ScorecardHistoryRun[] = history.map((run) => ({
  id: run.id,
  verified: toVerification(run),
  scope: run.scope,
  tools: run.tools,
  entry: run.entry,
  commentary: run.commentary,
  metrics: run.metrics,
}));
