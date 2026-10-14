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

// ---------------------------------------------------------------------------
// The fixer (findings-loop design, phase 5)
// ---------------------------------------------------------------------------

/** `fix/<site>/<key>`: a new execution beside `finding/<site>/<key>` (design decision 18). */
export function fixWorkflowId(site: string, key: string): string {
  return `fix/${site}/${key}`;
}

/** `sites/<site>/handoffs/<key>.md`, the generated handoff's home (design decision 20). */
export function findingHandoffPath(site: string, key: string): string {
  return `sites/${site}/handoffs/${key}.md`;
}

/** The fixer's own branch prefix, so its PRs are told apart from a person's at a glance. */
export function fixBranch(key: string): string {
  return `fix/finding-${key}`;
}

export interface FindingBullet {
  /** The text before the first colon: `URL`, `Expected`, `Cause, from the source`. */
  label: string;
  text: string;
}

export interface ParsedFinding {
  /** The H1, the finding in one line. */
  title: string;
  /** Each `##` section's body, keyed by its heading in lower case. */
  sections: Record<string, string>;
  /** The labelled bullets of "What happened", the cause excluded. */
  evidence: FindingBullet[];
  /** The bullet whose label starts with "Cause", or null when the finding names none. */
  cause: string | null;
  /** The body of "How to measure", or null. */
  measure: string | null;
}

/** Argus hard-wraps its prose; a wrapped paragraph or bullet reads as one line here. */
function unwrap(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * The finding's body, read for the fixer: the line, the evidence, the cause and
 * the measure. The template is Argus's (`skills/argus-inspect/templates/finding.md`);
 * a finding that lacks a part comes back with that part empty or null, and the
 * caller decides whether it can be fixed without it.
 */
export function parseFindingBody(text: string): ParsedFinding {
  const lines = text.split(/\r?\n/);
  let start = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) start = close + 1;
  }
  let title = '';
  const sections: Record<string, string> = {};
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (heading !== null) sections[heading] = buffer.join('\n').trim();
    buffer = [];
  };
  for (const line of lines.slice(start)) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      heading = h2[1].toLowerCase();
    } else if (h1 && !title && heading === null) {
      title = h1[1];
    } else {
      buffer.push(line);
    }
  }
  flush();

  const bullets: FindingBullet[] = [];
  for (const raw of (sections['what happened'] ?? '').split(/\r?\n(?=- )/)) {
    if (!raw.startsWith('- ')) continue;
    const item = unwrap(raw.slice(2));
    const colon = item.indexOf(': ');
    if (colon > 0 && colon <= 40) bullets.push({ label: item.slice(0, colon), text: item.slice(colon + 2).trim() });
    else bullets.push({ label: '', text: item });
  }
  const cause = bullets.find((b) => /^cause\b/i.test(b.label));
  const measure = sections['how to measure'] ? unwrap(sections['how to measure']) : null;

  return {
    title: unwrap(title),
    sections,
    evidence: bullets.filter((b) => b !== cause),
    cause: cause ? cause.text : null,
    measure: measure || null,
  };
}

/**
 * Why a finding cannot go to the fixer, or null when it can (the card's
 * decision 4): approved, a defect, with a cause named in the source and a
 * measure to verify against. Opportunities and directions stay Matt's.
 */
export function fixRefusal(data: Record<string, unknown>, parsed: ParsedFinding): string | null {
  if (data.status !== 'approved') return `its status is ${String(data.status ?? 'unset')}, not approved`;
  if (data.kind !== 'defect') return `its kind is ${String(data.kind ?? 'unset')}, not defect`;
  if (!parsed.title) return 'it has no title line';
  if (!parsed.cause) return 'its "What happened" names no cause';
  if (!parsed.measure) return 'it has no "How to measure"';
  return null;
}

/**
 * The finding file with `status: fixing` and `links.pr` set and every other
 * byte kept: the same line edit as {@link setFrontmatterVerdict}, for the two
 * fields the fixer owns. `links` is a block mapping, so a later writer (the
 * verifier's comment, an extracted rule) adds its own key beside `pr`.
 */
