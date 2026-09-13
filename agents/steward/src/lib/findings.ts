/**
 * The findings store's pure rules: the workflow ID, the slug check, the index
 * line format, and the four-field frontmatter edit.
 *
 * No imports, no clock, no environment, so the workflow sandbox, the activities,
 * the CLI and the tests all hold the same object. The ID in particular has to be
 * one function: the reconciler starts `finding/<site>/<key>` and the CLI signals
 * it, and two spellings of that string would be two gates that never meet.
 */

/** A verdict on a finding. `approved` and `rejected` are the only two the gate records. */
export type FindingVerdictStatus = 'approved' | 'rejected';

/**
 * Who delivered the verdict. `cli` is `steward finding approve|reject` on
 * matt-pc, and the workflow writes it into the file. `file` is the reconciler
 * carrying a verdict that was already in the file (Discord through Argus, or
 * Obsidian), and the workflow writes nothing.
 */
export type FindingVerdictSource = 'cli' | 'file';

export interface FindingVerdict {
  status: FindingVerdictStatus;
  reason: string;
  source: FindingVerdictSource;
  /** ISO 8601. Set by the sender: the CLI's clock, or the reconciler's workflow time. */
  at: string;
}

/**
 * Lower case letters, digits and hyphens, hyphen-separated runs allowed (keys
 * use `--` between the finding and the page). The same rule covers a site slug.
 * It is also the path guard: a key from the index becomes a file path in an
 * API call, so anything that could traverse is refused here.
 */
const SLUG = /^[a-z0-9]+(?:-+[a-z0-9]+)*$/;

export function isFindingSlug(value: string): boolean {
  return value.length <= 200 && SLUG.test(value);
}

/** `finding/<site>/<key>`. The one place this string is built. */
export function findingWorkflowId(site: string, key: string): string {
  return `finding/${site}/${key}`;
}

/** The inverse, for `steward finding list`. `undefined` for any other ID. */
export function parseFindingWorkflowId(id: string): { site: string; key: string } | undefined {
  const match = /^finding\/([^/]+)\/([^/]+)$/.exec(id);
  if (!match || !isFindingSlug(match[1]) || !isFindingSlug(match[2])) return undefined;
  return { site: match[1], key: match[2] };
}

export function findingsDir(site: string): string {
  return `sites/${site}/findings`;
}

export function findingPath(site: string, key: string): string {
  return `${findingsDir(site)}/${key}.md`;
}

export function findingsIndexPath(site: string): string {
  return `${findingsDir(site)}/INDEX.md`;
}

// ---------------------------------------------------------------------------
// INDEX.md
// ---------------------------------------------------------------------------

export interface FindingsIndexLine {
  key: string;
  status: string;
  /** The verdict reason column, trimmed; empty when there is none. */
  reason: string;
  /** Every column as found, for a rewrite that keeps the ones it does not own. */
  columns: string[];
  /** 0-based line number in the file. */
  lineNumber: number;
}

/**
 * Which column holds the verdict reason. Read off the file's own format line
 * (`` `key | status | title | verdict reason` ``) so a column added later (a
 * `kind`, say) moves the reason without breaking the parse. `key` and `status`
 * are always the first two, by position. Falls back to the fourth column.
 */
function reasonColumn(text: string): number {
  const format = /`([^`]*\|[^`]*)`/.exec(text);
  if (format) {
    const names = format[1].split('|').map((name) => name.trim().toLowerCase());
    const at = names.findIndex((name) => name.includes('reason'));
    if (at >= 2) return at;
  }
  return 3;
}

/**
 * One entry per finding line: a line with at least two ` | `-separated columns
 * whose first is a valid key. Headings, prose and the format line fall out.
 */
