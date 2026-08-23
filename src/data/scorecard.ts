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
  description: 'Live Lighthouse accessibility, performance, and SEO scores for this site, plus agentic browsing checks, with the full history of every run.',
  verified: SCORECARD_VERIFIED,
  scope: latest.scope,
  tools: latest.tools,
  entry: latest.entry,
  commentary: latest.commentary,
  metrics: latest.metrics,
};

/**
 * The latest run's exact audit instant, when it has one.
 *
 * `SCORECARD.verified` deliberately reuses `SCORECARD_VERIFIED` from sitemap-lastmod.mjs so the
 * sitemap's lastmod and the visible date cannot drift, and that object carries a calendar date and
 * nothing finer. /scorecard's provenance line needs the time and the zone, which only the run
 * record has — hence this second export rather than a widened `verified`, which would put a field
 * on the shape the sitemap has no business knowing about.
 */
export const SCORECARD_TIMESTAMP: IsoTimestamp | undefined = latest.timestamp;

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

/** One gate as the two redesigned surfaces render it. */
export interface ScorecardGate {
  /** The metric's name, lower-cased, as the homepage panel labels it. */
  name: string;
  /** The metric's name as authored, for a surface that wants sentence case. */
  label: string;
  /** Printable score: a bare number out of 100, a `value/maximum` otherwise. */
  score: string;
  /** Numeric value and maximum, for a `<progress>` element. Never NaN, never 0 maximum. */
  value: number;
  maximum: number;
  status: ScorecardStatus;
}

/**
 * The gate derivation both redesigned scorecard surfaces render from.
 *
 * It lived in `HomeAgents.astro` until /scorecard was rebuilt on the same design
 * (docs/projects/redesign/design-export-remaining/design_handoff_scorecard), whose spec says the
 * page "must not duplicate that logic; share it". The rule it carries is the denominator one: a
 * score out of 100 reads as a bare number, and anything else keeps its denominator, because "4"
 * on its own is not a score. The homepage panel and the page it links to cannot disagree about a
 * run while both call this.
 *
 * @param {readonly ScorecardMetric[]} metrics defaults to the latest run's
 */
export function scorecardGates(metrics: readonly ScorecardMetric[] = SCORECARD.metrics): ScorecardGate[] {
  return metrics.map((metric) => {
    const value = Number(metric.value);
    const maximum = Number(metric.maximum);
    return {
      name: metric.name.toLowerCase(),
      label: metric.name,
      score: maximum === 100 ? metric.value : `${metric.value}/${metric.maximum}`,
      value: Number.isFinite(value) ? value : 0,
      maximum: Number.isFinite(maximum) && maximum > 0 ? maximum : 1,
      status: metric.status,
    };
  });
}

/** How many of a run's gates passed. Printed as "N of M" on both surfaces. */
export function passingGates(metrics: readonly ScorecardMetric[] = SCORECARD.metrics): number {
  return metrics.filter((metric) => metric.status === 'Pass').length;
}
