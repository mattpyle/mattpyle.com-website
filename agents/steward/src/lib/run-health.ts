/**
 * What "this run went wrong" means, and where the alert about it goes.
 *
 * The whole of the alerting decision, with no network and no environment in it,
 * so every rule below is a unit test rather than a thing that has to be
 * observed happening at 03:30. `lib/health-ping.ts` sends what this decides.
 *
 * ## Why a result-shape rule exists at all
 *
 * The hosted worker's first day (build-log entry 30, postscript 2) produced two
 * failures and **both were success-shaped**. A deep audit rendered its page,
 * discarded it, retried, discarded it again, and completed carrying
 * `browserPages=0`. A scorecard measured 23 pages with every axe run failing and
 * was ready to publish "pages could not be audited" as though it were a
 * measurement of the site. A liveness check would have called the service
 * healthy through both, because the service *was* alive; what failed was the
 * result. So the signal is read off the run's own record, which already knows
 * both facts and costs nothing to consult.
 *
 * ## Four fixed signals, one per-site family, one transport
 *
 * The transport is an external dead-man's-switch service (healthchecks.io),
 * authorised on the card 2026-08-15, because nothing else in this stack can send
 * an email. Each signal is one check there:
 *
 * | Signal | Means | Pinged by |
 * |---|---|---|
 * | `nightly-scorecard` | a good nightly scorecard run happened | the scheduled run, success and failure both |
 * | `action-usage` | the namespace is not burning Temporal Cloud actions at a runaway rate | the scheduled run |
 * | `run-shape` | a completed run's record is right (success) or wrong (fail); no period | a manual scorecard run, and any deep audit, healthy or bad |
 * | `findings-reconcile` | the hourly findings reconciler ran | `reconcileFindingsWorkflow`, success and failure both |
 * | `findings-recheck:<site>` | the daily recheck of that site's approved findings ran | `recheckFindingsWorkflow`, success and failure both |
 *
 * The first two, `findings-reconcile` and each `findings-recheck:<site>` carry the dead-man's half: a worker that never runs sends
 * nothing, the check's own period lapses, and the service emails about the
 * silence. That is the failure a liveness ping cannot detect from inside a dead
 * container. `run-shape` has no period — a deep audit is ad hoc, so "no deep
 * audit today" is not news. It is fail-and-recover rather than fail-only: a
 * healthy run sends a success ping, so the next good run clears a fail ping
 * instead of leaving the check down until an operator resumes it. A manual run
 * never pings `nightly-scorecard`, so this cannot hold the dead-man's switch down.
 */

import type { ActionUsageSample } from './action-usage.js';
import { lighthouseVersionCounts } from './scorecard-aggregate.js';
import { renderedNothing } from './agent-audit/report-shape.js';
import { summariseRecheck, type RecheckFindingsResult } from './findings-recheck.js';

/** The signals with one check each, fixed in code. */
export type FixedHealthSignal =
  | 'nightly-scorecard'
  | 'action-usage'
  | 'run-shape'
  | 'findings-reconcile';

/** The family key in `HEALTH_CHECK_SLUGS` for the per-site recheck checks. */
const RECHECK_FAMILY = 'findings-recheck';

/**
 * The recheck's signal for one site: `findings-recheck:temporal-io`. A Schedule
 * is per site, so each site gets its own check, and a second site's silence
 * names that site in the email.
 */
export type FindingsRecheckSignal = `${typeof RECHECK_FAMILY}:${string}`;

/** One check at the alerting service. */
export type HealthSignal = FixedHealthSignal | FindingsRecheckSignal;

/** The signal a site's recheck pings. */
export function findingsRecheckSignal(site: string): FindingsRecheckSignal {
  return `${RECHECK_FAMILY}:${site}`;
}

