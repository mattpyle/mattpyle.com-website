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
 * ## Four signals, one transport
 *
 * The transport is an external dead-man's-switch service (healthchecks.io),
 * authorised on the card 2026-08-15, because nothing else in this stack can send
 * an email. Each signal is one check there:
 *
 * | Signal | Means | Pinged by |
 * |---|---|---|
 * | `nightly-scorecard` | a good nightly scorecard run happened | the scheduled run, success and failure both |
 * | `credential-expiry` | no tracked credential is near its expiry | the scheduled run |
 * | `action-usage` | the namespace is not burning Temporal Cloud actions at a runaway rate | the scheduled run |
 * | `run-shape` | fail-only: a completed run whose record is wrong | a manual scorecard run, and any deep audit |
 *
 * The first three carry the dead-man's half: a worker that never runs sends
 * nothing, the check's own period lapses, and the service emails about the
 * silence. That is the failure a liveness ping cannot detect from inside a dead
 * container. `run-shape` is fail-only and therefore has no period — a deep audit
 * is ad hoc, so "no deep audit today" is not news.
 */

import type { ActionUsageSample } from './action-usage.js';
import { renderedNothing } from './agent-audit/report-shape.js';

/** One check at the alerting service. */
export type HealthSignal = 'nightly-scorecard' | 'credential-expiry' | 'action-usage' | 'run-shape';

/**
 * The slug each signal pings, which is also the check's name in the service's
 * dashboard. Slugs rather than per-check UUIDs so the whole transport is **one**
 * configuration value (`STEWARD_HEALTHCHECK_BASE`, a project ping key) in the
 * two places it has to be set. `action-usage`, added 2026-09-06, is the proof:
 * it cost a row here and no new transport configuration at all. The check has to
 * be created in the service under the same slug, though — the code never creates
 * one on the fly (`lib/health-ping.ts`), so a new row here is half a change.
 */
export const HEALTH_CHECK_SLUGS: Record<HealthSignal, string> = {
  'nightly-scorecard': 'steward-nightly-scorecard',
  'credential-expiry': 'steward-credential-expiry',
  'action-usage': 'steward-action-usage',
  'run-shape': 'steward-run-shape',
};

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
  const slug = HEALTH_CHECK_SLUGS[signal];
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
  pages: Array<{ url: string; ok: boolean; error?: string }>;
  /** `open-pr` or `no-op`, for the healthy summary. */
  decision: string;
  /** The run's calendar day. */
  iso: string;
}

/**
 * The scorecard's rule, from the card: **a completed run with a failed-page
 * count above zero is a bad shape.**
 *
 * Not "most pages failed" and not a ratio. A single page the audit could not
 * measure already blocks a green scorecard by design (`buildCommentary`), so the
 * run's own publish logic and this rule agree on what a defect is. An audit set
 * of zero pages is caught earlier by `checkAuditSet` and fails the run outright,
 * which the failure path alerts on separately.
 */
