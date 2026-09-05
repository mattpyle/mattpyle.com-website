/**
 * The fast tier's standalone-activity path, and the fallback that makes it safe
 * to have one.
 *
 * `audit_site` used to run the audit inside the Vercel function that answered the
 * request, full stop. It now starts `auditSiteFast` on Temporal as a **standalone
 * activity** — the same function the deep tier's workflow schedules, started
 * directly from a client with no workflow in between — and waits for the result.
 * What that buys, in the order the card argues it:
 *
 * - **One visit per site per hour, not one per caller.** The activity ID is
 *   `audit:<origin>:<UTC hour>` (`fastAuditActivityIdFor`), so two agents asking
 *   about the same site in the same hour share one run: the second either
 *   attaches to the first's execution or reads its finished result. A stranger's
 *   origin sees one visitor where it would have seen two.
 * - **Visibility.** `temporal activity list` shows every public audit with its
 *   status, attempt count and last error. Nothing on this side had to be built
 *   for that.
 * - **Retries that are the server's problem.** A transient failure is retried
 *   once by Temporal rather than surfacing to the caller as a broken tool call.
 *
 * ## Every failure ends in the same place
 *
 * Four things can go wrong, and all four end with the audit running inside this
 * function and the answer saying `tool.path: "function"`. A caller never sees a
 * Temporal error from the fast tool; the reason goes to the `[mcp]` log line and
 * nowhere else, because "your audit worked" is the honest answer and the cause is
 * an operator's question rather than an agent's.
 *
 * | Trigger | What it costs before the fallback starts |
 * |---|---|
 * | No Temporal configuration on this deployment | nothing; `getClient` refuses without a round trip |
 * | Connect or start fails | up to the connect deadline in `mcp-temporal.mjs`, 8s |
 * | `scheduleToStartTimeout` fires (no worker on the queue) | 8s |
 * | No result inside the budget | the whole `budgetMs`, and only when a worker took the task and is running slow |
 *
 * The fallback is given **what is left of the budget** rather than a fresh one,
 * so the two attempts together stay inside the one deadline the endpoint
 * promises. That matters most in the fourth row: a fresh budget there would let
 * one call spend twice the endpoint's whole allowance and come back as a platform
 * 504 with no body, which is the exact failure `AUDIT_BUDGET_MS` exists to
 * prevent.
 *
 * ## What `standalone-shared` does and does not claim
 *
 * Two policies do the deduplication, and between them they say what happens in
 * each of an ID's three states. `idConflictPolicy: USE_EXISTING` covers a
 * *running* activity. `idReusePolicy: ALLOW_DUPLICATE_FAILED_ONLY` covers a
 * *closed* one, and it answers the two closed states differently.
 *
 * | State of the ID | What the start does | Reported path |
 * |---|---|---|
 * | Running | attaches to that run and returns a handle to it | `standalone` |
 * | Closed, completed | refused with `ActivityExecutionAlreadyStartedError`; this module reads the finished result back through `client.activity.getHandle(id).result()` | `standalone-shared` |
 * | Closed, failed, cancelled, terminated or timed out | allowed; the hour's ID runs again | `standalone` |
 *
 * The third row is why the policy is not `REJECT_DUPLICATE`. That one refuses a
 * closed ID whatever state it closed in, so the hour's first audit failing would
 * lock the bucket: every later caller that hour reads the failure back, falls
 * back to the function, and visits the site anyway. Sharing a *successful*
 * answer is the point; sharing a failure costs a visit and buys nothing.
 *
 * **Only the middle row is reported as `standalone-shared`.** The SDK's start
 * response carries a run ID and nothing that distinguishes "I created this run"
 * from "I attached to yours" (`ActivityClient.startHandler` in
 * `@temporalio/client` 1.20.3), so an attach is indistinguishable here from a
 * fresh start and is reported as `standalone`. The field therefore
 * **under-reports** sharing, which is the safe direction: a `standalone-shared`
 * answer is definitely a shared one, and the dedup hit rate read off these values
 * is a floor rather than an estimate.
 *
 * ## Everything is injected
 *
 * The client, the in-function auditor, the clock, the random suffix and the log
 * sink all arrive as arguments. That is what lets the tests drive all four
 * fallback triggers, the dedup read, the `fresh` suffix and every `tool.path`
 * value against fakes, with no Temporal anywhere and no assertions about source
 * text — the card's "proven by tests against a fake client rather than by reading
 * the source" line, made structural.
 */

