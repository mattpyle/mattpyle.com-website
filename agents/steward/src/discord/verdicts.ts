import {
  FindingVerdictError,
  type FindingVerdictRequest,
  type FindingVerdictResult,
} from '../lib/finding-verdict.js';
import type { FindingVerdictStatus } from '../lib/findings.js';
import type { FindingRef } from '../lib/finding-ids.js';
import type { ResolvedFinding, ResolvedFindingId } from '../lib/finding-resolve-contract.js';
import { ResolverUnavailable, type FindingResolver } from './finding-resolver.js';

/**
 * A verdict on one or more findings, from ids to the answer text.
 *
 * Two steps. Every id is resolved first, by the hosted worker
 * (`finding-resolver.ts`), and if one names no finding, or more
 * than one, nothing is sent for any of them: a mistyped id is seen before a
 * verdict is recorded, and a word that only looks like an id cannot be dropped
 * from a reason unnoticed. Then each finding gets the verdict through
 * `sendFindingVerdict`, and each gets one line.
 *
 * The answer is written for a phone: one line per finding, the short id, the
 * short title, a colon, the outcome.
 */

/** The default approve reason: the reason text is where a Discord verdict is told apart. */
export const DISCORD_APPROVE_REASON = 'Approved by Matt via Discord command.';

/** As the console caps it. */
export const MAX_REASON_CHARS = 2000;

/** Verdicts sent at once. */
const PARALLEL = 4;

const MAX_TITLE_CHARS = 90;

export interface VerdictDeps {
  /** Which finding each id names. Throws `ResolverUnavailable` when the worker does not say. */
  resolve: FindingResolver;
  /** `sendFindingVerdict` bound to the service's Temporal client. `autoFix` is the finding's site's flag. */
  sendVerdict: (request: FindingVerdictRequest, autoFix: boolean) => Promise<FindingVerdictResult>;
  /** Where an unexpected failure is written; the answer never carries it. Null when no finding was reached. */
  onError?: (err: unknown, entry: ResolvedFinding | null) => void;
}

/** The answer when the worker did not say which findings the ids name. */
export const WORKER_DID_NOT_ANSWER = 'The worker did not answer, so the ids were not looked up. Nothing was sent. Try again in a minute.';
export const LOOKUP_FAILED = 'The worker could not look the ids up; its log has the error. Nothing was sent.';

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** `MP-121 Short title`, or the key when the file has no short id. */
export function findingLabel(entry: ResolvedFinding): string {
  const title = clip(entry.title, MAX_TITLE_CHARS);
  return entry.keyShort ? `${entry.keyShort} ${title}` : title === entry.key ? entry.key : `${entry.key} ${title}`;
}

/** A refusal's sentence without the CLI's own hints, which a phone cannot act on. */
function plain(message: string): string {
  return message
    .replace(/\s*Check `steward finding status [^`]*` or the workflow in \S+\.?$/, '')
    .replace(/\s*`steward finding list` shows the open ones\.$/, '')
    .trim();
}

/** The outcome of one verdict, as the words after the colon. */
export function outcomeText(result: FindingVerdictResult, autoFix: boolean): string {
  if (!result.first) {
    return `already recorded (${result.recorded.status} on ${result.recorded.at.slice(0, 10)})`;
  }
  // The next step exists only for an approval on a run that goes on to a fix.
  if (!result.nextStep) return 'recorded';
  return autoFix ? 'recorded; next: its checks, then the fix' : 'recorded; next: its checks, then it waits for Fix';
}

/** The words after the colon for a verdict that was not recorded. */
export function failureText(err: unknown): string {
  if (!(err instanceof FindingVerdictError)) return 'failed; the service log has the error';
  switch (err.kind) {
    case 'no-run':
      return 'no open run; nothing sent';
    case 'refused':
      return `refused: ${err.message.replace(/^Refused:\s*/, '').replace(/\s*Nothing was recorded\.$/, '')}`;
    case 'unaccepted':
    case 'old-worker':
      return `no worker answered. ${plain(err.message)}`;
    case 'timeout':
    case 'write-failed':
      return plain(err.message);
  }
}

function unresolvedLine(lookup: ResolvedFindingId): string | null {
  if ('found' in lookup) return null;
  if ('missing' in lookup) return `${lookup.id}: no such finding`;
  const names = lookup.ambiguous.map((entry) => `${entry.site}/${entry.key}`).join(', ');
  return `${lookup.id}: names ${lookup.ambiguous.length} findings (${names}); use site/key`;
}

/**
 * Sends `status` with `reason` to every finding `refs` names and returns the
 * answer: one line per finding.
 */
export async function decideFindings(
  refs: readonly FindingRef[],
  status: FindingVerdictStatus,
  reason: string,
  deps: VerdictDeps,
): Promise<string> {
  let lookups: ResolvedFindingId[];
  try {
    lookups = await deps.resolve(refs);
  } catch (err) {
    if (!(err instanceof ResolverUnavailable)) throw err;
    deps.onError?.(err.cause ?? err, null);
    return err.timedOut ? WORKER_DID_NOT_ANSWER : LOOKUP_FAILED;
  }
  const unresolved = lookups.map(unresolvedLine).filter((line): line is string => line !== null);
  if (unresolved.length > 0) {
    const sendable = lookups.length - unresolved.length;
    const held = sendable > 0 ? [`Nothing sent for the other ${sendable === 1 ? 'finding' : `${sendable} findings`}. Fix the id and send again.`] : [];
    return [...unresolved, ...held].join('\n');
  }

  // Two ids can name one finding (a short id and its key); it gets one verdict.
  const entries: ResolvedFinding[] = [];
  for (const lookup of lookups) {
    if ('found' in lookup && !entries.some((e) => e.site === lookup.found.site && e.key === lookup.found.key)) entries.push(lookup.found);
  }

  const lines = new Array<string>(entries.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      const entry = entries[i];
      let outcome: string;
      try {
        outcome = outcomeText(await deps.sendVerdict({ site: entry.site, key: entry.key, status, reason }, entry.autoFix), entry.autoFix);
      } catch (err) {
        if (!(err instanceof FindingVerdictError)) deps.onError?.(err, entry);
        outcome = failureText(err);
      }
      lines[i] = `${findingLabel(entry)}: ${outcome}`;
    }
  });
  await Promise.all(workers);
  return lines.join('\n');
}
