import { defaultPayloadConverter } from '@temporalio/common';
import type { History } from '@temporalio/common/lib/proto-utils.js';
import { parseIssueUrl, parsePrUrl, type FindingVerdict } from './findings.js';

/**
 * `steward finding report`: one row per `findingWorkflow` run that received a
 * verdict, with the minutes between its steps.
 *
 * **Two sources, one rule each.** The history says which run this is, when
 * the verdict arrived, which issue, PR and deployment each step produced, and
 * when the verify child measured production. GitHub says when the issue, the
 * PR, the merge and the deploy happened. The history's own merge and deploy
 * completions are not the measure: those waits poll every 5 and 2 minutes, so
 * their events land up to that much after the fact.
 *
 * **The builder computes, the CLI gathers.** {@link readRunHistory} and
 * {@link buildReportRow} take a history and GitHub's answers as plain data;
 * {@link readRunGitHub} asks GitHub through whatever reader it is handed. Only
 * the CLI hands it the network.
 *
 * A step the run never reached is null here and a dash on screen, so a parked,
 * rejected or custom-fixer run is a row with gaps, not an error.
 *
 * **A hand verify closes a run's row.** An approved run that ended with the
 * finding still `fixing`, stopped at its verdict, or that `steward finding
 * verify` cancelled, is finished by a `verifyFindingWorkflow` the CLI started:
 * {@link applyHandVerifies} takes that verify's outcome and measurement time
 * into the row, and its PR and deployment when the run never saw one.
 */

type HistoryEvent = NonNullable<History['events']>[number];
type Payloads = NonNullable<HistoryEvent['workflowExecutionSignaledEventAttributes']>['input'];

/** What one run's history says, before GitHub is asked anything. */
export interface RunFacts {
  workflowId: string;
  site: string;
  key: string;
  /** The first well-formed `verdict` signal, the one the workflow kept. */
  verdict: FindingVerdict | null;
  /** ISO 8601: the event time of that signal. */
  verdictAt: string | null;
  /** The last fix attempt's issue, or null for no attempt or a custom-fixer attempt. */
  issueUrl: string | null;
  /** The last fix attempt's PR. */
  prUrl: string | null;
  /** The production deployment the deploy wait named, after the last PR merged. */
  deploymentId: number | null;
  /** ISO 8601: when the verify child measured production. */
  ranAt: string | null;
  /** The result's outcome, `open` for a running run, or how it closed otherwise. */
  outcome: string;
  /** ISO 8601: when the run closed, or null while it is open. */
  closedAt: string | null;
}

/** GitHub's answers for one run. Null where the run never reached the step, or GitHub has no answer. */
export interface RunGitHub {
  issueCreatedAt: string | null;
  prCreatedAt: string | null;
  mergedAt: string | null;
  /** The `created_at` of the `success` status on the production deployment. */
  deployedAt: string | null;
  /** Comments and non-empty reviews on the fix PR by a GitHub user, not a bot. */
  humanComments: number | null;
  /** The `total_cost_usd` the Action printed for the issue's `claude.yml` run. */
  costUsd: number | null;
}

/** Minutes from the previous step. Null for a step the run never reached. */
export interface ReportSteps {
  issue: number | null;
  pr: number | null;
  merge: number | null;
  deploy: number | null;
  resolved: number | null;
}

export interface ReportRow {
  key: string;
  workflowId: string;
  /** ISO 8601: the verdict signal's event time. */
  approveAt: string;
  steps: ReportSteps;
  /** Approve to the verify's measurement. */
  total: number | null;
  outcome: string;
  humanComments: number | null;
  costUsd: number | null;
}

function eventTime(event: HistoryEvent): string {
  const ts = event.eventTime;
  const ms = Number(ts?.seconds ?? 0) * 1000 + Math.floor((ts?.nanos ?? 0) / 1e6);
  return new Date(ms).toISOString();
}

function first(payloads: Payloads): unknown {
  const payload = payloads?.payloads?.[0];
  return payload ? defaultPayloadConverter.fromPayload(payload) : undefined;
}