export function setFrontmatterFix(text: string, prUrl: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");
  const inBlock = (i: number) => i > 0 && i < close;

  const statusAt = lines.findIndex((line, i) => inBlock(i) && /^status:/.test(line));
  if (statusAt < 0) throw new Error('the finding has no status field');
  lines[statusAt] = 'status: fixing';

  const pr = `  pr: ${prUrl}`;
  const linksAt = lines.findIndex((line, i) => inBlock(i) && /^links:/.test(line));
  if (linksAt < 0) {
    lines.splice(close, 0, 'links:', pr);
    return lines.join(eol);
  }
  if (!/^links:\s*(\{\s*\})?\s*$/.test(lines[linksAt])) {
    throw new Error('the finding\'s links field is not a block mapping');
  }
  lines[linksAt] = 'links:';
  let end = linksAt + 1;
  while (end < close && /^\s+\S/.test(lines[end])) end++;
  const prAt = lines.findIndex((line, i) => i > linksAt && i < end && /^\s+pr:/.test(line));
  if (prAt >= 0) lines[prAt] = pr;
  else lines.splice(linksAt + 1, 0, pr);
  return lines.join(eol);
}

// ---------------------------------------------------------------------------
// The verifier (findings-loop design, phase 5)
// ---------------------------------------------------------------------------

/** What a verify run decides. `unverifiable` writes nothing: the block it took is empty. */
export type VerifyOutcome = 'resolved' | 'reopened' | 'unverifiable';

/**
 * Where a verify run took its checks from: the finding's own `verify` key,
 * written by the finder before any fix existed, or, only when the finding has
 * no such key, the fixer's handoff or a block generated into it.
 */
export type VerifyBlockSource = 'finding' | 'handoff' | 'generated';

/** `finding`, `handoff (fallback)` or `generated (fallback)`: the source as the section and the CLI name it. */
export function verifySourceLabel(source: VerifyBlockSource): string {
  return source === 'finding' ? 'finding' : `${source} (fallback)`;
}

/** `2026-10-13T041233Z` from an ISO instant: the stamp in a verify workflow's ID. */
export function verifyStamp(at: string): string {
  return at.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '').replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
}

/** `2026-10-13T0412Z`, the shape Argus gives a run ID, for `resolved_run`. */
export function verifyRunId(at: string): string {
  return verifyStamp(at).replace(/\d{2}Z$/, 'Z');
}

/**
 * `verify/<site>/<key>/<stamp>`: one execution per verify run, so a finding
 * verified twice has two histories.
 */
export function verifyWorkflowId(site: string, key: string, at: string): string {
  return `verify/${site}/${key}/${verifyStamp(at)}`;
}

/**
 * Why a finding cannot be verified, or null when it can: the verifier takes
 * `fixing` findings, the ones a merged fixer PR left behind.
 */
export function verifyRefusal(data: Record<string, unknown>): string | null {
  if (data.status !== 'fixing') return `its status is ${String(data.status ?? 'unset')}, not fixing`;
  if (!parsePrUrl(fixPrUrl(data))) return 'it has no links.pr to a pull request';
  return null;
}

/** The fixer's PR, as `writeFindingFix` left it in `links.pr`. */
export function fixPrUrl(data: Record<string, unknown>): string {
  const links = data.links;
  const pr = typeof links === 'object' && links !== null ? (links as Record<string, unknown>).pr : undefined;
  return typeof pr === 'string' ? pr : '';
}

/** `owner/name` and the number from a GitHub pull request URL, or null for anything else. */
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/** One measured check, as the Verification section prints it. */
export interface VerificationRow {
  n: number;
  url: string;
  kind: string;
  pass: boolean;
  expected: string;
  measured: string;
}

export interface Verification {
  status: 'resolved' | 'reopened';
  /** ISO 8601, when the checks ran. */
  at: string;
  workflowId: string;
  /** Where the checks came from. */
  source: VerifyBlockSource;
  rows: VerificationRow[];
}

/** The `## Verification` section: the outcome, then each check with both values. */
export function buildVerificationSection(verification: Verification): string {
  const lines = [
    '## Verification',
    '',
    `Steward ran this finding's checks against production at ${verification.at}. Outcome: ${verification.status}. Workflow \`${verification.workflowId}\`.`,
    '',
    `Checks from: ${verifySourceLabel(verification.source)}.`,
    '',
  ];
  for (const row of verification.rows) {
    lines.push(
      `${row.n}. ${row.pass ? 'Pass' : 'Fail'}, \`${row.kind}\` on ${row.url}. Expected: ${row.expected}. Measured: ${row.measured}.`,
    );
  }
  return lines.join('\n');
}