/**
 * The slug each fixed signal pings, which is also the check's name in the service's
 * dashboard. Slugs rather than per-check UUIDs so the whole transport is **one**
 * configuration value (`STEWARD_HEALTHCHECK_BASE`, a project ping key) in the
 * two places it has to be set. `action-usage`, added 2026-09-06, is the proof:
 * it cost a row here and no new transport configuration at all. The check has to
 * be created in the service under the same slug, though — the code never creates
 * one on the fly (`lib/health-ping.ts`), so a new row here is half a change.
 *
 * The recheck's row is a prefix, not a slug: its check is per site, so
 * `healthCheckSlug` appends `-<site>`.
 */
export const HEALTH_CHECK_SLUGS: Record<FixedHealthSignal | typeof RECHECK_FAMILY, string> = {
  'nightly-scorecard': 'steward-nightly-scorecard',
  'action-usage': 'steward-action-usage',
  'run-shape': 'steward-run-shape',
  // Hourly, from `reconcileFindingsWorkflow`: success and failure both, so a
  // reconciler that stops running goes late at the service (period 1h, grace 30m).
  'findings-reconcile': 'steward-findings-reconcile',
  // Daily, from `recheckFindingsWorkflow`, one check per site (period 1 day,
  // grace 1 hour). The site is appended: `steward-findings-recheck-temporal-io`.
  [RECHECK_FAMILY]: 'steward-findings-recheck',
};

/** The slug a signal pings: a fixed row, or `steward-findings-recheck-<site>`. */
export function healthCheckSlug(signal: HealthSignal): string {
  const prefix = `${RECHECK_FAMILY}:`;
  if (signal.startsWith(prefix)) return `${HEALTH_CHECK_SLUGS[RECHECK_FAMILY]}-${signal.slice(prefix.length)}`;
  return HEALTH_CHECK_SLUGS[signal as FixedHealthSignal];
}

/**
 * `<base>/<slug>` for a healthy run, `<base>/<slug>/fail` for a bad one.
 *
 * Explicit rather than relying on the check going late: a run that finished and
 * finished wrong should raise the alert now, not in two hours when the window
 * lapses, and a failure the operator can read a reason for beats one they have
 * to go and diagnose.
 */
export function healthPingUrl(base: string, signal: HealthSignal, ok: boolean): string {
  const trimmed = base.replace(/\/+$/, '');
  const slug = healthCheckSlug(signal);
  return ok ? `${trimmed}/${slug}` : `${trimmed}/${slug}/fail`;
}

/**
 * A verdict about one run. `summary` is the ping's body, which the service
 * quotes verbatim in the notification email, so it is written to be read there
 * with no other context: what ran, what was wrong with it, and where to look.
 */
export interface RunShape {
  ok: boolean;
  summary: string;
}

export interface ScorecardShapeInput {
  /** One entry per audited page. */
  pages: Array<{ url: string; ok: boolean; error?: string; lighthouseVersion?: string }>;
  /** `open-pr` or `no-op`, for the healthy summary. */
  decision: string;
  /** The run's calendar day. */
  iso: string;
  /** What the merge leg did with the run-log pull request. Absent when the run never reached it. */
  merge?: ScorecardMergeShape;
}

/**
 * The merge leg's outcome as the shape rule reads it: merged, refused for a named
 * condition, or an activity that threw after its retries. `condition` is a
 * `MergeRefusalCondition` or `'error'`.
 */
export type ScorecardMergeShape =
  | { merged: true; mergeSha: string; prUrl: string }
  | { merged: false; condition: string; detail: string; prUrl: string };

/**
 * The scorecard's rule, from the card: **a completed run with a failed-page
 * count above zero is a bad shape.**
 *
 * Not "most pages failed" and not a ratio. A single page the audit could not
 * measure already blocks a green scorecard by design (`buildCommentary`), so the
 * run's own publish logic and this rule agree on what a defect is.
 *
 * "No pages" is guarded twice, on two different counts:
 *
 * 1. Before the fan-out, `checkAuditSet` counts the URLs resolved from the
 *    sitemap. Zero fails the run outright, and the failure path alerts on it.
 * 2. After the fan-out, the workflow counts the pages actually audited. Zero
 *    means every page errored: the run measured the worker, not the site, so it
 *    opens no run-log PR and this rule says so in the summary.
 *
 * A partial failure keeps its wording, because that run may still open a PR.
 */
