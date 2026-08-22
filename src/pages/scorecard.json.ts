import type { APIRoute } from 'astro';
import scorecardRuns from '../data/scorecard-runs.json' with { type: 'json' };
import { SCORECARD, passingGates, scorecardGates, type ScorecardRunRecord } from '../data/scorecard';
import { SITE_ORIGIN } from '../data/site-origin.mjs';

/**
 * /scorecard.json — the same numbers /scorecard displays, as data.
 *
 * Both bundles in docs/projects/redesign/design-export-remaining end their last band with a "The
 * same numbers, as data" block, and this is /scorecard's half of it. Confirmed with Matt
 * 2026-08-22.
 *
 * ONE DERIVATION PER SURFACE, TWO RENDERS. The page and this endpoint both call `scorecardGates()`
 * and `passingGates()` from src/data/scorecard.ts, which is the same pair the homepage panel
 * calls. An endpoint that recomputed a score would be a third copy of the denominator rule and the
 * one nobody looks at.
 *
 * Prerendered, because src/data/scorecard-runs.json is committed: the file changes when a nightly
 * run lands, and a run landing is a deploy. /activity.json is the opposite case and renders per
 * request.
 *
 * The shape is the run-log's own, plus the two derived fields the page shows and a consumer would
 * otherwise have to re-derive: `score`, which carries the denominator rule, and `gatesPassing`.
 * Nothing is renamed on the way out — a reader comparing this to src/data/scorecard-runs.json
 * should not have to translate.
 */
export const prerender = true;

const RUNS = scorecardRuns as ScorecardRunRecord[];

const CANONICAL = `${SITE_ORIGIN}/scorecard/`;

function serialiseRun(run: ScorecardRunRecord) {
  return {
    id: run.id,
    date: run.iso,
    timestamp: run.timestamp ?? null,
    scope: run.scope,
    tools: run.tools,
    entry: run.entry,
    commentary: run.commentary,
    gatesPassing: passingGates(run.metrics),
    gateCount: run.metrics.length,
    gates: scorecardGates(run.metrics).map((gate, index) => ({
      name: gate.label,
      score: gate.score,
      value: gate.value,
      maximum: gate.maximum,
      status: gate.status,
      description: run.metrics[index].description,
    })),
  };
}

export const GET: APIRoute = () => {
  const body = {
    source: CANONICAL,
    description: SCORECARD.description,
    // Every run, newest first — the same list the page prints in full. There is no "all runs" page
    // and no per-run detail page, so this is the only place a machine can read the whole log.
    runs: RUNS.map(serialiseRun),
  };

  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Link: `<${CANONICAL}>; rel="canonical"`,
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
