import { WorkflowNotFoundError } from '@temporalio/client';
import { findingPath, findingsIndexPath, isFindingSlug, parsePrUrl } from './findings.js';
import type { VerifyFindingInput } from '../workflows/verify-finding.js';

/**
 * What `steward finding verify` does after a hand verify ends `resolved` or
 * `confirmed`: the finding's open lifecycle run, `finding/<site>/<key>`, is
 * cancelled.
 *
 * A `reopened` finding gets a fresh lifecycle run from the reconciler, parked
 * at its verdict. When a corrected check then resolves the finding by hand,
 * that run has nothing left to do, and `steward finding approve` on it would
 * open a fix issue for a fix that is already live. A `fixing` finding's run,
 * still waiting on the merge or the deploy, would run its own verify against a
 * finding that is no longer `fixing`. Either way the run is cancelled.
 *
 * An `approved` finding whose fix landed outside its run, through a
 * hand-filed issue, has a run parked at `waiting-fix`; `--pr` records that fix
 * ({@link recordHandFix}) and the verify that follows closes the run the same
 * way.
 *
 * After `reopened` the run is left where it is: the finding still needs a
 * verdict or a fix.
 */

/** The two calls this needs from a `WorkflowHandle`. */
export interface LifecycleRunHandle {
  workflowId: string;
  describe(): Promise<{ status: { name: string } }>;
  cancel(): Promise<unknown>;
  result(): Promise<unknown>;
}

export type LifecycleRunClosed =
  /** No run was open: none started, or it already ended. */
  | 'none'
  /** The run was cancelled and has closed. */
  | 'cancelled'
  /** Cancellation was requested and the run had not closed by the deadline. */
  | 'requested';

/** How long the CLI waits for a cancelled run to close before it says the request stands. */
export const LIFECYCLE_CANCEL_WAIT_MS = 60_000;

export async function cancelLifecycleRun(
  handle: LifecycleRunHandle,
  waitMs = LIFECYCLE_CANCEL_WAIT_MS,
): Promise<LifecycleRunClosed> {
  try {
    if ((await handle.describe()).status.name !== 'RUNNING') return 'none';
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return 'none';
    throw err;
  }
  await handle.cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    handle.result().then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  clearTimeout(timer);
  return closed ? 'cancelled' : 'requested';
}

/** A refusal the operator can act on; the CLI prints the message alone. */
export class VerifyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyRefused';
  }
}

/**
 * `steward finding verify --root <prefix>`: a scratch copy of the findings
 * store inside the findings repository, as `scratch/<name>`, so a test run
 * through the real CLI reads and writes `scratch/<name>/sites/<site>/...` and
 * never `sites/<site>/`, where Argus reads and writes. The first segment is
 * `scratch` and each one after it is a slug; a trailing slash is dropped.
 */
export function parseScratchRoot(value: string): string {
  const root = value.replace(/\/+$/, '');
  const segments = root.split('/');
  if (segments.length < 2 || segments[0] !== 'scratch' || !segments.slice(1).every(isFindingSlug)) {
    throw new VerifyRefused(
      `--root ${value} is not scratch/<name>: the first segment is scratch, and each one after it lower case letters, digits and hyphens.`,
    );
  }
  return root;
}

/**
 * The finding and index paths a verify run reads and writes, frozen into its
 * input (design rule 10). With a root, both sit under it.
 */
export function verifyFindingPaths(site: string, key: string, root?: string): { findingPath: string; indexPath: string } {
  const prefix = root ? `${root}/` : '';
  return { findingPath: `${prefix}${findingPath(site, key)}`, indexPath: `${prefix}${findingsIndexPath(site)}` };
}

/** The input `steward finding verify` starts `verifyFindingWorkflow` with, every value resolved here. */
export function buildVerifyInput(opts: {
  site: string;
  key: string;
  repo: string;
  origin: string;
  at: string;
  reason?: string;
  root?: string;
}): VerifyFindingInput {
  return {
    site: opts.site,
    key: opts.key,
    repo: opts.repo,
    ...verifyFindingPaths(opts.site, opts.key, opts.root),
    origin: opts.origin,
    at: opts.at,
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
}

export interface HandFixDeps {
  /** `owner/name` of the findings repository. */
  repo: string;
  /** The finding file's parsed frontmatter, from the findings repository. */
  readFinding: (path: string) => Promise<{ data: Record<string, unknown> }>;
  /** Where the PR stands on GitHub. */
  readPr: (prUrl: string) => Promise<'open' | 'merged' | 'closed'>;
  /** `writeFindingFix`: `status: fixing` and `links.pr`, as the lifecycle writes them. */
  writeFix: (input: {
    repo: string;
    site: string;
    key: string;
    findingPath: string;
    indexPath: string;
    prUrl: string;
  }) => Promise<{ commitSha: string | null }>;
}

/**
 * `steward finding verify <key> --pr <url>`, before the verify: an `approved`
 * finding fixed by a merged PR its run never saw is written `fixing` with that
 * PR, so the verifier's gate admits it. Any other status is refused, and so is
 * a PR that is not merged: the verify would measure a fix that is not live.
 */
export async function recordHandFix(
  deps: HandFixDeps,
  site: string,
  key: string,
  prUrl: string,
): Promise<{ commitSha: string | null }> {
  if (!parsePrUrl(prUrl)) throw new VerifyRefused(`--pr ${prUrl} is not a GitHub pull request URL.`);
  const path = findingPath(site, key);
  const { data } = await deps.readFinding(path);
  if (data.status !== 'approved') {
    throw new VerifyRefused(
      `${key} is ${String(data.status ?? 'unset')}, not approved. --pr records a fix for an approved finding; verify a fixing or reopened one without it.`,
    );
  }
  const state = await deps.readPr(prUrl);
  if (state !== 'merged') throw new VerifyRefused(`${prUrl} is ${state}, not merged, so its fix is not on production.`);
  return deps.writeFix({ repo: deps.repo, site, key, findingPath: path, indexPath: findingsIndexPath(site), prUrl });
}