import { randomUUID } from 'node:crypto';
import {
  AUDIT_FAST_ACTIVITY_TYPE,
  AUDIT_FAST_TASK_QUEUE,
  fastAuditActivityIdFor,
} from '@mattpyle/steward/agent-audit/deep-contract';
import { withDeadline } from './mcp-temporal.mjs';

/**
 * How long the activity may sit on the queue before this gives up on Temporal.
 *
 * The load-bearing number of the whole fallback. A worker that is down, a queue
 * nobody polls, a container mid-redeploy: all of them look like this timeout, and
 * a caller waits exactly this long before the audit starts running in the
 * function instead. Eight seconds matches the connect deadline in
 * `mcp-temporal.mjs`, for the same reason — it is long enough that a healthy
 * worker never trips it and short enough that a caller does not notice.
 */
const SCHEDULE_TO_START_MS = 8_000;

/**
 * How long one attempt of the activity may run before Temporal times it out.
 *
 * Above the 30s budget the activity itself is given, so a fast audit that spends
 * its whole budget still returns its own report — with the spent-budget note the
 * checks write — rather than being killed and retried into a second visit at the
 * target's origin.
 */
const START_TO_CLOSE_MS = 40_000;

/**
 * The budget handed to the activity, and it is lower than this endpoint's own.
 *
 * The activity's budget has to leave room for the round trip that carries it: a
 * budget equal to the endpoint's would mean the deadline here fires first every
 * time the audit ran long, turning a report that says "I ran out of time" into a
 * fallback that audits the same site a second time.
 */
const ACTIVITY_BUDGET_MS = 30_000;

/**
 * One retry and no more. Every attempt is a billable Action and a second visit to
 * the target's origin, so the retry is for a worker that died mid-task rather
 * than for a site that is having a bad day — a site having a bad day is a
 * finding, and the checks already report it as one.
 */
const MAXIMUM_ATTEMPTS = 2;

/**
 * The least budget a fallback audit is given, however late it starts.
 *
 * Only the fourth trigger can arrive here with the budget nearly gone, and the
 * arithmetic has to land somewhere: a fallback given what is literally left would
 * sometimes be given nothing and return a report of errors, and one given a fresh
 * budget could push the call past the function's own timeout. Ten seconds is
 * comfortably more than a healthy site's fast audit takes, and 45s + 10s stays
 * under the 60s floor every Vercel plan has offered — the same margin
 * `AUDIT_BUDGET_MS` is chosen for.
 */
const FALLBACK_FLOOR_MS = 10_000;

/** The suffix `fresh: true` appends. Eight characters, the same slice the deep tier's IDs use. */
function defaultSuffix() {
  return randomUUID().slice(0, 8);
}

/**
 * Was this start refused because an activity with the same ID has already run?
 *
 * Matched on the error's name rather than with `instanceof`, so a fake client in
 * a test can raise the condition without constructing an SDK error object. The
 * name is part of the SDK's public surface (`ActivityExecutionAlreadyStartedError`
 * is exported from `@temporalio/client`), which is what makes matching on it a
 * contract rather than a guess.
 */
function isAlreadyStarted(err) {
  return err?.name === 'ActivityExecutionAlreadyStartedError';
}

/**
 * The messages that name a wrapper rather than a cause. Measured against the local dev server on
 * 2026-09-04: a schedule-to-start timeout reaches a client as `ActivityExecutionFailedError:
 * Activity execution failed` with `TimeoutFailure: activity ScheduleToStart timeout` on `.cause`.
 */
const GENERIC_FAILURES = ['Activity execution failed', 'Activity task failed'];

/**
 * Why the standalone attempt failed, in the words of whatever actually stopped it.
 *
 * The same unwrapping `mcp-temporal.mjs`'s `failureMessage` does, and here for the same reason: the
 * log line is the only place a fallback's cause is ever written, and the four triggers are worth
 * telling apart. "Activity execution failed" is true of all four; "activity ScheduleToStart
 * timeout" says nobody is polling the queue.
 */
