/**
 * The findings store's pure rules: the workflow ID, the slug check, the index
 * line format, and the four-field frontmatter edit.
 *
 * No imports, no clock, no environment, so the workflow sandbox, the activities,
 * the CLI and the tests all hold the same object. The ID in particular has to be
 * one function: Argus starts `finding/<site>/<key>` and the CLI and the console
 * reach it by the same ID, and two spellings of that string would be two gates
 * that never meet.
 */

/** A verdict on a finding. `approved` and `rejected` are the only two the gate records. */
export type FindingVerdictStatus = 'approved' | 'rejected';

/**
 * Who delivered the verdict, and so whether the workflow writes it.
 *
 * | Source | Sender | The workflow |
 * |---|---|---|
 * | `cli` | `steward finding approve|reject`, and the console's buttons | writes the file and the index line |
 * | `discord` | a sender outside Steward that took the verdict in Discord | writes the file and the index line |
 * | `file` | a verdict already in the file: `steward finding fix` for an approved finding with no run, and the input of a run the reconciler once started behind an approved line | writes nothing |
 *
 * The file's `verdict_source` is the value sent, so the record says where a
 * decision came from. Any other value is a malformed verdict.
 */
export const FINDING_VERDICT_SOURCES = ['cli', 'discord', 'file'] as const;
export type FindingVerdictSource = (typeof FINDING_VERDICT_SOURCES)[number];

export interface FindingVerdict {
  status: FindingVerdictStatus;
  reason: string;
  source: FindingVerdictSource;
  /** ISO 8601. Set by the sender's clock. */
  at: string;
}

/**
 * A well-formed verdict. The one check for the workflow's Signal handler, its
 * Update validator and the report's history reader, so a source the gate takes
 * is a source the report reads.
 */
export function isFindingVerdict(value: unknown): value is FindingVerdict {
  const v = value as FindingVerdict;
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.status === 'approved' || v.status === 'rejected') &&
    (FINDING_VERDICT_SOURCES as readonly unknown[]).includes(v.source) &&
    typeof v.reason === 'string' &&
    typeof v.at === 'string'
  );
}