/**
 * The finding file with the verifier's result in it and every other byte kept:
 * `status`, `resolved_run` when it resolved, and one `## Verification` section
 * at the end of the body. A section from an earlier run is replaced, so the
 * file holds the latest measurement.
 */
export function setFindingVerification(text: string, verification: Verification): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");
  const inBlock = (i: number) => i > 0 && i < close;

  const statusAt = lines.findIndex((line, i) => inBlock(i) && /^status:/.test(line));
  if (statusAt < 0) throw new Error('the finding has no status field');
  lines[statusAt] = `status: ${verification.status}`;

  let head = lines.slice(0, close);
  if (verification.status === 'resolved') {
    const run = `resolved_run: ${verifyRunId(verification.at)}`;
    const runAt = head.findIndex((line, i) => i > 0 && /^resolved_run:/.test(line));
    if (runAt >= 0) head[runAt] = run;
    else head = [...head, run];
  }

  const body = lines.slice(close);
  const sectionAt = body.findIndex((line) => /^##\s+Verification\s*$/.test(line));
  if (sectionAt >= 0) {
    let end = body.findIndex((line, i) => i > sectionAt && /^##\s/.test(line));
    if (end < 0) end = body.length;
    body.splice(sectionAt, end - sectionAt);
  }
  while (body.length > 1 && body[body.length - 1].trim() === '') body.pop();
  body.push('', ...buildVerificationSection(verification).split('\n'), '');
  return [...head, ...body].join(eol);
}

/**
 * The index with one finding's status replaced and every other byte kept,
 * the verdict reason included: `fixing` is a state, not a verdict.
 */
export function setIndexStatus(text: string, key: string, status: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const entry = parseFindingsIndex(text).find((e) => e.key === key);
  if (!entry) throw new Error(`INDEX.md has no line for ${key}`);
  const parts = lines[entry.lineNumber].split('|');
  parts[1] = ` ${status} `;
  lines[entry.lineNumber] = parts.join('|');
  return lines.join(eol);
}

// ---------------------------------------------------------------------------
// The lifecycle: merge wait, deploy wait (fixer-merge-and-verify)
// ---------------------------------------------------------------------------

/**
 * The finding file back at `approved` after its fixer PR closed unmerged, every
 * other byte kept: `status`, and one line under `## Fix attempts` naming the
 * closed PR. Lines from earlier attempts stay, so the file holds every closed
 * PR. `links.pr` keeps the closed PR until the next fix writes its own.
 */
export function setFindingReturned(text: string, prUrl: string, at: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");

  const statusAt = lines.findIndex((line, i) => i > 0 && i < close && /^status:/.test(line));
  if (statusAt < 0) throw new Error('the finding has no status field');
  lines[statusAt] = 'status: approved';

  const note = `- ${at}: ${prUrl} closed unmerged. The finding is approved again.`;
  if (lines.includes(note)) return lines.join(eol);

  const sectionAt = lines.findIndex((line, i) => i > close && /^##\s+Fix attempts\s*$/.test(line));
  if (sectionAt >= 0) {
    let end = lines.findIndex((line, i) => i > sectionAt && /^##\s/.test(line));
    if (end < 0) end = lines.length;
    while (end > sectionAt + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, note);
    return lines.join(eol);
  }
  while (lines.length > close + 1 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push('', '## Fix attempts', '', note, '');
  return lines.join(eol);
}

/** One GitHub deployment with its newest status, as the deploy wait reads them. */
export interface DeploymentRecord {
  id: number;
  sha: string;
  /** The newest status's state: `success`, `failure`, `in_progress`, `inactive` and so on. */
  state: string;
}

/**
 * The deployment production serves: the newest one whose newest status is
 * `success`. Vercel posts its `Production` deployment to GitHub when the build
 * completes, with one `success` status, so a newer failed or pending one is
 * skipped and the one before it is still live. `undefined` when none succeeded.
 *
 * `deployments` is newest first, as GitHub lists them.
 */
export function liveDeployment(deployments: DeploymentRecord[]): DeploymentRecord | undefined {
  return deployments.find((d) => d.state === 'success');
}

/**
 * Whether a compare from the merge commit to the live commit says the live one
 * contains it. GitHub's `compare/<base>...<head>` answers `identical` or `ahead`
 * when every commit of `base` is in `head`; `behind` and `diverged` mean it is
 * not.
 */
export function compareContains(status: string): boolean {
  return status === 'identical' || status === 'ahead';
}
