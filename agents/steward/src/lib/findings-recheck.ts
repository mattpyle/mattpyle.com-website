/**
 * The recheck's pure half: which findings a recheck takes, what it reports for
 * each, and the `live_on` edit it writes. `recheckFindingsWorkflow` and its
 * activities use it; nothing here touches the network, Temporal or `node:`, so
 * the workflow bundle can import it.
 */

/** What one finding's recheck came to. */
export type RecheckOutcome =
  /** No `verify` key, or an empty list: nothing to measure, nothing written. */
  | 'no checks'
  /** A check failed: the problem is live, and `live_on` is set to the day. */
  | 'still present'
  /** Every check passed: the finding is resolved with its Verification section. */
  | 'resolved'
  /** Production did not answer, a check did not run, or the block was refused. Nothing written. */
  | 'could not measure'
  /** A lifecycle run is open on the finding, and owns its file. Nothing measured. */
  | 'has an open run'
  /** The file no longer reads approved and unresolved, though the index line does. Nothing measured. */
  | 'skipped'
  /** The checks ran, but writing their result failed. */
  | 'write failed';

export interface RecheckRow {
  key: string;
  /** `TI-24`, when the finding has one. */
  keyShort?: string;
  outcome: RecheckOutcome;
  /** One line: what failed, why it was not measured, or the day written. */
  detail?: string;
  /** The commit the write made; null when the file already said so. */
  commitSha?: string | null;
}

export interface RecheckFindingsInput {
  /** `owner/name` of the findings repository, frozen into the Schedule's action. */
  repo: string;
  /** The site folder under `sites/`. */
  site: string;
}

export interface RecheckFindingsResult {
  site: string;
  /** ISO 8601, when the run started, by the workflow clock. */
  at: string;
  rows: RecheckRow[];
}

/** The day an instant falls on in America/Vancouver, `YYYY-MM-DD`: the date `live_on` carries. */
export function vancouverDay(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The finding file with `live_on: <day>` and `live_by: check` (in that order)
 * in its frontmatter and every other byte kept. An existing `live_on` line is
 * replaced, and an existing `live_by` line, whatever it held, is replaced by
 * the one after `live_on`. A new `live_on` goes after the
 * last of `lives_in`, `evidence` and `importance_reason`, where the Argus skill
 * places the recheck fields, or at the end of the block when none is there.
 */
export function setFrontmatterLiveOn(text: string, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`live_on must be YYYY-MM-DD, not ${day}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");
  const line = `live_on: ${day}`;
  const byLine = 'live_by: check';
  const find = (field: string, end: number) => lines.findIndex((l, i) => i > 0 && i < end && l.startsWith(`${field}:`));
  let on = find('live_on', close);
  if (on >= 0) {
    lines[on] = line;
  } else {
    let after = -1;
    for (const field of ['importance_reason', 'evidence', 'lives_in']) {
      const at = find(field, close);
      if (at > after) after = at;
    }
    on = after >= 0 ? after + 1 : close;
    lines.splice(on, 0, line);
  }
  // `live_by` follows `live_on`; any existing line is dropped so exactly one remains.
  for (let i = lines.indexOf('---', 1) - 1; i > 0; i--) {
    if (lines[i].startsWith('live_by:')) {
      lines.splice(i, 1);
      if (i <= on) on--;
    }
  }
  lines.splice(on + 1, 0, byLine);
  return lines.join(eol);
}

/** `recheck/<site>/<stamp>` for a run started from the CLI. */
export function recheckWorkflowId(site: string, stamp: string): string {
  return `recheck/${site}/${stamp}`;
}

/** The CLI's and the log's one-line summary. */
export function summariseRecheck(result: RecheckFindingsResult): string {
  const counts = new Map<RecheckOutcome, number>();
  for (const row of result.rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  if (counts.size === 0) return `Findings recheck of ${result.site}: no approved finding to recheck.`;
  const parts = [...counts.entries()].map(([outcome, n]) => `${outcome} ${n}`);
  return `Findings recheck of ${result.site}: ${result.rows.length} approved, ${parts.join(', ')}.`;
}