export function parseFindingsIndex(text: string): FindingsIndexLine[] {
  const reasonAt = reasonColumn(text);
  const lines = text.split(/\r?\n/);
  const entries: FindingsIndexLine[] = [];
  lines.forEach((line, lineNumber) => {
    if (!line.includes('|')) return;
    const columns = line.split('|').map((column) => column.trim());
    if (columns.length < 2 || !isFindingSlug(columns[0])) return;
    entries.push({
      key: columns[0],
      status: columns[1],
      reason: columns.length > reasonAt ? columns.slice(reasonAt).join(' | ').trim() : '',
      columns,
      lineNumber,
    });
  });
  return entries;
}

/** One line of prose for a table cell: no pipes, no line breaks. */
function cell(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim();
}

/**
 * The index with one finding's status and reason replaced and every other byte
 * kept. Throws when the key has no line, which the caller maps to a
 * non-retryable failure.
 */
export function setIndexVerdict(
  text: string,
  key: string,
  status: FindingVerdictStatus,
  reason: string,
): string {
  const reasonAt = reasonColumn(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const entry = parseFindingsIndex(text).find((e) => e.key === key);
  if (!entry) throw new Error(`INDEX.md has no line for ${key}`);
  const columns = entry.columns.slice(0, Math.max(reasonAt, 2));
  while (columns.length < reasonAt) columns.push('');
  columns[1] = status;
  columns[reasonAt] = cell(reason);
  lines[entry.lineNumber] = columns.join(' | ');
  return lines.join(eol);
}

// ---------------------------------------------------------------------------
// The finding file's frontmatter
// ---------------------------------------------------------------------------

/** The four fields the workflow owns (design decision 19). Argus owns every other one. */
export const VERDICT_FIELDS = ['status', 'verdict_reason', 'verdict_at', 'verdict_source'] as const;

/**
 * The finding file with the four verdict fields set and every other byte kept.
 *
 * A line edit rather than parse-and-restringify: re-serialising the YAML would
 * rewrite Argus's fields' formatting in the same commit, and the two-writer rule
 * is that the workflow touches its four fields and nothing else. The reason is
 * written as a JSON string, which is valid YAML and survives colons and quotes.
 * A field missing from the block is added before its closing `---`.
 */
export function setFrontmatterVerdict(text: string, verdict: FindingVerdict): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");

  const values: Record<(typeof VERDICT_FIELDS)[number], string> = {
    status: verdict.status,
    verdict_reason: JSON.stringify(verdict.reason.replace(/[\r\n]+/g, ' ').trim()),
    verdict_at: verdict.at,
    verdict_source: verdict.source,
  };

  const missing: string[] = [];
  for (const field of VERDICT_FIELDS) {
    const at = lines.findIndex((line, i) => i > 0 && i < close && new RegExp(`^${field}:`).test(line));
    const line = `${field}: ${values[field]}`;
    if (at >= 0) lines[at] = line;
    else missing.push(line);
  }
  lines.splice(close, 0, ...missing);
  return lines.join(eol);
}

// ---------------------------------------------------------------------------
// The reconciler's decision
// ---------------------------------------------------------------------------

export interface ReconcilePlan {
  /** `proposed` lines with no open workflow. */
  start: FindingsIndexLine[];
  /** `approved`/`rejected` lines whose workflow is open. */
  signal: FindingsIndexLine[];
  /** Everything else. */
  unchanged: number;
}

/**
 * What one site's index asks for, given the IDs of the open finding workflows.
 * Pure so the reconciler's whole decision is a unit test; the workflow only
 * carries it out.
 */
export function planReconcile(site: string, index: FindingsIndexLine[], openIds: string[]): ReconcilePlan {
  const open = new Set(openIds);
  const plan: ReconcilePlan = { start: [], signal: [], unchanged: 0 };
  for (const line of index) {
    const isOpen = open.has(findingWorkflowId(site, line.key));
    if (line.status === 'proposed' && !isOpen) plan.start.push(line);
    else if ((line.status === 'approved' || line.status === 'rejected') && isOpen) plan.signal.push(line);
    else plan.unchanged++;
  }
  return plan;
}