/** Whether the workflow writes a verdict from this source into the file. Only `file` is already there. */
export function verdictSourceWrites(source: FindingVerdictSource): boolean {
  return source === 'cli' || source === 'discord';
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
// The open finding runs
// ---------------------------------------------------------------------------

/**
 * One running `findingWorkflow` as `listOpenFindingWorkflows` lists it: its ID,
 * and where its `state` query says it is. `step` and `fixAttempts` are null
 * when the query gave no answer, and for a bare ID, which is what the list
 * returned before it carried them.
 */
export interface OpenFindingWorkflow {
  workflowId: string;
  step: string | null;
  fixAttempts: number | null;
  /**
   * The run's fix issue, null before it opens one. Absent from a list recorded
   * before the field existed; read it as null.
   */
  issueUrl?: string | null;
  /**
   * False when the listing skipped the `state` query for this run: its step is
   * null because nobody asked, not because the query failed. Absent from a list
   * recorded before the field existed; read it as queried.
   */
  queried?: boolean;
}

/**
 * What `listOpenFindingWorkflows` returned in the pruning form the findings
 * reconciler asked for: the runs, how many it queried, and how many index
 * files it read to decide. The reconciler is gone and nothing asks for this
 * form now; the type stays because {@link listedRuns}, which the recheck
 * workflow imports, names it, and that workflow's code is left as it replays.
 */
export interface OpenFindingListing {
  runs: OpenFindingWorkflow[];
  queried: number;
  indexReads: number;
}

/** The runs of either return shape; a history recorded before the listing existed holds an array. */
export function listedRuns(listing: OpenFindingWorkflow[] | OpenFindingListing): OpenFindingWorkflow[] {
  return Array.isArray(listing) ? listing : listing.runs;
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

/** The pages the URLs of a finding's `verify` checks name, as distinct paths, in order. */
function verifyPages(data: Record<string, unknown>): string[] {
  const pages = new Set<string>();
  if (Array.isArray(data.verify)) {
    for (const check of data.verify) {
      const url = check && typeof check === 'object' ? (check as { url?: unknown }).url : undefined;
      for (const one of Array.isArray(url) ? url : [url]) {
        if (typeof one !== 'string') continue;
        const path = pagePath(one);
        if (path) pages.add(path);
      }
    }
  }
  return [...pages];
}

/**
 * The pages a finding's fix is about, as distinct paths: the URLs of its
 * `verify` checks, or, when no check names a readable page, the URLs and the
 * leading-slash paths in the body's "What would serve them". A source path such
 * as `src/content/x.md` has a letter before its slash and is not a page.
 */
export function findingPages(data: Record<string, unknown>, parsed: ParsedFinding): string[] {
  const fromChecks = verifyPages(data);
  if (fromChecks.length > 0) return fromChecks;

  const pages = new Set<string>();
  const add = (raw: string) => {
    const path = pagePath(raw);
    if (path) pages.add(path);
  };
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
 * 2. an opportunity that names at least one page, told by {@link findingPages}.
 *    A fact that lives in several places is one change, so several pages pass
 *    whatever the shape of the `verify` checks that name them: the verdict is
 *    the check on scope, and a check on each place is the guard on the fix.
 *    Pages told only from "What would serve them", with no `verify` check that
 *    names a page, are the exception. No preview test can fail on them, so
 *    several of them stay refused. A cause is not asked of an opportunity: it
 *    has none.
 *
 * Directions, opportunities that name no page, and opportunities that name
 * several pages only in prose, stay a person's.
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
  if (pages.length > 1 && verifyPages(data).length === 0) {
    return `it names more than one page (${pages.join(', ')}) in "What would serve them" and no verify check names a page, so no preview test can fail on its fix`;
  }
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
 * The six lines above the finding in a fix issue. `@claude` is what starts
 * `claude-code-action` (`claude.yml`'s `if`). The scope is the fact, not the
 * one line the finding's Fix names: every place that states it, less what the
 * Verdict line rejects, and nothing else. `CHANGE-KINDS.md` lists where facts
 * hide, as a start; the fixer searches the whole tree for the old words. Done includes a look at the built page through `npm run look`, aimed
 * at the changed text: the one command in `claude.yml`'s allowlist that
 * renders a page. Every look is read whole: text, HTML, twin and both pictures.
 */
export const FIX_ISSUE_HEADER = [
  '@claude Fix the approved finding below.',
  '',
  'Rules: one finding, one fix, one PR. The fix covers every place that states the fact, unless the Verdict line below rejects it; the finding\'s Fix may not name them all. The row "A changed fact about the site or its author" in `CHANGE-KINDS.md` lists where facts hide. Search the whole tree for the old words; the list says where to start. Change nothing that is not this fact. The Verdict line below is the scope: a part it rejects is out of scope. Run `npm test` and `npm run check` before you push and leave both passing. Open the PR yourself. Keep the PR body short: what changed, why, and the evidence. Done is the "How to measure" check passing on the Vercel preview and a look with `npm run look` at every page your change reaches, aimed with `--find` at the changed text: for every change read the text, the rendered HTML, the markdown twin and the two aimed pictures it leaves; for a file with no page such as `agents.md`, read the served file. Aim `--find` with the sentence as it reads on the page, with no backticks, asterisks, link targets or tags, and with the words on both sides of any code, link or emphasis, because a join between two words is caught only when the aim crosses it; if the sentence is over 200 characters, aim with the clause that crosses the join. The PR says what you looked at and at which widths.',
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
    "Steward runs these checks on this PR's Vercel preview before the merge, and on production after it. Each `text` needle must read on your tree as its check expects, where the preview's own address counts as the production address; search your tree for the path of every needle before you push.",
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
  /**
   * The lifecycle's last preview test, when the fix PR merged while it
   * failed: its {@link previewResultLine} and the commit it measured.
   */
  previewAtMerge?: string;
  /**
   * True when the checks ran at the approved verdict and all passed, so the
   * finding was resolved without a fix (STW-589). The section says so.
   */
  atVerdict?: boolean;
}

/** The line a Verification section carries when the checks all passed at the verdict. */
export const VERDICT_RESOLVED_LINE = 'Every check passed at the approved verdict, so Steward opened no fix.';

/**
 * One measured check as a section prints it. The Verification section and the
 * section measured at the verdict share it, so one parser reads both.
 */
export function verificationCheckLine(row: VerificationRow): string {
  return `${row.n}. ${row.pass ? 'Pass' : 'Fail'}, \`${row.kind}\` on ${rowUrlLabel(row.url)}${row.viewport ? ` at ${row.viewport}` : ''}. Expected: ${row.expected}. Measured: ${row.measured}.`;
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
  for (const row of verification.rows) lines.push(verificationCheckLine(row));
  if (verification.atVerdict) {
    if (verification.rows.length > 0) lines.push('');
    lines.push(VERDICT_RESOLVED_LINE);
  }
  if (verification.reason) {
    if (verification.rows.length > 0) lines.push('');
    lines.push(`From the CLI: ${verification.reason}`);
  }
  if (verification.previewAtMerge) {
    lines.push('', `The fix PR merged while its last preview test failed: ${verification.previewAtMerge}.`);
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

// ---------------------------------------------------------------------------
// The measurement at the approved verdict (STW-589)
// ---------------------------------------------------------------------------

/** The heading of the section a finding's checks write at its approved verdict. */
export const VERDICT_MEASURE_HEADING = '## Measured at the verdict';

/**
 * What `findingWorkflow` measured on production at an approved verdict: each
 * check's row, or no rows and the reason nothing was measured.
 */
export interface VerdictMeasure {
  /** ISO 8601: when the checks ran, or when measuring was given up. */
  at: string;
  /** The `findingWorkflow` run that measured. */
  workflowId: string;
  /** The measured rows. Null when nothing was measured. */
  rows: VerificationRow[] | null;
  /** Why nothing was measured, one clause. Set exactly when `rows` is null. */
  reason: string | null;
}

/** Every check ran and passed: the problem is already gone. */
export function verdictMeasurePassed(measure: VerdictMeasure): boolean {
  return measure.rows !== null && measure.rows.length > 0 && measure.rows.every((row) => row.pass);
}

/** The one line `steward finding status` prints as `measured at verdict:`. */
export function verdictMeasureLine(measure: VerdictMeasure): string {
  if (measure.rows === null) return `unmeasured: ${measure.reason ?? 'no reason recorded'}`;
  const total = measure.rows.length;
  const failed = measure.rows.filter((row) => !row.pass).map((row) => row.n);
  if (failed.length === 0) return `${total} of ${total} checks pass on production`;
  const which = failed.length === 1 ? `check ${failed[0]}` : `checks ${failed.join(', ')}`;
  return `${which} of ${total} ${failed.length === 1 ? 'fails' : 'fail'} on production`;
}

/**
 * The `## Measured at the verdict` section: a lead line with the time and the
 * workflow, then each check in the Verification section's own line. An
 * unmeasured finding gets the lead line with the reason and no check lines.
 */
export function buildVerdictMeasureSection(measure: VerdictMeasure): string {
  const lines = [VERDICT_MEASURE_HEADING, ''];
  if (measure.rows === null) {
    lines.push(
      `Steward did not measure this finding at its approved verdict, ${measure.at}: ${measure.reason ?? 'no reason recorded'}. Workflow \`${measure.workflowId}\`.`,
    );
  } else {
    lines.push(
      `Steward ran this finding's checks against production at ${measure.at}, at its approved verdict. Workflow \`${measure.workflowId}\`.`,
      '',
      ...measure.rows.map(verificationCheckLine),
    );
  }
  return lines.join('\n');
}

/**
 * The finding file with its section measured at the verdict and every other
 * byte kept. The section goes above `## Verification` when the file has one,
 * and at the end of the body otherwise. A section from an earlier run is
 * replaced: the file holds the measurement of the latest approval.
 */
export function setFindingVerdictMeasure(text: string, measure: VerdictMeasure): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");
  const head = lines.slice(0, close);
  const body = lines.slice(close);
  const heading = (line: string) => /^##\s+Measured at the verdict\s*$/.test(line);
  const at = body.findIndex(heading);
  if (at >= 0) {
    let end = body.findIndex((line, i) => i > at && /^##\s/.test(line));
    if (end < 0) end = body.length;
    // The section's own trailing blank line goes with it; the one before it stays.
    body.splice(at, end - at);
  }
  const section = buildVerdictMeasureSection(measure).split('\n');
  const verification = body.findIndex((line) => /^##\s+Verification\s*$/.test(line));
  if (verification >= 0) {
    body.splice(verification, 0, ...section, '');
  } else {
    while (body.length > 1 && body[body.length - 1].trim() === '') body.pop();
    body.push('', ...section, '');
  }
  return [...head, ...body].join(eol);
}

/** A finding's section measured at the verdict, read back for the fix log. */
export interface ParsedVerdictMeasure {
  at: string | null;
  workflowId: string | null;
  /** False when the section says nothing was measured. */
  measured: boolean;
  /** Why nothing was measured, when `measured` is false. */
  reason: string | null;
  checks: ParsedVerificationCheck[];
  /** Check lines that did not parse, kept verbatim. */
  unparsed: string[];
}

const VERDICT_MEASURE_LEAD =
  /^Steward ran this finding's checks against production at (\S+), at its approved verdict\. Workflow `([^`]+)`\.$/;
const VERDICT_UNMEASURED_LEAD =
  /^Steward did not measure this finding at its approved verdict, (\S+): (.*)\. Workflow `([^`]+)`\.$/;

/** The inverse of {@link buildVerdictMeasureSection}; null when the file has no such section. */
export function parseVerdictMeasureSection(text: string): ParsedVerdictMeasure | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Measured at the verdict\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const parsed: ParsedVerdictMeasure = { at: null, workflowId: null, measured: true, reason: null, checks: [], unparsed: [] };
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.trim();
    if (!line) continue;
    const lead = VERDICT_MEASURE_LEAD.exec(line);
    if (lead) {
      parsed.at = lead[1];
      parsed.workflowId = lead[2];
      continue;
    }
    const unmeasured = VERDICT_UNMEASURED_LEAD.exec(line);
    if (unmeasured) {
      parsed.at = unmeasured[1];
      parsed.measured = false;
      parsed.reason = unmeasured[2];
      parsed.workflowId = unmeasured[3];
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
  }
  return parsed;
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

  return addFixAttemptLine(lines, close, `- ${at}: ${prUrl} closed unmerged. The finding is approved again.`).join(eol);
}

/**
 * The finding file with one more line under `## Fix attempts`, every other
 * byte kept, for a new attempt after a merged fix that did not pass on
 * production (STW-653). The section is the one {@link setFindingReturned}
 * writes; a line already there is not added twice.
 */
export function setFindingFixAttempt(text: string, at: string, note: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('the finding has no frontmatter block');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error("the finding's frontmatter block is not closed");
  return addFixAttemptLine(lines, close, `- ${at}: ${note}`).join(eol);
}

/** `note` appended to the `## Fix attempts` section below the frontmatter's `close`, made when missing. */
function addFixAttemptLine(lines: string[], close: number, note: string): string[] {
  if (lines.includes(note)) return lines;
  const sectionAt = lines.findIndex((line, i) => i > close && /^##\s+Fix attempts\s*$/.test(line));
  if (sectionAt >= 0) {
    let end = lines.findIndex((line, i) => i > sectionAt && /^##\s/.test(line));
    if (end < 0) end = lines.length;
    while (end > sectionAt + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, note);
    return lines;
  }
  while (lines.length > close + 1 && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push('', '## Fix attempts', '', note, '');
  return lines;
}

// ---------------------------------------------------------------------------
// A run parked after its fix PR (STW-653)
// ---------------------------------------------------------------------------

/**
 * Why a run is parked: a check ran on production and failed, a check is
 * broken or invalid, or any other failure a retry does not mend.
 */
export type FindingParkKind = 'checks-failed' | 'checks-broken' | 'error';

/** The step a parked run runs again on `resume`. */
/**
 * Where a parked run stopped. `verdict` and `settings` (STW-689) are a verdict
 * write and a settings read that failed in a way no retry mends.
 */
export type FindingParkStage = 'merge' | 'returned' | 'deploy' | 'verify' | 'verdict' | 'settings';

/** A parked run's own account of itself, in its `state` query. */
export interface FindingPark {
  kind: FindingParkKind;
  stage: FindingParkStage;
  /** One sentence: what happened. */
  reason: string;
  /** ISO 8601, when the run parked. */
  since: string;
  /** One sentence: the messages that move the run. */
  moves: string;
  /** The fix PR the park is about. */
  prUrl: string | null;
  /** Why the park's PR comment was not posted, when it was not. */
  commentError?: string | null;
}

/**
 * True when a parked run at this stage takes a `request-fix`: every stage but
 * an unmerged PR's, an unwritten verdict's and an unread settings file's.
 */
export function parkTakesFix(stage: FindingParkStage): boolean {
  return stage !== 'merge' && stage !== 'verdict' && stage !== 'settings';
}

/** The sentence a park's `moves` holds, naming the CLI verbs that send each Update. */
export function parkMoves(key: string, stage: FindingParkStage): string {
  if (stage === 'verdict') {
    return `\`steward finding resume ${key}\` writes the verdict again; a new \`steward finding approve ${key}\` or \`steward finding reject ${key}\` replaces it.`;
  }
  if (stage === 'settings') return `\`steward finding resume ${key}\` reads the site's settings again.`;
  const resume =
    stage === 'verify'
      ? `\`steward finding resume ${key}\` verifies again`
      : stage === 'merge'
        ? `\`steward finding resume ${key}\` waits on the merge again`
        : stage === 'deploy'
          ? `\`steward finding resume ${key}\` waits on the deploy again`
          : `\`steward finding resume ${key}\` writes the closed PR back again`;
  return parkTakesFix(stage) ? `${resume}; \`steward finding fix ${key}\` starts a new fix attempt.` : `${resume}.`;
}

/** The one line `steward finding list` prints for a parked run, kept in its memo as `waitsFor`. */
export function parkLine(park: Pick<FindingPark, 'kind' | 'stage' | 'reason'>): string {
  const what = park.kind === 'checks-failed' ? 'checks failed' : park.kind === 'checks-broken' ? 'a check is broken' : 'error';
  return `parked at ${park.stage} (${what}): ${park.reason}`;
}

/** The hidden line that tells a park's PR comment from every other, so a retried post is not doubled. */
export function parkCommentMarker(site: string, key: string, attempt: number, what: string): string {
  return `<!-- steward-finding-park ${site}/${key} attempt-${attempt} ${what} -->`;
}

/** The PR comment a parked run posts once. */
export function parkComment(park: Pick<FindingPark, 'kind' | 'stage' | 'reason' | 'moves'>, workflowId: string): string {
  const head =
    park.kind === 'checks-failed'
      ? 'Steward verified this fix on production, and a check failed.'
      : park.kind === 'checks-broken'
        ? 'Steward could not verify this fix: a check of the finding is broken or invalid.'
        : 'Steward stopped following this fix.';
  return [
    head,
    '',
    park.reason,
    '',
    `The finding's run \`${workflowId}\` is parked and stays open. Nothing happens on a clock: ${park.moves}`,
  ].join('\n');
}

/** The PR comment a run posts once when its merge or deploy wait first runs out its bound and goes on waiting. */
export function waitExpiredComment(wait: 'merge' | 'deploy', note: string, workflowId: string): string {
  const goesOn =
    wait === 'merge'
      ? 'The run keeps waiting: it goes on when this PR is merged or closed.'
      : 'The run keeps waiting, now every 15 minutes: it goes on when production serves this merge.';
  return [note, '', `${goesOn} The finding's run is \`${workflowId}\`.`].join('\n');
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

/**
 * The step line of `steward finding status`. A watching run (stage 4) ends at
 * no verdict, so it says what it watches rather than "stop after verdict".
 */
export function stepLine(state: { step?: string; stopAfter?: string; watchingSince?: string | null }): string | null {
  if (!state.step) return null;
  if (state.step === 'watching') {
    const since = state.watchingSince ? `, since ${state.watchingSince}` : '';
    return `step: watching  (measures production daily until the fix is live${since})`;
  }
  return `step: ${state.step}  (stop after ${state.stopAfter ?? 'verdict'})`;
}

/** A pending activity's next attempt, as the server's describe gives it. */
export interface PendingNextAttempt {
  activityType?: { name?: string | null } | null;
  nextAttemptScheduleTime?: { seconds?: number | { toNumber(): number } | null } | null;
}

/**
 * When a watching run measures next (stage 4): the pending `watchFinding`'s
 * next attempt, or null when it is running now or is another activity.
 */
export function nextMeasurementLine(info: PendingNextAttempt): string | null {
  if (info.activityType?.name !== 'watchFinding') return null;
  const raw = info.nextAttemptScheduleTime?.seconds;
  if (raw === undefined || raw === null) return null;
  const seconds = typeof raw === 'number' ? raw : raw.toNumber();
  return `next measurement: ${new Date(seconds * 1000).toISOString()}`;
}

/**
 * What the server says about a finding run's execution, the slice
 * `steward finding status` prints. `status` is `describe().status.name`;
 * `result` is the workflow's return value when the run completed, and
 * `failure` is the message of the failure that closed it otherwise.
 */
export interface RunEnd {
  status: string;
  closeTime?: Date | null;
  result?: { outcome?: string; verifyWorkflowId?: string | null } | null;
  failure?: string | null;
}

const CLOSED_RUN_LABELS: Record<string, string> = {
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  TERMINATED: 'terminated',
  TIMED_OUT: 'timed out',
  CONTINUED_AS_NEW: 'continued as new',
};

/**
 * The lines that open `steward finding status`: whether the workflow run is
 * open, and for a closed run how and when it ended with its outcome or failure.
 * The state query answers for a closed run too, so the run's own status
 * is the only reliable sign. A run with no known status reads as open: the
 * label is for runs the server has closed.
 *
 * A completed run whose result predates `outcome` ended at the verdict gate.
 */
export function runStateLines(end: RunEnd): { closed: boolean; lines: string[] } {
  const label = CLOSED_RUN_LABELS[end.status];
  if (!label) return { closed: false, lines: ['run: open'] };
  const at = end.closeTime ? ` at ${end.closeTime.toISOString()}` : '';
  const lines = [`run: ${label}${at}`];
  if (end.status === 'COMPLETED') {
    if (end.result) {
      const verify = end.result.verifyWorkflowId ? ` (verify ${end.result.verifyWorkflowId})` : '';
      lines.push(`outcome: ${end.result.outcome ?? 'verdict'}${verify}`);
    }
  } else if (end.failure) {
    lines.push(`failure: ${end.failure.replace(/\s+/g, ' ').trim()}`);
  }
  return { closed: true, lines };
}

// ---------------------------------------------------------------------------
// The fix PR's preview test (fix-pr-runs-the-verify-block)
// ---------------------------------------------------------------------------

/** The hidden line on Steward's preview comment, so a retry does not post it twice. */
export const PREVIEW_CHECKS_MARKER = '<!-- steward:preview-checks -->';

/** The one sentence the comment says about how a preview's measured values were read. */
export const PREVIEW_ORIGIN_NOTE =
  "Steward read the preview's own origin as the production origin in the measured values before it compared them.";

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

/** One earlier preview test of the same PR, for the comment's history lines. */
export interface PreviewEarlierResult {
  /** The commit that test measured, or null when it measured none. */
  sha: string | null;
  /** Its {@link previewResultLine}. */
  line: string;
}

/**
 * What the preview test's write did to the PR's draft flag, for the lead.
 *
 * - `drafted`: a check failed, and the PR is a draft that Steward set.
 * - `not-open`: a check failed on a PR that is merged or closed; nothing to set.
 * - `readied`: every check passed, and Steward cleared the draft it had set.
 * - `kept`: every check passed, but the draft stays: `by` set it, or no one
 *   Steward can name did (`by` null).
 * - `none`: nothing to say about the draft.
 */
export type PreviewDraftAction =
  | { kind: 'drafted' }
  | { kind: 'not-open' }
  | { kind: 'readied' }
  | { kind: 'kept'; by: string | null }
  | { kind: 'none' };

export interface PreviewCommentContext {
  /** The finding key, for the `retest` command the failure lead names. */
  key?: string;
  /** Earlier tests of this PR, oldest first. */
  earlier?: PreviewEarlierResult[];
  draft?: PreviewDraftAction;
}

/** The three routes a failed test leaves a person, in the order the comment gives them. */
export function previewFailureRoutes(key: string): string[] {
  return [
    '1. The fix is wrong: comment `@claude` on this PR with what to change. Steward tests the new commit by itself.',
    `2. The check or Steward is wrong: correct it, then run \`steward finding retest ${key}\`. Steward tests this PR's head again.`,
    "3. Judge it yourself: mark this PR ready and merge it. The finding's Verification section records that it merged over a failed preview test.",
  ];
}

/** The commit an earlier result names, or `no commit` when it measured none. */
function earlierLine(result: PreviewEarlierResult): string {
  return `- ${result.sha ? `\`${result.sha.slice(0, 7)}\`` : 'no commit'}: ${result.line}`;
}

/**
 * Steward's one comment on a fix PR after its preview test: each check's
 * expected and measured value, a lead line that says what happened to the
 * PR's draft flag and, after a failure, the three routes a person has. A
 * later test rewrites the comment, and each earlier result keeps one line with
 * its commit. Pure, for the test.
 */
export function previewChecksComment(report: PreviewChecksReport, context: PreviewCommentContext = {}): string {
  const sha = report.sha ? ` for commit \`${report.sha.slice(0, 7)}\`` : '';
  const lines = [PREVIEW_CHECKS_MARKER, `Steward ran the finding's \`verify:\` checks on this PR's preview${sha}, before the merge.`, ''];
  const earlier = context.earlier ?? [];
  const history = (): void => {
    if (earlier.length === 0) return;
    lines.push('', `Earlier tests of this PR, oldest first:`, '', ...earlier.map(earlierLine));
  };
  if (!report.results) {
    lines.push(
      `> **The preview was not measured.** ${report.note ?? 'No reason was recorded.'} The same checks run on production after the merge.`,
    );
    history();
    return `${lines.join('\n')}\n`;
  }
  const failed = failedChecks(report.results);
  const draft = context.draft ?? { kind: 'none' };
  if (failed.length > 0) {
    const lead = `> **${checkNumbers(failed)} ${failed.length === 1 ? 'fails' : 'fail'} on the preview.**`;
    if (draft.kind === 'not-open') {
      lines.push(`${lead} The PR is no longer open, so Steward left its draft flag alone.`);
    } else {
      lines.push(
        `${lead} Steward made this PR a draft, so that it does not merge by accident. A person decides what comes next, by one of three routes:`,
        '',
        ...previewFailureRoutes(context.key ?? '<key>'),
      );
    }
  } else {
    const lead = `> **All ${report.results.length} ${report.results.length === 1 ? 'check passes' : 'checks pass'} on the preview.**`;
    if (draft.kind === 'readied') {
      lines.push(`${lead} Steward made this PR a draft after an earlier failed test, and has marked it ready for review again.`);
    } else if (draft.kind === 'kept') {
      lines.push(
        draft.by
          ? `${lead} This PR is still a draft: ${draft.by} made it one, not Steward, so Steward leaves it.`
          : `${lead} This PR is still a draft, and Steward cannot tell who made it one, so Steward leaves it.`,
      );
    } else {
      lines.push(lead);
    }
  }
  lines.push('', PREVIEW_ORIGIN_NOTE, '');
  for (const row of report.results) {
    const where = Array.isArray(row.url) ? `${row.url.length} URLs (${row.url.join(', ')})` : row.url;
    lines.push(`${row.n}. \`${row.kind}\` ${where}`);
    lines.push(`   - Expects: ${row.expected}`);
    lines.push(`   - Measured: ${row.measured}`);
    lines.push(`   - ${row.pass ? 'Pass.' : 'Fail.'}`);
  }
  history();
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