export function scorecardRunShape(input: ScorecardShapeInput): RunShape {
  const base = scorecardPagesAndVersionsShape(input);
  const merge = input.merge;
  if (!merge) return base;
  if (merge.merged) {
    return { ok: base.ok, summary: `${base.summary} Run-log PR ${merge.prUrl} merged as ${merge.mergeSha}.` };
  }
  // The run and its archive are good, so the reason says what to do with the PR.
  // A refusal makes the run unhealthy whatever the pages did.
  return {
    ok: false,
    summary:
      `Scorecard ${input.iso} completed but Steward did not merge its run-log PR (${merge.condition}): ` +
      `${merge.detail}. PR: ${merge.prUrl}. The run and its archive are good; the PR stays open, so ` +
      'check it and merge it by hand.' +
      (base.ok ? '' : ` ${base.summary}`),
  };
}

function scorecardPagesAndVersionsShape(input: ScorecardShapeInput): RunShape {
  const versions = lighthouseVersionCounts(input.pages);
  if (versions.length > 1) {
    const named = versions.map((v) => `Lighthouse ${v.version} on ${v.pages} page(s)`).join(', ');
    const base = pagesShape(input);
    return {
      ok: false,
      summary:
        `Scorecard ${input.iso} completed but its pages were measured by different Lighthouse versions: ${named}. ` +
        'The two workers on steward-audit disagree about the install; run `npm ci` on the one that is stale ' +
        '(the local worker refuses to start on a mismatch, so a worker started before that guard is the likely one). ' +
        'No run-log PR opened; the per-run record is archived.' +
        (base.ok ? '' : ` ${base.summary}`),
    };
  }
  return pagesShape(input);
}

function pagesShape(input: ScorecardShapeInput): RunShape {
  const failed = input.pages.filter((p) => !p.ok);
  if (failed.length === 0) {
    return {
      ok: true,
      summary:
        `Scorecard ${input.iso}: ${input.pages.length} page(s) audited, none failed, ` +
        `decision ${input.decision}.`,
    };
  }
  const named = failed.slice(0, 5).map((p) => `${p.url}${p.error ? ` (${p.error})` : ''}`);
  const rest = failed.length > named.length ? `, and ${failed.length - named.length} more` : '';
  if (failed.length === input.pages.length) {
    return {
      ok: false,
      summary:
        `Scorecard ${input.iso} completed but 0 of ${input.pages.length} page(s) could be ` +
        `audited: ${named.join('; ')}${rest}. The auditor read no page, so the run measured ` +
        'the worker, not the site. No run-log PR opened; the per-run record is archived with ' +
        'each page\'s error. Check the hosted worker\'s logs.',
    };
  }
  return {
    ok: false,
    summary:
      `Scorecard ${input.iso} completed but ${failed.length} of ${input.pages.length} page(s) ` +
      `could not be audited: ${named.join('; ')}${rest}. The run finished, so nothing else will ` +
      'report this. Check the hosted worker\'s logs before trusting the numbers, and expect the ' +
      'run-log PR (if one opened) to record a measurement of the auditor rather than of the site.',
  };
}

/**
 * The recheck's rule: **a completed run with any `write failed` or
 * `could not measure` row is a bad shape.**
 *
 * Both are success-shaped failures, the kind this file exists to catch. A write
 * that failed is Steward's GitHub path failing, and a check that could not be
 * measured is production, the browser or the block failing to answer; each
 * leaves the finding's file as it was, so `live_on` goes stale while the run
 * reports success. `no checks`, `has an open run` and `skipped` are not
 * failures: nothing was owed on those rows.
 *
 * The body starts with the run's one-line summary and then names the rows, up to
 * five, so the email reads without opening Temporal.
 */
