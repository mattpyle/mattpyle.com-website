/**
 * The look's pure rules (stage 5, slice A): Argus looked at an approved
 * finding on a site that watches, found it gone, and says so, by the
 * `record-look` Update or by the field `looked_fixed` in the finding file.
 *
 * No imports, no clock, no environment, so the workflow's validator, the
 * write activity and `watchFinding` hold the same tests.
 */

/**
 * An Argus run identifier: the UTC minute the run started, as
 * `date -u +%Y-%m-%dT%H%MZ` prints it, for example `2026-11-26T0830Z`. It goes
 * into the frontmatter and the commit message, so nothing else is accepted: a
 * free string could carry a new field or a new line.
 */
export const ARGUS_RUN_ID = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3])[0-5]\dZ$/;

export function isArgusRunId(value: unknown): value is string {
  return typeof value === 'string' && ARGUS_RUN_ID.test(value);
}

/** The `resolved_by` a look writes. No reader acts on it today; Argus's verify mode greps `deploy` alone. */
export const LOOK_RESOLVED_BY = 'review';

/** Who resolved the file a look found: this look, the run's own watch, or another writer. */
export type LookResolvedBy = 'look' | 'watch' | 'elsewhere';

/** The `## Re-check <run>` heading Argus appends; a note after the run is allowed. */
export function hasRecheckSection(text: string, run: string): boolean {
  const heading = `## Re-check ${run}`;
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trimEnd();
    return trimmed === heading || trimmed.startsWith(`${heading} `);
  });
}

/**
 * The finding file resolved by a look, every other byte kept: `status:
 * resolved`, `resolved_run: <run>` and `resolved_by: review`. An earlier
 * `resolved_by` is dropped. No section is added and no workflow ID is written:
 * `watchFinding` reads a resolved file that names its workflow as its own
 * lost result, and the look's resolve must not read as that.
 */
export function setFindingLookResolved(text: string, run: string): string {
  if (!isArgusRunId(run)) throw new Error(`"${run}" is not an Argus run identifier`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");

  const statusAt = lines.findIndex((line, i) => i > 0 && i < close && /^status:/.test(line));
  if (statusAt < 0) throw new Error('the finding has no status field');
  lines[statusAt] = 'status: resolved';

  let head = lines.slice(0, close).filter((line, i) => i === 0 || !/^resolved_by:/.test(line));
  let runAt = head.findIndex((line, i) => i > 0 && /^resolved_run:/.test(line));
  if (runAt >= 0) head[runAt] = `resolved_run: ${run}`;
  else {
    head = [...head, `resolved_run: ${run}`];
    runAt = head.length - 1;
  }
  head.splice(runAt + 1, 0, `resolved_by: ${LOOK_RESOLVED_BY}`);
  return [...head, ...lines.slice(close)].join(eol);
}

/** True for a file this look (or a look by its file field) already resolved. */
export function resolvedByLook(data: Record<string, unknown>, run: string): boolean {
  return data.status === 'resolved' && String(data.resolved_run ?? '') === run && data.resolved_by === LOOK_RESOLVED_BY;
}
