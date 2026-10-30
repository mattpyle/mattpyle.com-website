import type { Client } from '@temporalio/client';
import { installWithRetry } from './install-state.js';

/**
 * `steward update`: pull `master` and restart the laptop worker, refusing while
 * a fix is in flight.
 *
 * After a Steward merge the laptop worker holds old code until it restarts, and
 * a restart kills whatever activity it is running. The activity that matters is
 * `runFixer`, which has one attempt: killed mid-run, the fix fails. So the
 * command checks for a pending `steward-heavy` activity before it changes
 * anything, and every other step follows from that order.
 *
 * Everything that touches git, Temporal, the process table or npm is injected
 * ({@link UpdateDeps}), so the refusals are unit tests against fakes. The
 * orchestration here decides; `cli.ts` wires the real calls and then starts the
 * stack.
 */

/** Thrown for every refusal, so the CLI prints the message and exits 1. */
export class UpdateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateRefused';
  }
}

/**
 * The activity types a workflow schedules on `steward-heavy`: the laptop worker
 * is the only poller, so a restart interrupts them. Kept as a list rather than
 * read from the workflows, because a pending activity does not say which queue it
 * was scheduled on. `tests/lib/steward-update.test.ts` reads the workflow sources
 * and fails when this list and their `steward-heavy` activity proxies disagree.
 */
export const HEAVY_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  // reviewPost
  'buildAndAuditDraft',
  // fixFindingWorkflow, the frozen custom fixer
  'readFinding',
  'generateHandoff',
  'generateVerifyBlock',
  'readFixChecks',
  'runFindingChecks',
  'runFixer',
  'reviewFixDiff',
  'openFixerPr',
  'writeFindingFix',
  'awaitPreviewDeploy',
]);

/** One running workflow that holds a pending `steward-heavy` activity. */
export interface BusyWorkflow {
  workflowId: string;
  workflowType: string;
  activityType: string;
}

/** The slice of `Client` that {@link findBusyWorkflows} uses, so a test passes a fake. */
export type ListingClient = Pick<Client, 'workflow'>;

/**
 * Every running workflow with a pending activity whose type is in
 * {@link HEAVY_ACTIVITY_TYPES}, one row per such workflow.
 *
 * `describe()` per running workflow rather than a visibility query: pending
 * activities are not a search attribute. The namespace has a handful of running
 * workflows at a time (parked reviews, open finding runs), so the loop is short.
 */
export async function findBusyWorkflows(client: ListingClient): Promise<BusyWorkflow[]> {
  const busy: BusyWorkflow[] = [];
  for await (const info of client.workflow.list({ query: "ExecutionStatus='Running'" })) {
    const handle = client.workflow.getHandle(info.workflowId, info.runId);
    const description = await handle.describe();
    const pending = description.raw.pendingActivities ?? [];
    const heavy = pending.find((a) => HEAVY_ACTIVITY_TYPES.has(a.activityType?.name ?? ''));
    if (heavy) {
      busy.push({
        workflowId: info.workflowId,
        workflowType: info.type,
        activityType: heavy.activityType?.name ?? '',
      });
    }
  }
  return busy;
}

/** What a git call returned. A non-zero exit is a value, not a throw. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface UpdateDeps {
  /** Runs git in the main checkout. */
  git(args: string[]): Promise<GitResult>;
  /** A Temporal client for the busy check, with the connection it must close. */
  connect(): Promise<{ client: ListingClient; close(): Promise<void> }>;
  /** `steward down`'s teardown: the worker and, locally, the dev server. Returns how many trees it killed. */
  killOrphans(): Promise<number>;
  /** `npm ci` at the repository root. Throws `NpmCiError` on a non-zero exit. */
  npmCi(): Promise<void>;
  /** Waits until no process runs from `node_modules`, so `npm ci` can unlink every file. */
  waitForInstallRelease(): Promise<void>;
  /** Why the install differs from `package-lock.json`, or null when it matches. */
  installStaleReason(): Promise<string | null>;
  log(line: string): void;
}

export interface UpdateOptions {
  force: boolean;
}

export interface UpdateResult {
  from: string;
  to: string;
  /** True when `npm ci` ran: the lockfile changed between the commits, or the install was stale. */
  installed: boolean;
}

/**
 * `agents/steward/scripts/steward.mjs` is rewritten by `npm ci` with different
 * line endings and nothing else (`agents/steward/CLAUDE.md`, test suite note 7),
 * so a checkout with only that diff is clean.
 */
const EOL_ONLY_PATH = 'agents/steward/scripts/steward.mjs';