export function recheckShape(result: RecheckFindingsResult): RunShape {
  const base = summariseRecheck(result);
  const bad = result.rows.filter((row) => row.outcome === 'write failed' || row.outcome === 'could not measure');
  if (bad.length === 0) return { ok: true, summary: base };
  const named = bad.slice(0, 5).map((row) => `${row.keyShort ?? row.key} ${row.outcome}${row.detail ? ` (${row.detail})` : ''}`);
  const rest = bad.length > named.length ? `, and ${bad.length - named.length} more` : '';
  return {
    ok: false,
    summary:
      `${base} ${bad.length} of ${result.rows.length} finding(s) were not rechecked cleanly: ` +
      `${named.join('; ')}${rest}. The run finished, so nothing else will report this. ` +
      "Each of these left the finding's file as it was, so its live_on may be stale. " +
      "Check the hosted worker's logs for the GitHub write or the browser check that failed.",
  };
}

export interface DeepAuditShapeInput {
  origin: string;
  /** How many pages the sampler chose. */
  sampled: number;
  /** How many of them a browser actually returned a result for. */
  rendered: number;
}

/**
 * The deep tier's rule, from the card: **a completed deep audit with zero
 * rendered pages of a nonzero sample is a bad shape.**
 *
 * A sample of zero is not a defect — a small site, or one whose robots.txt
 * refuses the auditor, legitimately has nothing to render, and the report says
 * so. Zero rendered from a sample the run chose means the browser half of the
 * audit produced nothing while the document still reads as finished, which is
 * exactly the 2026-08-15 failure.
 *
 * **The predicate is `report-shape.ts`'s, not a second copy of it.** Since
 * 2026-08-15 the assembled document stamps its own `integrity` from that same
 * function, and the alert and the report must not be able to disagree about one
 * run: an email saying a run went wrong beside a report calling itself clean is
 * worse than either signal on its own. This function owns the wording of the
 * email and nothing else.
 */
export function deepAuditShape(input: DeepAuditShapeInput): RunShape {
  if (!renderedNothing(input.sampled, input.rendered)) {
    return {
      ok: true,
      summary: `Deep audit of ${input.origin}: ${input.rendered}/${input.sampled} page(s) rendered.`,
    };
  }
  return {
    ok: false,
    summary:
      `Deep audit of ${input.origin} completed with 0 of ${input.sampled} sampled page(s) ` +
      'rendered, so its rendered-experience numbers are empty while the report reads as ' +
      'finished. The browser half of the audit produced nothing. Check the worker\'s logs for a ' +
      'Chrome that would not start, a cleanup step that hung, or leaked child processes.',
  };
}

// --- Temporal Cloud action usage --------------------------------------------

/**
 * The foreground action rate above which the nightly check raises an alert.
 *
 * A code constant, because it is a rule about what counts as wrong: it is
 * unit-tested and it changes by pull request rather than by somebody editing a
 * variable in a dashboard at speed.
 *
 * Five per second, sustained across a whole sampled minute (card decision 2).
 * The scorecard's twelve-minute run stays under one action per second even at
 * its busiest; a hot loop reads in the tens. The gap between those two is where
 * this sits, and it is wide enough that the number does not have to be right to
 * the decimal. The OK ping carries the observed rate every night, so a week of
 * healthy pings in the check's history is the evidence to re-tune it from.
 */
export const ACTION_RATE_ALERT_PER_SECOND = 5;

/** Two decimals: the endpoint reports three, and the third is never the point. */
function formatRate(perSecond: number): string {
  return `${perSecond.toFixed(2)}/s`;
}

/** `workflowType (actionType) at 1.23/s`, the phrase the body names a row with. */
function describeRow(row: { workflowType: string; actionType: string; rate: number }): string {
  return `${row.workflowType} (${row.actionType}) at ${formatRate(row.rate)}`;
}