function isVerdict(value: unknown): value is FindingVerdict {
  const v = value as FindingVerdict;
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.status === 'approved' || v.status === 'rejected') &&
    (v.source === 'cli' || v.source === 'file') &&
    typeof v.reason === 'string' &&
    typeof v.at === 'string'
  );
}

/**
 * The facts of one `findingWorkflow` run, read from its history. Each new fix
 * attempt, an `openFixIssue` or a `fixFindingWorkflow` child, clears the last
 * one's issue, PR and deployment, so the row describes the attempt that got
 * furthest last.
 */
export function readRunHistory(history: History): RunFacts {
  const events = history.events ?? [];
  const started = events[0]?.workflowExecutionStartedEventAttributes;
  const input = first(started?.input) as { site?: string; key?: string } | undefined;
  const site = input?.site ?? '';
  const key = input?.key ?? '';

  const facts: RunFacts = {
    workflowId: `finding/${site}/${key}`,
    site,
    key,
    verdict: null,
    verdictAt: null,
    issueUrl: null,
    prUrl: null,
    deploymentId: null,
    ranAt: null,
    outcome: 'open',
    closedAt: null,
  };

  // A completion names its activity only through the scheduled event's ID.
  const activityType = new Map<string, string>();

  for (const event of events) {
    const id = String(event.eventId);

    const signal = event.workflowExecutionSignaledEventAttributes;
    if (signal?.signalName === 'verdict' && !facts.verdict) {
      const verdict = first(signal.input);
      if (isVerdict(verdict)) {
        facts.verdict = verdict;
        facts.verdictAt = eventTime(event);
      }
      continue;
    }

    const scheduled = event.activityTaskScheduledEventAttributes;
    if (scheduled) {
      const name = scheduled.activityType?.name ?? '';
      activityType.set(id, name);
      if (name === 'openFixIssue') {
        facts.issueUrl = null;
        facts.prUrl = null;
        facts.deploymentId = null;
      }
      continue;
    }

    const completed = event.activityTaskCompletedEventAttributes;
    if (completed) {
      const name = activityType.get(String(completed.scheduledEventId));
      const result = first(completed.result) as Record<string, unknown> | undefined;
      if (name === 'openFixIssue' && typeof result?.url === 'string') facts.issueUrl = result.url;
      if (name === 'awaitFixPr' && typeof result?.prUrl === 'string') facts.prUrl = result.prUrl;
      if (name === 'awaitProductionDeploy' && typeof result?.deploymentId === 'number') {
        facts.deploymentId = result.deploymentId;
      }
      continue;
    }

    const childStart = event.startChildWorkflowExecutionInitiatedEventAttributes;
    if (childStart?.workflowType?.name === 'fixFindingWorkflow') {
      facts.issueUrl = null;
      facts.prUrl = null;
      facts.deploymentId = null;
      continue;
    }

    const child = event.childWorkflowExecutionCompletedEventAttributes;
    if (child) {
      const result = first(child.result) as Record<string, unknown> | undefined;
      if (child.workflowType?.name === 'fixFindingWorkflow' && typeof result?.prUrl === 'string') {
        facts.prUrl = result.prUrl;
      }
      if (child.workflowType?.name === 'verifyFindingWorkflow' && typeof result?.ranAt === 'string') {
        facts.ranAt = result.ranAt;
      }
      continue;
    }

    const closing =
      event.workflowExecutionCompletedEventAttributes ??
      event.workflowExecutionFailedEventAttributes ??
      event.workflowExecutionTerminatedEventAttributes ??
      event.workflowExecutionCanceledEventAttributes ??
      event.workflowExecutionTimedOutEventAttributes ??
      event.workflowExecutionContinuedAsNewEventAttributes;
    if (closing) facts.closedAt = eventTime(event);
    if (event.workflowExecutionCompletedEventAttributes) {
      const result = first(event.workflowExecutionCompletedEventAttributes.result) as { outcome?: string } | undefined;
      facts.outcome = result?.outcome ?? 'verdict';
    } else if (event.workflowExecutionFailedEventAttributes) {
      facts.outcome = 'failed';
    } else if (event.workflowExecutionTerminatedEventAttributes) {
      facts.outcome = 'terminated';
    } else if (event.workflowExecutionCanceledEventAttributes) {
      facts.outcome = 'canceled';
    } else if (event.workflowExecutionTimedOutEventAttributes) {
      facts.outcome = 'timed-out';
    } else if (event.workflowExecutionContinuedAsNewEventAttributes) {
      facts.outcome = 'continued';
    }
  }

  return facts;
}

