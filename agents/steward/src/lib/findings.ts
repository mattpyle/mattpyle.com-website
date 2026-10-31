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
  /** The `kind` column (`defect`, `opportunity`, `direction`); empty when the format line names none. */
  kind: string;
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
  const at = formatColumns(text).findIndex((name) => name.includes('reason'));
  return at >= 2 ? at : 3;
}

/** The `kind` column named on the format line, or -1 when it names none. */
function kindColumn(text: string): number {
  const at = formatColumns(text).indexOf('kind');
  return at >= 2 ? at : -1;
}

/** The format line's column names, lower case; empty when the file has none. */
function formatColumns(text: string): string[] {
  const format = /`([^`]*\|[^`]*)`/.exec(text);
  return format ? format[1].split('|').map((name) => name.trim().toLowerCase()) : [];
}

/**
 * One entry per finding line: a line with at least two ` | `-separated columns
 * whose first is a valid key. Headings, prose and the format line fall out.
 */
export function parseFindingsIndex(text: string): FindingsIndexLine[] {
  const reasonAt = reasonColumn(text);
  const kindAt = kindColumn(text);
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
      kind: kindAt >= 0 && kindAt < reasonAt ? (columns[kindAt] ?? '') : '',
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

/**
 * One running `findingWorkflow` as the reconciler sees it: its ID, and where
 * its `state` query says it is. `step` and `fixAttempts` are null when the
 * query gave no answer, and for a bare ID, which is what the list returned
 * before it carried them.
 */
export interface OpenFindingWorkflow {
  workflowId: string;
  step: string | null;
  fixAttempts: number | null;
}

export interface ReconcilePlan {
  /** `proposed` and `reopened` lines with no open workflow. */
  start: FindingsIndexLine[];
  /** `approved`/`rejected` lines whose workflow is open and still waits for its verdict. */
  signal: FindingsIndexLine[];
  /** Approved defects parked at `waiting-fix` with no attempt, on an `auto_fix` site. */
  fix: FindingsIndexLine[];
  /** Everything else. */
  unchanged: number;
}

function openById(open: (OpenFindingWorkflow | string)[]): Map<string, OpenFindingWorkflow> {
  return new Map(
    open.map((o) => (typeof o === 'string' ? { workflowId: o, step: null, fixAttempts: null } : o)).map((o) => [o.workflowId, o]),
  );
}

/**
 * Whether a started run should park without the automatic fix attempt: the
 * line names a kind and it is not `defect`. A line that names none (an index
 * with no kind column) starts as it always did.
 */
export function startsParked(line: FindingsIndexLine): boolean {
  return line.kind !== '' && line.kind !== 'defect';
}

function parkedDefect(line: FindingsIndexLine, run: OpenFindingWorkflow | undefined): boolean {
  return line.status === 'approved' && line.kind === 'defect' && run?.step === 'waiting-fix' && run.fixAttempts === 0;
}

/**
 * Whether the site has an approved defect whose run waits at `waiting-fix`
 * with no attempt: the one case where the reconciler needs the site's
 * `auto_fix` flag, so a site without one costs no config read.
 */
export function hasParkedDefect(site: string, index: FindingsIndexLine[], open: (OpenFindingWorkflow | string)[]): boolean {
  const runs = openById(open);
  return index.some((line) => parkedDefect(line, runs.get(findingWorkflowId(site, line.key))));
}

/**
 * What one site's index asks for, given the open finding workflows and the
 * site's `auto_fix` flag. Pure so the reconciler's whole decision is a unit
 * test; the workflow only carries it out.
 *
 * A `reopened` line is a `proposed` one again (design decision 29): its fix
 * failed on production, so it goes back to the verdict gate.
 *
 * A verdict goes only to a run still at `waiting-verdict`, or one whose step
 * is unknown; a run past its verdict would drop it.
 *
 * `fix` is the parked case (design decision 31): a run reads `auto_fix` once,
 * at its verdict, so one that passed it before the flag was set waits for a
 * `fix` nobody sends. Zero attempts only, so a failed attempt stays a
 * person's retry. Opportunities and directions are never sent.
 */
export function planReconcile(
  site: string,
  index: FindingsIndexLine[],
  open: (OpenFindingWorkflow | string)[],
  autoFix = false,
): ReconcilePlan {
  const runs = openById(open);
  const plan: ReconcilePlan = { start: [], signal: [], fix: [], unchanged: 0 };
  for (const line of index) {
    const run = runs.get(findingWorkflowId(site, line.key));
    const awaitingVerdict = run !== undefined && (run.step === null || run.step === 'waiting-verdict');
    if ((line.status === 'proposed' || line.status === 'reopened') && !run) plan.start.push(line);
    else if ((line.status === 'approved' || line.status === 'rejected') && awaitingVerdict) plan.signal.push(line);
    else if (autoFix && parkedDefect(line, run)) plan.fix.push(line);
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
 * The custom fixer's gate (the card's decision 4): approved, a defect, with a
 * cause named in the source and a measure to verify against. The frozen
 * `fixFindingWorkflow` keeps this rule so its replays do not move; every other
 * caller uses {@link fixRefusal}.
 */
export function defectFixRefusal(data: Record<string, unknown>, parsed: ParsedFinding): string | null {
  if (data.status !== 'approved') return `its status is ${String(data.status ?? 'unset')}, not approved`;
  if (data.kind !== 'defect') return `its kind is ${String(data.kind ?? 'unset')}, not defect`;
  if (!parsed.title) return 'it has no title line';
  if (!parsed.cause) return 'its "What happened" names no cause';
  if (!parsed.measure) return 'it has no "How to measure"';
  return null;
}

/** `/about/` and `/about` are one page; a query or fragment names the same page. */
function pagePath(raw: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(raw, 'https://page.invalid').pathname;
  } catch {
    return null;
  }
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The pages a finding's fix is about, as distinct paths: the URLs of its
 * `verify` checks, or, when that block is empty, the URLs and the leading-slash
 * paths in the body's "What would serve them". A source path such as
 * `src/content/x.md` has a letter before its slash and is not a page.
 */
export function findingPages(data: Record<string, unknown>, parsed: ParsedFinding): string[] {
  const pages = new Set<string>();
  const add = (raw: string) => {
    const path = pagePath(raw);
    if (path) pages.add(path);
  };

  if (Array.isArray(data.verify)) {
    for (const check of data.verify) {
      const url = check && typeof check === 'object' ? (check as { url?: unknown }).url : undefined;
      for (const one of Array.isArray(url) ? url : [url]) if (typeof one === 'string') add(one);
    }
  }
  if (pages.size > 0) return [...pages];

  const serve = parsed.sections['what would serve them'] ?? '';
  const bare = serve.replace(/https?:\/\/[^\s)\]>"'`,;]+/g, (url) => {
    add(url.replace(/[.:]+$/, ''));
    return ' ';
  });
  for (const match of bare.matchAll(/(?<![\w./:@~-])\/[\w~%-]+(?:[\w.~%/-]*[\w~%/-])?/g)) add(match[0]);
  return [...pages];
}