export function scorecardRunShape(input: ScorecardShapeInput): RunShape {
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
  return {
    ok: false,
    summary:
      `Scorecard ${input.iso} completed but ${failed.length} of ${input.pages.length} page(s) ` +
      `could not be audited: ${named.join('; ')}${rest}. The run finished, so nothing else will ` +
      'report this. Check the hosted worker\'s logs before trusting the numbers, and expect the ' +
      'run-log PR (if one opened) to record a measurement of the auditor rather than of the site.',
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

/**
 * A credential with a fixed lifetime, tracked so its expiry is never a surprise.
 *
 * **Deliberately not a field: where the credential's copies live.** This file is
 * public, and a list of every place a token is stored is a map worth more to
 * somebody else than to the operator, who does not need to be told in an email
 * where his own secrets are. The boundary rule, on the secret-management card:
 * credential metadata defaults private, and public code carries only what an
 * alert body needs. What an alert body needs is which credential, when it goes,
 * and what breaks — the rotation locations live in the private operator docs,
 * in `steward/docs/rotate-a-credential.md`, and the alert points there by name.
 */
export interface TrackedCredential {
  /** What it is, in the words the operator would use. */
  name: string;
  /** Expiry date, `YYYY-MM-DD`, read as end of that day UTC. */
  expires: string;
  /** What breaks, and how it looks, on the day it lapses. */
  failure: string;
}

/**
 * **The one place a dated credential's expiry is recorded.** Adding a credential
 * with a fixed lifetime anywhere in this stack means adding a row here in the
 * same change; that is the whole mechanism, and it is deliberately a code
 * constant rather than a note in a document, because a constant is what the
 * nightly run can read.
 *
 * The rows carry `failure` because the cost of a lapsed credential here is not
 * the outage, it is the diagnosis: the Temporal Cloud key's expiry surfaces as a
 * bare `Request unauthorized` naming nothing, two years after anybody thought
 * about it. They carry no locations, for the reason above.
 */
export const TRACKED_CREDENTIALS: TrackedCredential[] = [
  {
    name: 'Temporal Cloud API key',
    expires: '2028-08-13',
    failure:
      'every client and both workers fail to connect with a bare "Request unauthorized" that ' +
      'names no cause; the nightly scorecard stops producing runs.',
  },
  {
    // Created 2026-09-06 with a 90-day lifetime, so it lapses on 2026-12-05 and
    // the warning arrives around 2026-11-05. Account-level Metrics Read-Only,
    // which is a narrower role than the workers' key holds.
    name: 'Temporal Cloud metrics API key',
    expires: '2026-12-05',
    failure:
      'the nightly action-usage check fails with a 401 body naming the endpoint, and nothing ' +
      'else breaks: the scorecard still runs, still measures the site, and still publishes.',
  },
  {
    // Same creation date and lifetime. A session credential rather than a
    // production one, which is why its failure line says so plainly — the
    // temptation on the day it lapses is to assume production is down.
    name: 'Temporal Cloud read API key',
    expires: '2026-12-05',
    // No storage location here, per `TrackedCredential`: this row would be the
    // natural place to name the file it sits in, and that is exactly the
    // sentence the boundary rule (and the test guarding it) exists to refuse.
    failure:
      'a working session loses its read access to Temporal Cloud, so listing workflows and ' +
      'reading histories stops working from this machine. Nothing in production breaks: the ' +
      'hosted worker connects with a different key.',
  },
  {
    name: 'GitHub fine-grained PAT',
    expires: '2026-11-11',
    failure:
      'the scorecard measures the site for twelve minutes and then dies on its publish and ' +
      'archive legs with an AuthError, so the run happens and persists nothing.',
  },
];

/**
 * How far ahead a warning starts. Four weeks and a couple of days: long enough
 * that a busy fortnight cannot swallow it, short enough that the warning is
 * about something the operator can act on rather than a standing red light.
 */
export const CREDENTIAL_WARNING_DAYS = 30;

/** Whole days from `nowMs` to the end of `expires` (UTC). Negative once lapsed. */
export function daysUntilExpiry(expires: string, nowMs: number): number {
  // End of the expiry day rather than its start: a token stamped 2026-11-11 is
  // usable on 2026-11-11, and warning "0 days left" on a working morning reads
  // as already-broken.
  const endOfDay = Date.parse(`${expires}T23:59:59.999Z`);
  if (Number.isNaN(endOfDay)) {
    throw new Error(`Credential expiry "${expires}" is not a YYYY-MM-DD date.`);
  }
  return Math.floor((endOfDay - nowMs) / 86_400_000);
}

/** Each credential with its days remaining, soonest first. */
function datedCredentials(
  credentials: TrackedCredential[],
  nowMs: number,
): Array<{ credential: TrackedCredential; days: number }> {
  return credentials
    .map((c) => ({ credential: c, days: daysUntilExpiry(c.expires, nowMs) }))
    .sort((a, b) => a.days - b.days);
}

/**
 * The credentials inside the warning window, soonest first — expired ones
 * included, since a lapsed credential is the loudest case of the same signal.
 * Exported so a caller can count them without parsing the summary prose.
 */
export function credentialsDueWithin(
  credentials: TrackedCredential[],
  nowMs: number,
  warningDays = CREDENTIAL_WARNING_DAYS,
): Array<{ credential: TrackedCredential; days: number }> {
  return datedCredentials(credentials, nowMs).filter((d) => d.days <= warningDays);
}

/**
 * The expiry verdict for the whole list.
 *
 * One signal for all credentials rather than one per credential: the operator
 * action is the same — go and re-issue the thing — and a check per credential
 * would be a dashboard whose green rows outnumber its useful ones. The summary
 * names every credential inside the window, so the email is still specific.
 */
export function credentialExpiryShape(
  credentials: TrackedCredential[],
  nowMs: number,
  warningDays = CREDENTIAL_WARNING_DAYS,
): RunShape {
  const dated = datedCredentials(credentials, nowMs);
  const due = credentialsDueWithin(credentials, nowMs, warningDays);

  if (due.length === 0) {
    const next = dated[0];
    return {
      ok: true,
      summary: next
        ? `${dated.length} tracked credential(s); the nearest is ${next.credential.name}, ` +
          `${next.days} days out (${next.credential.expires}).`
        : 'No credentials are tracked.',
    };
  }

  const lines = due.map((d) => {
    const when =
      d.days < 0
        ? `EXPIRED ${-d.days} day(s) ago on ${d.credential.expires}`
        : `expires in ${d.days} day(s), on ${d.credential.expires}`;
    return `- ${d.credential.name} ${when}.\n  On the day it lapses: ${d.credential.failure}`;
  });

  return {
    ok: false,
    summary:
      `${due.length} tracked credential(s) inside the ${warningDays}-day warning window:\n` +
      `${lines.join('\n')}\n` +
      // Named rather than listed. The alert is an email leaving this system, and
      // where each copy of a credential lives is not something it needs to
      // carry — see `TrackedCredential`.
      'Every copy that has to be replaced is listed in steward/docs/rotate-a-credential.md, ' +
      'in the private operator docs. Re-issue each one, update every copy listed there, then update ' +
      'TRACKED_CREDENTIALS in agents/steward/src/lib/run-health.ts with the new date.',
  };
}

// --- Temporal Cloud action usage --------------------------------------------

/**
 * The foreground action rate above which the nightly check raises an alert.
 *
 * A code constant, like `CREDENTIAL_WARNING_DAYS` and for the same reason: it is
 * a rule about what counts as wrong, so it is unit-tested and it changes by pull
 * request rather than by somebody editing a variable in a dashboard at speed.
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