/** Minutes from `from` to `to`, one decimal, or null when either is missing. */
export function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round((Date.parse(to) - Date.parse(from)) / 6_000) / 10;
}

/** A hand `verifyFindingWorkflow`, one `steward finding verify` started, as the report folds it into a run's row. */
export interface HandVerify {
  site: string;
  key: string;
  outcome: string;
  /** ISO 8601: when it measured production or read the deploy. */
  ranAt: string | null;
  /** `confirmed` only: the fix PR and the production deployment it read. */
  prUrl: string | null;
  deploymentId: number | null;
}

/**
 * One hand verify's facts, or null for a verify that did not complete and for
 * a lifecycle's child, whose outcome is already its parent's.
 */
export function readVerifyHistory(history: History): HandVerify | null {
  const events = history.events ?? [];
  const started = events[0]?.workflowExecutionStartedEventAttributes;
  if (started?.parentWorkflowExecution?.workflowId) return null;
  const input = first(started?.input) as { site?: string; key?: string } | undefined;
  const done = events.find((e) => e.workflowExecutionCompletedEventAttributes)?.workflowExecutionCompletedEventAttributes;
  if (!done) return null;
  const result = first(done.result) as
    | { outcome?: string; ranAt?: string | null; deploy?: { prUrl?: string; deploymentId?: number | null } }
    | undefined;
  if (!result?.outcome) return null;
  return {
    site: input?.site ?? '',
    key: input?.key ?? '',
    outcome: result.outcome,
    ranAt: result.ranAt ?? null,
    prUrl: result.deploy?.prUrl ?? null,
    deploymentId: result.deploy?.deploymentId ?? null,
  };
}

/** Lifecycle endings that leave the finding for a hand verify: still `fixing`, or cancelled by one. */
const LEFT_FOR_A_HAND_VERIFY = new Set(['unverifiable', 'merge-timeout', 'deploy-timeout', 'verify-failed', 'canceled']);
const VERIFY_ENDINGS = new Set(['resolved', 'reopened', 'confirmed']);

/** Whether a run's finding can be finished by a hand verify: approved, and its run ended short of a verify of its own. */
function leftForAHandVerify(facts: RunFacts): boolean {
  if (facts.verdict?.status !== 'approved' || !facts.closedAt) return false;
  // A verdict-only run: its fix, if any, ran outside it.
  return facts.outcome === 'verdict' || LEFT_FOR_A_HAND_VERIFY.has(facts.outcome);
}

/**
 * Every run's facts, with the hand verify that finished it folded in. A hand
 * verify belongs to the newest approved run of its finding whose verdict came
 * before it. A run the CLI cancelled takes the newest one before its close,
 * since the cancel follows the verify; a run that ended earlier takes the
 * first one after it closed. A run that ended on its own verify, or is still
 * open, is left as it is. The run takes the verify's outcome and time, and its
 * PR and deployment when the run never had a PR.
 */