async function mustGit(deps: UpdateDeps, args: string[]): Promise<string> {
  const res = await deps.git(args);
  if (res.exitCode !== 0) {
    throw new UpdateRefused(`git ${args.join(' ')} failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

/** Tracked files that differ from HEAD, minus a line-ending-only change to the shim. */
async function dirtyTrackedFiles(deps: UpdateDeps): Promise<string[]> {
  const names = (await mustGit(deps, ['diff', 'HEAD', '--name-only']))
    .split(/\r?\n/)
    .map((n) => n.trim())
    .filter(Boolean);
  const dirty: string[] = [];
  for (const name of names) {
    if (name === EOL_ONLY_PATH) {
      const quiet = await deps.git(['diff', 'HEAD', '--ignore-cr-at-eol', '--quiet', '--', name]);
      if (quiet.exitCode === 0) continue;
    }
    dirty.push(name);
  }
  return dirty;
}

/**
 * The steps before the stack starts, in the order that leaves a refusal harmless:
 *
 * 1. The checkout is on `master` and has no tracked local changes. Untracked
 *    files do not count: a fast-forward never touches them.
 * 2. No running workflow holds a pending `steward-heavy` activity, unless
 *    `force`. Checked **before** the pull, so a refusal changes nothing and the
 *    same command works once the fix finishes. A Temporal that cannot be reached
 *    is a refusal too, since the check could not run.
 * 3. `git pull --ff-only`.
 * 4. Stop the running stack.
 * 5. `npm ci` when the install is stale: `node_modules/.package-lock.json`
 *    differs from `package-lock.json`, or is missing. Decided from the install
 *    itself and run whether or not `HEAD` moved, because a checkout moved by any
 *    other `git pull` keeps a stale `node_modules` (`lib/install-state.ts`). A
 *    lockfile that changed between the two commits also installs.
 */
export async function prepareUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<UpdateResult> {
  const branch = await mustGit(deps, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'master') {
    throw new UpdateRefused(
      `The main checkout is on "${branch}", not master. Switch it to master before updating; ` +
        'nothing was changed.',
    );
  }

  const dirty = await dirtyTrackedFiles(deps);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? `, and ${dirty.length - 5} more` : '');
    throw new UpdateRefused(
      `The main checkout has local changes (${shown}). Commit or stash them first; nothing was changed.`,
    );
  }

  if (options.force) {
    deps.log('--force: skipping the check for running heavy activities');
  } else {
    let connection: Awaited<ReturnType<UpdateDeps['connect']>>;
    try {
      connection = await deps.connect();
    } catch (err) {
      throw new UpdateRefused(
        `Could not reach Temporal to check for running heavy activities: ${err instanceof Error ? err.message : String(err)}. ` +
          'Nothing was changed. Fix the connection, or pass --force to update without the check.',
      );
    }
    let busy: BusyWorkflow[];
    try {
      busy = await findBusyWorkflows(connection.client);
    } finally {
      await connection.close();
    }
    if (busy.length > 0) {
      const lines = busy.map((b) => `  ${b.workflowId} (${b.workflowType}) is running ${b.activityType}`);
      throw new UpdateRefused(
        'Refusing to restart the worker: a restart would kill an activity on steward-heavy.\n' +
          `${lines.join('\n')}\n` +
          '  Nothing was changed. Run `steward update` again when it finishes, or pass --force to restart anyway.',
      );
    }
  }

  const from = await mustGit(deps, ['rev-parse', 'HEAD']);
  const pull = await deps.git(['pull', '--ff-only']);
  if (pull.exitCode !== 0) {
    throw new UpdateRefused(
      `git pull --ff-only failed (exit ${pull.exitCode}): ${pull.stderr.trim() || pull.stdout.trim()}. ` +
        'The worker was not touched.',
    );
  }
  const to = await mustGit(deps, ['rev-parse', 'HEAD']);

  const killed = await deps.killOrphans();
  deps.log(killed === 0 ? 'no running stack to stop' : `stopped ${killed} process tree(s)`);

  let installed = false;
  let reason: string | null = null;
  if (from !== to) {
    const changed = await mustGit(deps, ['diff', '--name-only', from, to, '--', 'package-lock.json']);
    if (changed !== '') reason = 'package-lock.json changed';
  }
  reason ??= await deps.installStaleReason();
  if (reason) {
    deps.log(`${reason}: running npm ci`);
    await installWithRetry(() => deps.npmCi(), () => deps.waitForInstallRelease());
    installed = true;
  }
  deps.log(from === to ? `already at ${to.slice(0, 7)}` : `${from.slice(0, 7)}..${to.slice(0, 7)}`);

  return { from, to, installed };
}