/**
 * The action-usage rule: **a foreground rate above the threshold is a bad
 * shape.**
 *
 * One minute's rate, not a day's spend — the endpoint cannot produce the latter
 * and neither can this. What it catches is a workflow looping, which is a
 * sustained rate and therefore reads hot in whatever minute the sample lands in.
 * A single busy minute during a legitimate run is under the threshold by a wide
 * margin, which is the whole reason the threshold sits where it does.
 *
 * The healthy summary is deliberately as specific as the failing one. It is the
 * only place the observed rate is written down anywhere Matt can read it later:
 * the alerting service keeps each ping's body, so a week of OK bodies is the
 * dataset the threshold gets tuned from, and an OK body saying only "fine" would
 * throw that away every night.
 */
export function actionUsageShape(
  sample: ActionUsageSample,
  thresholdPerSecond = ACTION_RATE_ALERT_PER_SECOND,
): RunShape {
  const rate = formatRate(sample.foregroundPerSecond);
  const top = sample.billable[0];

  if (sample.foregroundPerSecond <= thresholdPerSecond) {
    if (sample.idle) {
      return {
        ok: true,
        summary:
          `Temporal Cloud action usage in ${sample.namespace}: the sampled minute was idle — the ` +
          'endpoint reported no action series at all, which is the namespace at rest and not a ' +
          `measurement of zero. Alert threshold ${formatRate(thresholdPerSecond)} foreground.`,
      };
    }
    return {
      ok: true,
      summary:
        `Temporal Cloud action usage in ${sample.namespace}: ${rate} foreground, against an alert ` +
        `threshold of ${formatRate(thresholdPerSecond)}` +
        (top ? `; the busiest billable series was ${describeRow(top)}.` : ', and no billable series.'),
    };
  }

  const named = sample.billable.slice(0, 3).map((row) => `- ${describeRow(row)}`);
  const rows = named.length
    ? `The busiest billable series in that minute:\n${named.join('\n')}\n`
    : 'No billable series were reported for the namespace, which is odd beside a foreground rate ' +
      'this high and is itself worth a look.\n';

  return {
    ok: false,
    summary:
      `Temporal Cloud action usage in ${sample.namespace} is ${rate} foreground, above the ` +
      `${formatRate(thresholdPerSecond)} alert threshold, sustained across the sampled minute. ` +
      'A rate this high held for any length of time is a workflow looping rather than work ' +
      `getting done: the nightly scorecard's own busiest minute stays well under the threshold.\n` +
      rows +
      'Actions bill past the trial credits rather than stopping, so this is a spend alert. ' +
      'Check the namespace\'s running workflows for the type named above and terminate the loop, ' +
      'then read the day against https://cloud.temporal.io/usage — the usage page is the record ' +
      'of what was actually spent, which one minute\'s rate cannot tell you.',
  };
}

/**
 * The shape for a sample that could not be taken at all.
 *
 * A fail ping rather than a silent skip (card decision 4). A metrics endpoint
 * that stopped answering is news on its own: it is the same endpoint the alert
 * depends on, so a quiet failure here would retire the check without retiring
 * the risk it watches, which is the worst of the available outcomes.
 */
export function actionUsageUnavailableShape(namespace: string, reason: string): RunShape {
  return {
    ok: false,
    summary:
      `Temporal Cloud action usage in ${namespace} could not be sampled: ${reason}. Nothing else ` +
      'in the run is affected — the scorecard measures the site and publishes exactly as it ' +
      'always does — but until this clears, nothing is watching the action rate, which is the ' +
      'one spend surface on this account that bills past its credits. A 401 or 403 means the ' +
      'metrics API key expired or lost its role; anything else is the endpoint itself. ' +
      'Re-issuing the key is in steward/docs/rotate-a-credential.md, in the private operator docs.',
  };
}
