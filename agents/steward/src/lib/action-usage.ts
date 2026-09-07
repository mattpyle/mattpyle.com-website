import { METRICS_API_KEY, METRICS_ENDPOINT, NAMESPACE } from '../config.js';

/**
 * One minute of the namespace's action rate, read from the Temporal Cloud
 * OpenMetrics endpoint.
 *
 * ## What a sample is, and what it is not
 *
 * Every metric on that endpoint is a **per-second rate averaged over one
 * minute**. A sample is therefore a snapshot of how hard the namespace is
 * working right now; it is not a day's spend, and no number of samples adds up
 * to one. Spend accounting stays on the Cloud usage page, which is the record.
 *
 * That is enough for the alert this exists for. A runaway workflow loop is a
 * *sustained* rate, so any sample taken during one reads hot, and the thing the
 * nightly check is watching for is precisely the loop that would otherwise run
 * for a week before somebody looked at the usage page.
 *
 * ## Why the parser is written here
 *
 * Two metric families out of the fourteen the endpoint emits, in a text format
 * of one line per series. A Prometheus text parser would be a dependency for the
 * worker image to carry, an import graph to keep an eye on, and a supply-chain
 * surface, all for a `line.split` — so the two families this needs are parsed by
 * hand and everything else on the endpoint is ignored without being understood.
 *
 * ## Why the namespace filter is not optional
 *
 * The key is account-level, because that is the only scope the Metrics
 * Read-Only role has. The endpoint therefore returns every namespace on the
 * account, and a sampler that summed what it was given would alert Steward
 * about a rate some other project's namespace was burning. Every series is kept
 * or dropped on its `temporal_namespace` label against `NAMESPACE`.
 */

/** How long to wait for the endpoint. It answers in well under a second. */
const SCRAPE_TIMEOUT_MS = 10_000;

const TOTAL_FAMILY = 'temporal_cloud_v1_total_action_count';
const BILLABLE_FAMILY = 'temporal_cloud_v1_billable_action_count';

/** One billable series: what kind of action, which workflow type, how fast. */
export interface BillableActionRow {
  actionType: string;
  workflowType: string;
  /** Actions per second, averaged over the sampled minute. */
  rate: number;
}

/** What one scrape saw of one namespace. */
export interface ActionUsageSample {
  namespace: string;
  /**
   * Foreground actions per second: the `is_background="false"` series of the
   * total family, summed. Background actions are Temporal's own housekeeping
   * and are not what a runaway loop shows up in.
   */
  foregroundPerSecond: number;
  /** Billable series for this namespace, fastest first. */
  billable: BillableActionRow[];
  /** True when the namespace emitted no series in either family at all. */
  idle: boolean;
}

/**
 * A series line: `name{label="value",…} 1.234 1788763560`.
 *
 * Returns null for anything that is not a series of `family` — comments, blank
 * lines, and the other twelve families, which is most of the response.
 */
function parseSeries(line: string, family: string): { labels: Record<string, string>; value: number } | null {
  if (!line.startsWith(family)) return null;
  const open = line.indexOf('{');
  // `family` is a prefix of nothing else on this endpoint today, but a future
  // `…_action_count_total` would match the `startsWith` above and mean
  // something different. The character after the name has to end it.
  if (open !== family.length) return null;
  const close = line.lastIndexOf('}');
  if (close < open) return null;

  const labels: Record<string, string> = {};
  // Label order is not part of the format, so this reads pairs rather than
  // positions. Values are quoted and the endpoint emits no escaped quotes in
  // them; a value that did would truncate here rather than corrupt a number.
  const labelText = line.slice(open + 1, close);
  for (const match of labelText.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g)) {
    labels[match[1]] = match[2];
  }

  // `<value> <timestamp>` after the closing brace. The timestamp is discarded:
  // the endpoint's own window is the sample's time, and a scrape that returned
  // a stale minute would still be the freshest thing available.
  const value = Number.parseFloat(line.slice(close + 1).trim().split(/\s+/)[0] ?? '');
  if (!Number.isFinite(value)) return null;
  return { labels, value };
}

/**
 * The sample, from raw OpenMetrics text.
 *
 * Separated from the fetch so the parsing rules are unit tests against captured
 * endpoint text rather than something only a live key can exercise.
 *
 * **An empty result is a valid sample, not an error.** The endpoint emits no
 * series at all for a family with nothing to report, so an idle minute — which
 * is most minutes in this namespace — legitimately parses to zero. `idle` says
 * which of the two it was, so the ping body can tell the operator "nothing was
 * running" rather than implying a measurement of zero.
 */
export function parseActionUsage(text: string, namespace: string): ActionUsageSample {
  let foregroundPerSecond = 0;
  const billable: BillableActionRow[] = [];
  let sawAny = false;

  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;

    const total = parseSeries(line, TOTAL_FAMILY);
    if (total) {
      if (total.labels.temporal_namespace !== namespace) continue;
      sawAny = true;
      // Summed rather than taken: the family is split by `is_background` and
      // `namespace_mode`, so an active namespace emits several foreground
      // series and the rate that matters is all of them together.
      if (total.labels.is_background === 'false') foregroundPerSecond += total.value;
      continue;
    }

    const billableSeries = parseSeries(line, BILLABLE_FAMILY);
    if (billableSeries) {
      if (billableSeries.labels.temporal_namespace !== namespace) continue;
      sawAny = true;
      billable.push({
        actionType: billableSeries.labels.action_type ?? 'unknown',
        workflowType: billableSeries.labels.temporal_workflow_type ?? 'unknown',
        rate: billableSeries.value,
      });
    }
  }

  // Fastest first, and by name where rates tie, so the top-three the alert body
  // names is the same three every time for the same scrape.
  billable.sort((a, b) => b.rate - a.rate || a.workflowType.localeCompare(b.workflowType));

  return { namespace, foregroundPerSecond, billable, idle: !sawAny };
}

/** A sample that could not be taken, with the reason a person can act on. */
export class ActionUsageSampleError extends Error {
  readonly name = 'ActionUsageSampleError';
}

/**
 * Scrapes the endpoint and returns this namespace's sample.
 *
 * Throws rather than returning a degraded sample: a sample that could not be
 * taken is its own alert (card decision 4), and the caller — one activity — is
 * the place that turns it into a fail ping. Returning zeros here would be
 * indistinguishable from a quiet namespace, which is the one thing this must
 * never say when it does not know.
 */
export async function sampleActionUsage(
  namespace: string = NAMESPACE,
  key: string = METRICS_API_KEY,
): Promise<ActionUsageSample> {
  if (!key) {
    throw new ActionUsageSampleError('TEMPORAL_METRICS_API_KEY is unset');
  }

  let response: Response;
  try {
    response = await fetch(METRICS_ENDPOINT, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ActionUsageSampleError(
      `the metrics endpoint could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    // The body is Temporal's own error text and is short; it is the difference
    // between an expired key and a role that lost its permission, and the
    // operator reading the alert email needs to know which.
    const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
    throw new ActionUsageSampleError(
      `the metrics endpoint answered ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  const text = await response.text();
  // An empty *body* is not an idle minute — the endpoint emits its `# TYPE`
  // comments even when every family is quiet, so nothing at all means the
  // response was not what this parser understands.
  if (text.trim() === '') {
    throw new ActionUsageSampleError('the metrics endpoint returned an empty body');
  }
  return parseActionUsage(text, namespace);
}