function describeFailure(err) {
  let current = err;
  let best = '';
  for (let depth = 0; current instanceof Error && depth < 6; depth++) {
    if (current.message && !GENERIC_FAILURES.includes(current.message)) best = current.message;
    current = current.cause;
  }
  if (best) return best;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The audit document, with the path it took recorded on its `tool` header.
 *
 * A copy rather than a mutation: the document may have come off a shared
 * activity's result, and writing into it would be writing into a value this
 * function does not own.
 */
export function withPath(audit, path) {
  return { ...audit, tool: { ...audit.tool, path } };
}

/**
 * Builds the `runAudit` the MCP server is handed.
 *
 * @param {{
 *   getClient: () => Promise<any>,
 *   runInFunction: (url: string, budgetMs: number) => Promise<any>,
 *   budgetMs: number,
 *   now?: () => Date,
 *   randomSuffix?: () => string,
 *   log?: (fields: Record<string, string | number>) => void,
 * }} deps
 * @returns {(url: string, options?: { fresh?: boolean, origin?: string }) => Promise<any>}
 */
export function createFastAuditRunner({
  getClient,
  runInFunction,
  budgetMs,
  now = () => new Date(),
  randomSuffix = defaultSuffix,
  log = () => {},
}) {
  return async function runAudit(url, { fresh = false, origin } = {}) {
    const startedAt = now().getTime();
    try {
      const audit = await withDeadline(
        standalone({ url, fresh, origin, getClient, now, randomSuffix }),
        budgetMs,
        'the audit worker',
      );
      return audit;
    } catch (err) {
      // Every trigger, one line, before the fallback rather than after it: the
      // wall time between this line and the success line is what a reader needs
      // to tell "no worker" from "slow worker" apart, and that is exactly the
      // measurement the card asks for after a week.
      log({
        path: '/mcp',
        outcome: 'fast-audit-fallback',
        reason: describeFailure(err),
      });
      // What is left of the one budget, never a fresh one — see the docblock.
      // Floored well above zero so a fallback that starts late still produces a
      // report rather than an immediately-exhausted one.
      const spent = now().getTime() - startedAt;
      const remaining = Math.max(FALLBACK_FLOOR_MS, budgetMs - spent);
      return withPath(await runInFunction(url, remaining), 'function');
    }
  };
}

/**
 * One standalone attempt: start the activity, or read back the result of the one
 * that already ran under this ID, and label which happened.
 *
 * Nothing here is caught. Every failure is the caller's fallback to make, and a
 * try/catch in the middle of this would be a second, quieter place for one of the
 * four triggers to be handled differently from the other three.
 */
async function standalone({ url, fresh, origin, getClient, now, randomSuffix }) {
  const client = await getClient();
  const base = fastAuditActivityIdFor(origin ?? url, now());
  // `fresh` skips both policies as well as adding the suffix. The suffix alone
  // would be enough to miss the hour's ID, so leaving the policies on would be
  // two rules with nothing left to say — and a reuse policy on an ID meant to be
  // unique is a rule waiting for the day the suffix repeats.
  const id = fresh ? `${base}:${randomSuffix()}` : base;

  let handle;
  let path = 'standalone';
  try {
    handle = await client.activity.start(AUDIT_FAST_ACTIVITY_TYPE, {
      id,
      taskQueue: AUDIT_FAST_TASK_QUEUE,
      args: [url, { budgetMs: ACTIVITY_BUDGET_MS }],
      scheduleToStartTimeout: SCHEDULE_TO_START_MS,
      startToCloseTimeout: START_TO_CLOSE_MS,
      retry: { maximumAttempts: MAXIMUM_ATTEMPTS },
      ...(fresh
        ? {}
        : { idConflictPolicy: 'USE_EXISTING', idReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY' }),
    });
  } catch (err) {
    if (!isAlreadyStarted(err)) throw err;
    // `ALLOW_DUPLICATE_FAILED_ONLY` refused this start, so an activity with this
    // ID closed *successfully* — which is to say somebody audited this site in
    // this hour and the answer exists. Reading it back is the dedup working, not
    // a failure, and it is the one case this module can honestly call shared. A
    // run that failed would not have refused the start at all; it would be
    // running again above.
    handle = client.activity.getHandle(id);
    path = 'standalone-shared';
  }

  return withPath(await handle.result(), path);
}