export function applyHandVerifies(runs: RunFacts[], verifies: HandVerify[]): RunFacts[] {
  const picked = new Map<RunFacts, HandVerify>();
  for (const v of verifies) {
    const ranAt = v.ranAt;
    if (!ranAt || !VERIFY_ENDINGS.has(v.outcome)) continue;
    const owner = runs
      .filter((r) => r.site === v.site && r.key === v.key && r.verdict?.status === 'approved' && r.verdictAt && r.verdictAt <= ranAt)
      .sort((a, b) => (a.verdictAt as string).localeCompare(b.verdictAt as string))
      .at(-1);
    if (!owner || !leftForAHandVerify(owner)) continue;
    const cancelled = owner.outcome === 'canceled';
    const closedAt = owner.closedAt as string;
    if (cancelled ? ranAt > closedAt : ranAt < closedAt) continue;
    const held = picked.get(owner)?.ranAt as string | undefined;
    if (!held || (cancelled ? ranAt > held : ranAt < held)) picked.set(owner, v);
  }
  return runs.map((facts) => {
    const hand = picked.get(facts);
    if (!hand) return facts;
    const own = facts.prUrl !== null;
    return {
      ...facts,
      outcome: hand.outcome,
      ranAt: hand.ranAt,
      prUrl: own ? facts.prUrl : hand.prUrl,
      deploymentId: own ? facts.deploymentId : hand.deploymentId,
    };
  });
}

/**
 * One report row: the run's history and GitHub's answers in, minutes out. Null
 * for a run that never received a verdict, which the report leaves out.
 * `facts` defaults to the history's own; pass {@link applyHandVerifies}'s to
 * count a hand verify.
 *
 * An open approved run with no issue and no PR waits for a fix: its outcome
 * reads `waiting-fix` and the whole days from the approve to `now`, as
 * `waiting-fix 4d`, so a parked run stands out from one in flight.
 */
export function buildReportRow(
  history: History,
  github: RunGitHub,
  facts = readRunHistory(history),
  now: Date = new Date(),
): ReportRow | null {
  if (!facts.verdict || !facts.verdictAt) return null;
  const approve = facts.verdictAt;
  const waitingFix = facts.outcome === 'open' && facts.verdict.status === 'approved' && !facts.issueUrl && !facts.prUrl;
  const outcome = waitingFix
    ? `waiting-fix ${Math.max(0, Math.floor((now.getTime() - Date.parse(approve)) / 86_400_000))}d`
    : facts.outcome;
  return {
    key: facts.key,
    workflowId: facts.workflowId,
    approveAt: approve,
    steps: {
      issue: minutesBetween(approve, github.issueCreatedAt),
      pr: minutesBetween(github.issueCreatedAt, github.prCreatedAt),
      merge: minutesBetween(github.prCreatedAt, github.mergedAt),
      deploy: minutesBetween(github.mergedAt, github.deployedAt),
      resolved: minutesBetween(github.deployedAt, facts.ranAt),
    },
    total: minutesBetween(approve, facts.ranAt),
    outcome,
    humanComments: github.humanComments,
    costUsd: github.costUsd,
  };
}

// ---------------------------------------------------------------------------
// GitHub's answers, shaped
// ---------------------------------------------------------------------------

interface GitHubAuthored {
  user?: { type?: string } | null;
  body?: string | null;
}

/** A person's account, not an app or a bot: GitHub's `type` is `User`. */
export function isHumanAuthor(item: GitHubAuthored): boolean {
  return item.user?.type === 'User';
}

/**
 * Human comments on a PR: its conversation comments, its review comments, and
 * its reviews that say something. A bare approval has an empty body and is not
 * a comment.
 */
export function countHumanComments(
  issueComments: GitHubAuthored[],
  reviewComments: GitHubAuthored[],
  reviews: GitHubAuthored[],
): number {
  return (
    issueComments.filter(isHumanAuthor).length +
    reviewComments.filter(isHumanAuthor).length +
    reviews.filter((r) => isHumanAuthor(r) && (r.body ?? '').trim() !== '').length
  );
}

/** The `created_at` of a deployment's `success` status, the earliest if there are several. */
export function successAt(statuses: { state?: string; created_at?: string }[]): string | null {
  const times = statuses
    .filter((s) => s.state === 'success' && typeof s.created_at === 'string')
    .map((s) => s.created_at as string)
    .sort();
  return times[0] ?? null;
}