/**
 * Why a finding cannot go to the fixer, or null when it can: approved, with a
 * title and a measure to verify against, and either
 *
 * 1. a defect that names its cause in the source, or
 * 2. an opportunity whose fix is one change on one page, told by
 *    {@link findingPages}. A cause is not asked of it: an opportunity has none.
 *
 * Directions, and opportunities that name several pages or none, stay a
 * person's.
 */
export function fixRefusal(data: Record<string, unknown>, parsed: ParsedFinding): string | null {
  if (data.kind !== 'opportunity') {
    if (data.status === 'approved' && data.kind !== 'defect') {
      return `its kind is ${String(data.kind ?? 'unset')}, not defect or opportunity`;
    }
    return defectFixRefusal(data, parsed);
  }
  if (data.status !== 'approved') return `its status is ${String(data.status ?? 'unset')}, not approved`;
  if (!parsed.title) return 'it has no title line';
  if (!parsed.measure) return 'it has no "How to measure"';
  const pages = findingPages(data, parsed);
  if (pages.length === 0) {
    return 'it names no page: its verify block has no URL and "What would serve them" gives no page path';
  }
  if (pages.length > 1) return `it names more than one page (${pages.join(', ')}), so its fix is not one change`;
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
// The fix issue (findings-loop design, decisions 26 to 28)
// ---------------------------------------------------------------------------

/** GitHub refuses an issue title over 256 characters. */
const ISSUE_TITLE_MAX = 256;

/**
 * The six lines above the finding in a fix issue, as the spike's issue 358 was
 * written. `@claude` is what starts `claude-code-action` (`claude.yml`'s `if`).
 */
export const FIX_ISSUE_HEADER = [
  '@claude Fix the approved finding below.',
  '',
  'Rules: one finding, one fix, one PR. Change only what the finding needs; no adjacent tidying. The Verdict line below is the scope: a part it rejects is out of scope. Run `npm test` and `npm run check` before you push and leave both passing. Open the PR yourself. Keep the PR body short: what changed, why, and the evidence. The PR is done when the "How to measure" check passes on the Vercel preview.',
  '',
  '---',
  '',
  '',
].join('\n');

/**
 * The hidden line that ties an issue to its finding, so a retried
 * `openFixIssue` finds the issue it already opened.
 */
export function fixIssueMarker(site: string, key: string): string {
  return `<!-- steward-finding: ${site}/${key} -->`;
}

/** The finding's H1, cut to GitHub's title limit. */
export function fixIssueTitle(text: string): string {
  const title = parseFindingBody(text).title;
  return title.length <= ISSUE_TITLE_MAX ? title : `${title.slice(0, ISSUE_TITLE_MAX - 1)}…`;
}

/**
 * `Verdict: approved. <reason>`, the line the spike put under the H1 and the
 * issue's scope line: the header tells the Action a part the reason rejects is
 * out of scope. A reason that already opens with "Approved" is kept as the
 * verdict's own words, so "approved in part: X; rejected: Y" reaches the Action
 * verbatim. A bare "approve" adds nothing and is dropped; a reason that runs
 * over several lines is joined to one.
 */
export function fixIssueVerdictLine(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (!text || /^approved?\.?$/i.test(text)) return 'Verdict: approved.';
  if (/^approved\b/i.test(text)) return `Verdict: a${text.slice(1)}`;
  return `Verdict: approved. ${text}`;
}

/**
 * The finding's `verify:` block as written in its frontmatter, from the key to
 * the line before the next top-level key, or null when the file has no
 * frontmatter or no such key. Verbatim, comments and quoting included: the
 * fixer greps its tree for the same needles the checks count.
 */
export function verifyBlockSource(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const close = lines.indexOf('---', 1);
  if (close < 0) return null;
  const front = lines.slice(1, close);
  const at = front.findIndex((line) => /^verify:/.test(line));
  if (at < 0) return null;
  let end = at + 1;
  // A sequence may sit at the key's own indent, so a `-` line belongs to it.
  while (end < front.length && /^(\s|-|#|$)/.test(front[end])) end++;
  const block = front.slice(at, end);
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
  return block.join('\n');
}

/** The heading over the verify block in a fix issue. */
export const FIX_ISSUE_VERIFY_HEADING = '## Verify checks';

/**
 * The fix issue's verify section, or an empty list when the finding has no
 * checks to run (no key, or `verify: []`): the block verbatim in a fence, under
 * a heading that says when it runs.
 */
export function fixIssueVerifyLines(text: string): string[] {
  const block = verifyBlockSource(text);
  if (block === null || /^verify:\s*\[\s*\]\s*(#.*)?$/.test(block.trim())) return [];
  return [
    FIX_ISSUE_VERIFY_HEADING,
    '',
    "Steward runs these checks on this PR's Vercel preview before the merge, and on production after it. Each `text` needle must read on your tree as its check expects. Search your tree for every needle before you push.",
    '',
    '```yaml',
    block,
    '```',
  ];
}

/**
 * The fix issue's body: the header, the finding with its frontmatter dropped and
 * the verdict line under its H1, the finding's verify block when it has one, and
 * the marker last. `verdictReason` is the file's `verdict_reason`, parsed by the
 * caller.
 */
export function fixIssueBody(site: string, key: string, text: string, verdictReason: unknown): string {
  const lines = text.split(/\r?\n/);
  let start = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) start = close + 1;
  }
  const body = lines.slice(start);
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  const h1 = body.findIndex((line) => /^#\s+\S/.test(line));
  if (h1 >= 0) body.splice(h1 + 1, 0, '', fixIssueVerdictLine(verdictReason));
  const verify = fixIssueVerifyLines(text);
  if (verify.length > 0) body.push('', ...verify);
  return `${FIX_ISSUE_HEADER}${body.join('\n')}\n\n${fixIssueMarker(site, key)}\n`;
}

/**
 * The comment on an issue a second fix attempt closes: why the last attempt
 * ended, which names the PR when one closed unmerged (the card's rule 2).
 */
export function fixIssueClosingComment(reason: string): string {
  const why = reason.trim().replace(/\.$/, '') || 'the attempt ended without a merged fix';
  return `Closed by Steward: ${why}. The next fix attempt opens a new issue.`;
}

/** The head branch prefix `claude-code-action` gives the PR it opens from issue `n`. */
export function fixPrBranchPrefix(issueNumber: number): string {
  return `claude/issue-${issueNumber}-`;
}

/** `owner/name` and the number from a GitHub issue URL, or null for anything else. */
export function parseIssueUrl(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(url);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/** `sites/<site>/config.yaml` in the findings repository. */
export function siteConfigPath(site: string): string {
  return `sites/${site}/config.yaml`;
}

// ---------------------------------------------------------------------------
// The verifier (findings-loop design, phase 5)
// ---------------------------------------------------------------------------

/**
 * What a verify run decides. `resolved` and `reopened` are measured by the
 * finding's checks. `confirmed` is a finding with no checks resolved by its
 * deploy: production serves a commit that contains the fix PR's merge (design
 * decision 30). `unverifiable` is what a blockless verify ended as before
 * that, kept so recorded histories decode; nothing produces it now.
 */
export type VerifyOutcome = 'resolved' | 'reopened' | 'confirmed' | 'unverifiable';

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
 * `fixing` findings, the ones a merged fixer PR left behind, and `reopened`
 * ones. A `reopened` finding still names the PR whose fix its checks failed
 * on, and when a check could not measure that fix, a corrected check is
 * re-run against the same PR. The workflow's merged-PR gate covers both.
 */
export function verifyRefusal(data: Record<string, unknown>): string | null {
  if (data.status !== 'fixing' && data.status !== 'reopened') {
    return `its status is ${String(data.status ?? 'unset')}, not fixing or reopened`;
  }
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
  /** One URL, or the check's list of URLs. */
  url: string | string[];
  kind: string;
  pass: boolean;
  expected: string;
  measured: string;
  /** `selector` and `js` only: the size the page was opened at. */
  viewport?: string;
}

/** What a deploy-resolved finding's Verification section names: the fix and the commit production serves. */
export interface VerificationDeploy {
  prUrl: string;
  mergeSha: string;
  liveSha: string;
}

export interface Verification {
  status: 'resolved' | 'reopened';
  /** ISO 8601, when the checks ran, or when production was read for a deploy-resolved finding. */
  at: string;
  workflowId: string;
  /** Where the checks came from. */
  source: VerifyBlockSource;
  rows: VerificationRow[];
  /** Set when no check ran and the deploy is the evidence: the finding is written `resolved_by: deploy`. */
  deploy?: VerificationDeploy;
  /** `steward finding verify --reason`: one line, attributed to the CLI. */
  reason?: string;
}

/** A row's URL, or the count and every URL of a list: `urlLabel` in `verify-checks.ts`, kept here since this file takes no imports. */
function rowUrlLabel(url: string | string[]): string {
  return Array.isArray(url) ? `${url.length} URLs (${url.join(', ')})` : url;
}

/**
 * The `## Verification` section: the outcome, then each check with both
 * values. A deploy-resolved finding has no rows: the section says no check
 * could measure the fix, and names the PR, its merge commit and the live
 * commit instead.
 */
export function buildVerificationSection(verification: Verification): string {
  const { deploy } = verification;
  const lines = ['## Verification', ''];
  if (deploy) {
    lines.push(
      `Steward confirmed this finding's fix by its deploy at ${verification.at}. Outcome: confirmed. Workflow \`${verification.workflowId}\`.`,
      '',
      `No check could measure the fix: the finding has no verify block. ${deploy.prUrl} merged as \`${deploy.mergeSha}\`, and production serves \`${deploy.liveSha}\`, which contains it.`,
      '',
    );
  } else {
    lines.push(
      `Steward ran this finding's checks against production at ${verification.at}. Outcome: ${verification.status}. Workflow \`${verification.workflowId}\`.`,
      '',
      `Checks from: ${verifySourceLabel(verification.source)}.`,
      '',
    );
  }
  for (const row of verification.rows) {
    lines.push(
      `${row.n}. ${row.pass ? 'Pass' : 'Fail'}, \`${row.kind}\` on ${rowUrlLabel(row.url)}${row.viewport ? ` at ${row.viewport}` : ''}. Expected: ${row.expected}. Measured: ${row.measured}.`,
    );
  }
  if (verification.reason) {
    if (verification.rows.length > 0) lines.push('');
    lines.push(`From the CLI: ${verification.reason}`);
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** One check line of a written Verification section, read back. */
export interface ParsedVerificationCheck {
  n: number;
  pass: boolean;
  kind: string;
  /** The URL label as written: one URL, or the count and the list. */
  url: string;
  viewport: string | null;
  expected: string;
  measured: string;
}

/** A finding's `## Verification` section, read back for the console. */
export interface ParsedVerification {
  /** `resolved`, `reopened` or `confirmed`, as the section's outcome line names it. */
  outcome: string;
  at: string | null;
  workflowId: string | null;
  checks: ParsedVerificationCheck[];
  /** Check lines that did not parse, kept verbatim so nothing measured is hidden. */
  unparsed: string[];
}

const VERIFICATION_LEAD =
  /^Steward (?:ran this finding's checks against production|confirmed this finding's fix by its deploy) at (\S+)\. Outcome: (\w+)\. Workflow `([^`]+)`\.$/;
const VERIFICATION_CHECK =
  /^(\d+)\. (Pass|Fail), `([^`]+)` on (.+?)(?: at (\d+x\d+|\d+×\d+))?\. Expected: (.*)\. Measured: (.*)\.$/;

/**
 * The inverse of {@link buildVerificationSection}: the outcome, the time, the
 * workflow and each check's expected and measured values. Null when the file
 * has no such section. A line in an older or hand-written shape lands in
 * `unparsed` rather than being dropped.
 */
export function parseVerificationSection(text: string): ParsedVerification | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Verification\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const parsed: ParsedVerification = { outcome: '', at: null, workflowId: null, checks: [], unparsed: [] };
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.trim();
    if (!line) continue;
    const lead = VERIFICATION_LEAD.exec(line);
    if (lead) {
      parsed.at = lead[1];
      parsed.outcome = lead[2];
      parsed.workflowId = lead[3];
      continue;
    }
    const check = VERIFICATION_CHECK.exec(line);
    if (check) {
      parsed.checks.push({
        n: Number(check[1]),
        pass: check[2] === 'Pass',
        kind: check[3],
        url: check[4],
        viewport: check[5] ?? null,
        expected: check[6],
        measured: check[7],
      });
      continue;
    }
    if (/^\d+\.\s/.test(line)) parsed.unparsed.push(line);
    else if (!parsed.outcome) {
      // An older lead line: take the outcome word if it names one.
      const outcome = /Outcome: (\w+)/.exec(line);
      if (outcome) parsed.outcome = outcome[1];
    }
  }
  return parsed;
}

/**
 * The finding file with the verifier's result in it and every other byte kept:
 * `status`, `resolved_run` when it resolved, `resolved_by: deploy` when the
 * deploy resolved it, and one `## Verification` section at the end of the
 * body. A section from an earlier run is replaced, so the file holds the
 * latest measurement, and a measured result drops an earlier `resolved_by`.
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

  let head = lines.slice(0, close).filter((line, i) => i === 0 || !/^resolved_by:/.test(line));
  if (verification.status === 'resolved') {
    const run = `resolved_run: ${verifyRunId(verification.at)}`;
    let runAt = head.findIndex((line, i) => i > 0 && /^resolved_run:/.test(line));
    if (runAt >= 0) head[runAt] = run;
    else {
      head = [...head, run];
      runAt = head.length - 1;
    }
    if (verification.deploy) head.splice(runAt + 1, 0, 'resolved_by: deploy');
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

/**
 * The line `steward finding status` prints for a run parked without an
 * automatic fix attempt, or null for any other run. The state query sets
 * `waitsForPerson` only while the run waits at `waiting-fix` for that reason.
 */
export function waitingReasonLine(state: { waitsForPerson?: boolean }): string | null {
  return state.waitsForPerson === true ? 'waits for a person: kind is not defect, so no fix was attempted' : null;
}

/** The slice of a pending activity's describe record that `steward finding status` reports. */
export interface PendingActivitySummary {
  activityType?: { name?: string | null } | null;
  attempt?: number | null;
  lastFailure?: { message?: string | null } | null;
}

/**
 * One line on an activity a run is retrying: what it waits on, which attempt,
 * and what the last attempt said. A retry is not a history event and the
 * workflow never sees a failed attempt, so the query state cannot carry this;
 * it comes from the server's describe. Null on a first attempt with no
 * failure yet, which is the normal case and not worth a line.
 */
export function pendingActivityLine(info: PendingActivitySummary): string | null {
  const name = info.activityType?.name;
  if (!name) return null;
  const attempt = info.attempt ?? 1;
  const failure = info.lastFailure?.message?.trim();
  if (attempt <= 1 && !failure) return null;
  return `${name} attempt ${attempt}${failure ? `: ${failure}` : ''}`;
}

// ---------------------------------------------------------------------------
// The fix PR's preview test (fix-pr-runs-the-verify-block)
// ---------------------------------------------------------------------------

/** The hidden line on Steward's preview comment, so a retry does not post it twice. */
export const PREVIEW_CHECKS_MARKER = '<!-- steward:preview-checks -->';

/** One check's measured row, the slice of `VerifyCheckResult` the comment prints. */
export interface PreviewCheckRow {
  n: number;
  url: string | string[];
  kind: string;
  pass: boolean;
  expected: string;
  measured: string;
}

/** What the preview test found, for the comment and the status line. */
export interface PreviewChecksReport {
  /** The fix PR. */
  prUrl: string;
  /** The commit whose preview was measured, or null when none was. */
  sha: string | null;
  /** Each check on the preview. Null when the test did not run. */
  results: PreviewCheckRow[] | null;
  /** Why `results` is null. */
  note: string | null;
}

/** The numbers of the checks that failed, in block order. */
export function failedChecks(results: PreviewCheckRow[] | null): number[] {
  return (results ?? []).filter((row) => !row.pass).map((row) => row.n);
}

/** "Check 2", "Checks 1 and 3", "Checks 1, 2 and 4". */
function checkNumbers(numbers: number[]): string {
  if (numbers.length === 1) return `Check ${numbers[0]}`;
  return `Checks ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/**
 * Steward's one comment on a fix PR after its preview test: each check's
 * expected and measured value, and a lead line that says whether the PR was
 * marked a draft. Pure, for the test.
 */
export function previewChecksComment(report: PreviewChecksReport): string {
  const sha = report.sha ? ` for commit \`${report.sha.slice(0, 7)}\`` : '';
  const lines = [PREVIEW_CHECKS_MARKER, `Steward ran the finding's \`verify:\` checks on this PR's preview${sha}, before the merge.`, ''];
  if (!report.results) {
    lines.push(
      `> **The preview was not measured.** ${report.note ?? 'No reason was recorded.'} The same checks run on production after the merge.`,
    );
    return `${lines.join('\n')}\n`;
  }
  const failed = failedChecks(report.results);
  if (failed.length > 0) {
    lines.push(
      `> **${checkNumbers(failed)} ${failed.length === 1 ? 'fails' : 'fail'} on the preview.** Steward marks this PR a draft. A person marks it ready after judging it.`,
    );
  } else {
    lines.push(`> **All ${report.results.length} ${report.results.length === 1 ? 'check passes' : 'checks pass'} on the preview.**`);
  }
  lines.push('');
  for (const row of report.results) {
    const where = Array.isArray(row.url) ? `${row.url.length} URLs (${row.url.join(', ')})` : row.url;
    lines.push(`${row.n}. \`${row.kind}\` ${where}`);
    lines.push(`   - Expects: ${row.expected}`);
    lines.push(`   - Measured: ${row.measured}`);
    lines.push(`   - ${row.pass ? 'Pass.' : 'Fail.'}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The step line for a finding with no checks: nothing to run, nothing posted. */
export const PREVIEW_SKIPPED_LINE = 'skipped: the finding has no checks';

/**
 * The one line `steward finding status` prints after `testing-preview`:
 * how the preview test came out.
 */
export function previewResultLine(report: PreviewChecksReport): string {
  if (!report.results) return `unmeasured: ${report.note ?? 'no reason recorded'}`;
  const failed = failedChecks(report.results);
  if (failed.length === 0) {
    return `${report.results.length} of ${report.results.length} ${report.results.length === 1 ? 'check passes' : 'checks pass'} on the preview`;
  }
  return `${checkNumbers(failed).toLowerCase()} of ${report.results.length} ${failed.length === 1 ? 'fails' : 'fail'} on the preview; PR marked draft`;
}