/**
 * The cost the Action printed: `claude-code-action` logs its result block, and
 * that block carries `"total_cost_usd": <n>`. The last one in the log is the
 * run's. Null for a log without one.
 */
export function costFromJobLog(log: string): number | null {
  const matches = [...log.matchAll(/"total_cost_usd":\s*([0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?)/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

export interface ActionRun {
  id: number;
  event?: string;
  display_title?: string;
  created_at?: string;
}

/**
 * The `claude.yml` run an issue triggered: an `issues` run titled as the issue,
 * started at or after it, the earliest. An issue's run carries no issue number,
 * so the title and the time are the match.
 */
export function pickIssueRun(runs: ActionRun[], issue: { title: string; createdAt: string }): ActionRun | null {
  const candidates = runs
    .filter((r) => r.event === 'issues' && r.display_title === issue.title && (r.created_at ?? '') >= issue.createdAt)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  return candidates[0] ?? null;
}

/** How {@link readRunGitHub} reads GitHub: `json` for the REST API, `text` for a job log (null when gone). */
export interface GitHubReader {
  json(pathname: string): Promise<any>;
  text(pathname: string): Promise<string | null>;
}

/** The Action's workflow file in the site repository. */
export const ACTION_WORKFLOW = 'claude.yml';

/**
 * GitHub's answers for one run, each read only when the history says the step
 * was reached. A cost read that fails (a token without Actions read, a log
 * GitHub has expired) leaves the cost null and says why in `costNote`; every
 * other failure throws.
 */
export async function readRunGitHub(
  facts: RunFacts,
  reader: GitHubReader,
): Promise<RunGitHub & { costNote: string | null }> {
  const answers: RunGitHub & { costNote: string | null } = {
    issueCreatedAt: null,
    prCreatedAt: null,
    mergedAt: null,
    deployedAt: null,
    humanComments: null,
    costUsd: null,
    costNote: null,
  };

  const issue = facts.issueUrl ? parseIssueUrl(facts.issueUrl) : null;
  if (issue) {
    const data = await reader.json(`/repos/${issue.repo}/issues/${issue.number}`);
    answers.issueCreatedAt = (data.created_at as string | undefined) ?? null;
    if (answers.issueCreatedAt) {
      try {
        answers.costUsd = await readActionCost(reader, issue.repo, {
          title: String(data.title ?? ''),
          createdAt: answers.issueCreatedAt,
        });
        if (answers.costUsd === null) answers.costNote = `no cost line for ${facts.issueUrl}`;
      } catch (err) {
        answers.costNote = `${facts.issueUrl}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  const pr = facts.prUrl ? parsePrUrl(facts.prUrl) : null;
  if (pr) {
    const data = await reader.json(`/repos/${pr.repo}/pulls/${pr.number}`);
    answers.prCreatedAt = (data.created_at as string | undefined) ?? null;
    answers.mergedAt = (data.merged_at as string | null | undefined) ?? null;
    const [issueComments, reviewComments, reviews] = await Promise.all([
      reader.json(`/repos/${pr.repo}/issues/${pr.number}/comments?per_page=100`),
      reader.json(`/repos/${pr.repo}/pulls/${pr.number}/comments?per_page=100`),
      reader.json(`/repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`),
    ]);
    answers.humanComments = countHumanComments(issueComments, reviewComments, reviews);

    if (facts.deploymentId !== null) {
      const statuses = await reader.json(`/repos/${pr.repo}/deployments/${facts.deploymentId}/statuses?per_page=100`);
      answers.deployedAt = successAt(statuses);
    }
  }

  return answers;
}

async function readActionCost(
  reader: GitHubReader,
  repo: string,
  issue: { title: string; createdAt: string },
): Promise<number | null> {
  const since = encodeURIComponent(`>=${issue.createdAt}`);
  const listed = await reader.json(
    `/repos/${repo}/actions/workflows/${ACTION_WORKFLOW}/runs?event=issues&created=${since}&per_page=100`,
  );
  const run = pickIssueRun((listed.workflow_runs ?? []) as ActionRun[], issue);
  if (!run) return null;
  const jobs = await reader.json(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
  let total: number | null = null;
  for (const job of (jobs.jobs ?? []) as { id: number }[]) {
    const log = await reader.text(`/repos/${repo}/actions/jobs/${job.id}/logs`);
    const cost = log ? costFromJobLog(log) : null;
    if (cost !== null) total = (total ?? 0) + cost;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** The middle value, or the mean of the two middle values. Null for an empty list. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ReportFooter {
  rows: number;
  /** The median total over the rows that reached the verify, and how many did. */
  medianTotal: number | null;
  totalRows: number;
  /**
   * The median of human comments plus two, the approve and the merge, over the
   * rows whose PR merged, and how many did.
   */
  medianHumanActions: number | null;
  mergedRows: number;
}

export function reportFooter(rows: ReportRow[]): ReportFooter {
  const totals = rows.map((r) => r.total).filter((t): t is number => t !== null);
  const actions = rows
    .filter((r) => r.steps.merge !== null && r.humanComments !== null)
    .map((r) => (r.humanComments as number) + 2);
  return {
    rows: rows.length,
    medianTotal: median(totals),
    totalRows: totals.length,
    medianHumanActions: median(actions),
    mergedRows: actions.length,
  };
}

const HEADERS = ['Key', 'Approve', 'Issue', 'PR', 'Merge', 'Deploy', 'Resolved', 'Total', 'Outcome', 'Comments', 'Cost'];
const DASH = '-';

function formatLocal(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // `en-CA` writes midnight as 24 in some runtimes.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

const num = (n: number | null): string => (n === null ? DASH : n.toFixed(1));

function cells(row: ReportRow, timeZone: string): string[] {
  return [
    row.key,
    formatLocal(row.approveAt, timeZone),
    num(row.steps.issue),
    num(row.steps.pr),
    num(row.steps.merge),
    num(row.steps.deploy),
    num(row.steps.resolved),
    num(row.total),
    row.outcome,
    row.humanComments === null ? DASH : String(row.humanComments),
    row.costUsd === null ? DASH : row.costUsd.toFixed(2),
  ];
}

function footerLine(footer: ReportFooter): string {
  const total = footer.medianTotal === null ? DASH : `${footer.medianTotal.toFixed(1)} min`;
  const actions = footer.medianHumanActions === null ? DASH : String(footer.medianHumanActions);
  return (
    `${footer.rows} row${footer.rows === 1 ? '' : 's'}. ` +
    `Median total ${total} (${footer.totalRows} verified). ` +
    `Median human actions ${actions} (${footer.mergedRows} merged; comments plus the approve and the merge).`
  );
}

const LEGEND =
  'Minutes from the previous step: approve to issue, issue to PR, PR to merge, merge to deploy, deploy to resolved. Total is approve to resolved. Approve is local time; cost is USD.';

/** The report as text: aligned columns, or a markdown table with `markdown`. */
export function renderFindingReport(rows: ReportRow[], opts: { markdown: boolean; timeZone: string }): string {
  const body = rows.map((r) => cells(r, opts.timeZone));
  const footer = footerLine(reportFooter(rows));
  if (opts.markdown) {
    const line = (values: string[]) => `| ${values.join(' | ')} |`;
    return [
      line(HEADERS),
      line(HEADERS.map((_, i) => (i < 2 || i === 8 ? '---' : '--:'))),
      ...body.map(line),
      '',
      LEGEND,
      '',
      footer,
    ].join('\n');
  }
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...body.map((c) => c[i].length)));
  const pad = (values: string[]) =>
    values
      .map((v, i) => (i < 2 || i === 8 ? v.padEnd(widths[i]) : v.padStart(widths[i])))
      .join('  ')
      .trimEnd();
  return [pad(HEADERS), ...body.map(pad), '', LEGEND, footer].join('\n');
}
