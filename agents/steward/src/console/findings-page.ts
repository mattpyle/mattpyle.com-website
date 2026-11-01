import type { FindingVerdictResult } from '../lib/finding-verdict.js';
import { isFindingSlug } from '../lib/findings.js';
import { rowGroup, type FindingRow, type FindingsModel, type SiteSection } from './findings-model.js';

/**
 * `/findings` as one HTML string: no framework, no client build, no client
 * state. The server renders it on each GET, and every control is a link or a
 * `<form method="get">` that reloads it with new query parameters. The one
 * script is the copy button's, served from `/console.js`.
 *
 * Every value from the store or the run is escaped; only `https://` URLs
 * become links. The verdict forms post to `/findings/verdict` with the
 * console's per-process token in a hidden field.
 */

export interface PageOptions {
  /** The per-process token every POST must carry. */
  token: string;
  /** IANA zone the times are shown in. */
  timeZone: string;
  /** The Temporal Web UI base and namespace, for workflow links. */
  webUi: string;
  namespace: string;
  /** Whether the server serves the site's woff2 files under `/fonts/`. */
  fonts: boolean;
  /** Whether the server serves the site's favicon at `/favicon.svg`. */
  favicon?: boolean;
}

// ---------------------------------------------------------------------------
// The query string
// ---------------------------------------------------------------------------

/** The statuses the page knows, in lifecycle order: the `sort=status` order and the badge set. */
export const STATUS_ORDER = ['proposed', 'reopened', 'approved', 'fixing', 'resolved', 'rejected'] as const;

export const SORTS = ['default', 'opened', 'opened-asc', 'status'] as const;
export type FindingsSort = (typeof SORTS)[number];

export interface FindingsQuery {
  /** Keep one site's section. */
  site: string | null;
  /** Keep rows of one status, across the groups. */
  status: string | null;
  sort: FindingsSort;
  /** `todo` keeps only the rows that need Matt. */
  view: 'all' | 'todo';
}

export const DEFAULT_QUERY: FindingsQuery = { site: null, status: null, sort: 'default', view: 'all' };

/**
 * `GET /findings`'s parameters. A value the page does not know reads as its
 * default, so a mistyped link renders the unfiltered page, never an error.
 */
export function parseFindingsQuery(params: URLSearchParams): FindingsQuery {
  const site = params.get('site') ?? '';
  const status = params.get('status') ?? '';
  const sort = params.get('sort') ?? '';
  return {
    site: isFindingSlug(site) ? site : null,
    status: (STATUS_ORDER as readonly string[]).includes(status) ? status : null,
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as FindingsSort) : 'default',
    view: params.get('view') === 'todo' ? 'todo' : 'all',
  };
}

/** `/findings` with the query's non-default values, in a fixed order. */
export function findingsHref(query: FindingsQuery, change: Partial<FindingsQuery> = {}): string {
  const q = { ...query, ...change };
  const params = new URLSearchParams();
  if (q.site) params.set('site', q.site);
  if (q.status) params.set('status', q.status);
  if (q.sort !== 'default') params.set('sort', q.sort);
  if (q.view === 'todo') params.set('view', 'todo');
  const text = params.toString();
  return text ? `/findings?${text}` : '/findings';
}

/** A row waits for a verdict when its file says so and a run is open to receive it. */
export function needsVerdict(row: FindingRow): boolean {
  return rowGroup(row.status) === 'verdict' && row.run.open;
}

/**
 * What `view=todo` keeps: a verdict due, any drift, or a fix PR waiting on a
 * merge. The failed-verify strip shows in that view as well.
 */
export function needsMatt(row: FindingRow): boolean {
  return needsVerdict(row) || row.drift.length > 0 || row.run.step === 'waiting-merge';
}

function statusRank(status: string): number {
  const i = (STATUS_ORDER as readonly string[]).indexOf(status);
  return i === -1 ? STATUS_ORDER.length : i;
}

/** Drift first, then the newest verdict, then the key, so the rows that need a look lead each group. */
function byAttention(a: FindingRow, b: FindingRow): number {
  return (
    Number(b.drift.length > 0) - Number(a.drift.length > 0) ||
    (b.verdictAt ?? '').localeCompare(a.verdictAt ?? '') ||
    a.key.localeCompare(b.key)
  );
}

/**
 * Opened order: `first_seen`, then the INDEX.md position, which is the order
 * Argus appended the lines. A row with no `first_seen` sorts as the oldest
 * date and falls back to its position.
 */
function byOpened(a: FindingRow, b: FindingRow): number {
  return (a.opened ?? '').localeCompare(b.opened ?? '') || a.index - b.index;
}

export function sortRows(rows: FindingRow[], sort: FindingsSort): FindingRow[] {
  const out = [...rows];
  switch (sort) {
    case 'opened':
      return out.sort((a, b) => byOpened(b, a));
    case 'opened-asc':
      return out.sort(byOpened);
    case 'status':
      return out.sort((a, b) => statusRank(a.status) - statusRank(b.status) || byAttention(a, b));
    default:
      return out.sort(byAttention);
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function link(url: string | null | undefined, label?: string): string {
  if (!url) return '';
  const text = escapeHtml(label ?? url);
  return /^https:\/\//.test(url) ? `<a href="${escapeHtml(url)}">${text}</a>` : text;
}

function formatTime(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(date);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(text)}</time>`;
}

function workflowLink(id: string, options: PageOptions): string {
  return link(`${options.webUi}/namespaces/${options.namespace}/workflows/${encodeURIComponent(id)}`, id);
}

/** A status as a badge: colour, border style and a glyph, so it reads in monochrome too. */
export function badge(status: string, suffix = ''): string {
  const known = (STATUS_ORDER as readonly string[]).includes(status);
  const cls = known ? `badge s-${status}` : 'badge s-other';
  return `<span class="${cls}">${escapeHtml(status)}${suffix}</span>`;
}

const FONT_FACES = `
@font-face { font-family: 'JetBrains Mono'; font-weight: 400 600; font-display: swap; src: url('/fonts/jetbrains-mono-latin.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 400 600; font-display: swap; src: url('/fonts/jetbrains-mono-latin-ext.woff2') format('woff2'); unicode-range: U+0100-024F, U+1E00-1EFF; }
@font-face { font-family: 'Source Serif 4'; font-weight: 400 700; font-display: swap; src: url('/fonts/source-serif-4-latin.woff2') format('woff2'); }
@font-face { font-family: 'Source Serif 4'; font-weight: 400 700; font-display: swap; src: url('/fonts/source-serif-4-latin-ext.woff2') format('woff2'); unicode-range: U+0100-024F, U+1E00-1EFF; }`;

const STYLE = `
:root { --bg: #f6f3ec; --fg: #1d1c1a; --muted: #6b675f; --line: #ddd8cc; --card: #fff; --accent: #1f5f8b;
  --warn-bg: #fff1d6; --warn-fg: #7a4b00; --bad: #a3271d; --ok: #2f6b2f;
  --proposed: #8a5a00; --proposed-bg: #fff3d6; --reopened: #a3271d; --reopened-bg: #fde8e6;
  --approved: #1f5f8b; --approved-bg: #e3eef7; --fixing: #5b3c88; --fixing-bg: #eee7f7;
  --resolved: #2f6b2f; --resolved-bg: #e4f1e4; --rejected: #6b675f; --rejected-bg: #efece6;
  --mono: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace;
  --serif: 'Source Serif 4', Georgia, 'Times New Roman', serif; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #141311; --fg: #ece8df; --muted: #a39e93; --line: #36332e; --card: #1d1b18;
  --accent: #7fb6dd; --warn-bg: #3a2d12; --warn-fg: #f2cf8a; --bad: #f08a80; --ok: #8fcf8f;
  --proposed: #f2cf8a; --proposed-bg: #3a2d12; --reopened: #f08a80; --reopened-bg: #3d1a17;
  --approved: #7fb6dd; --approved-bg: #16293a; --fixing: #c3a8ec; --fixing-bg: #2a1f3b;
  --resolved: #8fcf8f; --resolved-bg: #1a2e1a; --rejected: #a39e93; --rejected-bg: #2a2824; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.55 var(--serif); }
main { max-width: 68rem; margin: 0 auto; padding: 2rem 1rem 5rem; }
a { color: var(--accent); overflow-wrap: anywhere; }
code, .mono { font-family: var(--mono); font-size: .85em; }
.muted { color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
header.top { display: flex; flex-wrap: wrap; gap: .25rem 1.25rem; align-items: baseline; justify-content: space-between; }
h1 { font: 600 1.6rem/1.2 var(--mono); margin: 0; letter-spacing: -.01em; }
.eyebrow { font: .72rem var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin: 0 0 .15rem; }
.read { font: .8rem var(--mono); color: var(--muted); margin: .25rem 0 0; }
nav.views { display: flex; gap: .4rem; font: .85rem var(--mono); }
nav.views a { text-decoration: none; padding: .3rem .7rem; border: 1px solid var(--line); border-radius: 999px; color: var(--fg); background: var(--card); }
nav.views a[aria-current] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
form.filters { display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: end; margin: 1.25rem 0 .5rem; padding: .8rem 1rem; background: var(--card); border: 1px solid var(--line); border-radius: 6px; font: .8rem var(--mono); }
form.filters label { display: flex; flex-direction: column; gap: .2rem; color: var(--muted); }
form.filters label.check { flex-direction: row; align-items: center; gap: .4rem; color: var(--fg); padding-bottom: .35rem; }
select { font: .85rem var(--mono); padding: .3rem .4rem; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--fg); }
.active { font: .8rem var(--mono); color: var(--muted); margin: .25rem 0 0; }
.active strong { color: var(--fg); font-weight: 600; }
.view-note { margin: 1rem 0 0; padding: .6rem 1rem; border: 1px solid var(--accent); border-radius: 6px; background: var(--card); }
h2 { font: 600 1.3rem var(--mono); margin: 3rem 0 .4rem; padding-bottom: .3rem; border-bottom: 2px solid var(--fg); }
h3 { font: 600 .85rem var(--mono); margin: 1.75rem 0 .6rem; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
h3.lead { font-size: 1rem; color: var(--fg); }
h3 .n { font-weight: 400; }
.counts { display: flex; flex-wrap: wrap; gap: .35rem .5rem; align-items: center; margin: .4rem 0 0; font: .8rem var(--mono); color: var(--muted); }
.counts a { text-decoration: none; }
.badge { display: inline-flex; align-items: center; gap: .3em; padding: .05rem .5rem; border-radius: 999px; border: 1.5px solid currentColor; font: 600 .75rem/1.5 var(--mono); white-space: nowrap; }
.badge::before { content: '\\2022'; content: '\\2022' / ''; }
.s-proposed { color: var(--proposed); background: var(--proposed-bg); border-style: dashed; }
.s-proposed::before { content: '\\25CB'; content: '\\25CB' / ''; }
.s-reopened { color: var(--reopened); background: var(--reopened-bg); border-style: double; border-width: 3px; }
.s-reopened::before { content: '\\21BA'; content: '\\21BA' / ''; }
.s-approved { color: var(--approved); background: var(--approved-bg); }
.s-approved::before { content: '\\2713'; content: '\\2713' / ''; }
.s-fixing { color: var(--fixing); background: var(--fixing-bg); border-radius: 3px; }
.s-fixing::before { content: '\\25D0'; content: '\\25D0' / ''; }
.s-resolved { color: var(--resolved-bg); background: var(--resolved); border-color: var(--resolved); }
.s-resolved::before { content: '\\25CF'; content: '\\25CF' / ''; }
.s-rejected { color: var(--rejected); background: var(--rejected-bg); border-style: dotted; text-decoration: line-through; }
.s-rejected::before { content: '\\2715'; content: '\\2715' / ''; }
.s-other { color: var(--fg); }
.strip { margin: 1.25rem 0; padding: .75rem 1rem; border: 1px solid var(--line); background: var(--card); border-radius: 6px; font-size: .95rem; }
.strip.alert { border-color: var(--bad); }
.strip ul { margin: .35rem 0 0; padding-left: 1.25rem; }
ol.rows { list-style: none; margin: 0; padding: 0; }
li.row { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: .8rem 1rem .9rem; margin: 0 0 .6rem; }
li.row.drift { border-color: var(--warn-fg); }
.verdict-group li.row { box-shadow: 0 1px 3px rgb(0 0 0 / .08); }
.head { display: flex; flex-wrap: wrap; gap: .3rem .6rem; align-items: center; font: .78rem var(--mono); }
.key { font-weight: 600; overflow-wrap: anywhere; }
.meta { color: var(--muted); }
button.copy { font: .7rem var(--mono); padding: .05rem .45rem; }
button.copy.copied { border-color: var(--ok); color: var(--ok); }
.title { margin: .35rem 0 .2rem; font-size: 1.1rem; line-height: 1.35; font-weight: 600; overflow-wrap: anywhere; }
.facts { margin: .4rem 0 0; padding: 0; list-style: none; font-size: .9rem; }
.facts > li { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: .75rem; padding: .15rem 0; border-top: 1px dotted var(--line); overflow-wrap: anywhere; }
.facts > li:first-child { border-top: 0; }
.facts .label { font: .72rem/1.9 var(--mono); color: var(--muted); text-align: right; }
.flag { background: var(--warn-bg); color: var(--warn-fg); padding: .05rem .45rem; border-radius: 3px; font: .75rem var(--mono); }
.fail { color: var(--bad); }
.pass { color: var(--ok); }
.checks { margin: .2rem 0 0 1.2rem; padding: 0; font-size: .88rem; }
form.verdict { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .7rem; }
form.verdict input[type=text] { flex: 1 1 18rem; min-width: 0; font: .9rem var(--serif); padding: .35rem .55rem; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 4px; }
button { font: .8rem var(--mono); padding: .35rem .8rem; border-radius: 4px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
button:hover { border-color: var(--fg); }
button.approve { border-color: var(--ok); color: var(--ok); }
button.reject { border-color: var(--bad); color: var(--bad); }
details > summary { cursor: pointer; font: 600 .85rem var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin: 1.75rem 0 .6rem; }
.none { color: var(--muted); font-style: italic; margin: 0; }
footer { margin-top: 3rem; font: .75rem var(--mono); color: var(--muted); }
.result { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 1rem; }
.result p { margin: .25rem 0; }`;

function shell(title: string, body: string, options: { fonts: boolean; favicon?: boolean; script?: boolean }): string {
  return [
    '<!doctype html>',
    '<html lang="en-CA">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title>`,
    options.favicon ? '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' : '',
    `<style>${options.fonts ? FONT_FACES : ''}${STYLE}</style>`,
    options.script ? '<script src="/console.js" defer></script>' : '',
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function fact(label: string, value: string): string {
  return value ? `<li><span class="label">${escapeHtml(label)}</span><div>${value}</div></li>` : '';
}

function renderVerification(row: FindingRow, options: PageOptions): string {
  const v = row.verification;
  if (!v) return '';
  const failed = v.checks.filter((c) => !c.pass);
  const outcomeClass = v.outcome === 'reopened' ? 'fail' : v.outcome ? 'pass' : '';
  const head =
    `<span class="${outcomeClass}">${escapeHtml(v.outcome || 'unknown')}</span>` +
    (v.at ? ` at ${formatTime(v.at, options.timeZone)}` : '') +
    (v.checks.length > 0 ? `, ${v.checks.length - failed.length} of ${v.checks.length} checks passed` : '') +
    (v.workflowId ? ` <span class="muted">(${workflowLink(v.workflowId, options)})</span>` : '');
  const items = [
    ...failed.map(
      (c) =>
        `<li class="fail">${c.n}. <code>${escapeHtml(c.kind)}</code> on ${escapeHtml(c.url)}` +
        `${c.viewport ? ` at ${escapeHtml(c.viewport)}` : ''}. Expected: ${escapeHtml(c.expected)}. Measured: ${escapeHtml(c.measured)}.</li>`,
    ),
    ...v.unparsed.map((line) => `<li>${escapeHtml(line)}</li>`),
  ];
  return fact('verification', `${head}${items.length > 0 ? `<ol class="checks">${items.join('')}</ol>` : ''}`);
}

function renderRow(row: FindingRow, options: PageOptions): string {
  const drift = row.drift.length > 0;
  const step = row.run.step
    ? `${escapeHtml(row.run.step)}${row.run.queried ? '' : ' <span class="muted">(not queried)</span>'}`
    : row.run.open
      ? '<span class="muted">open, step not queried</span>'
      : '<span class="muted">no open run</span>';
  const facts = [
    fact('reason', escapeHtml(row.reason)),
    fact('step', step + (row.run.since ? ` <span class="muted">since ${formatTime(row.run.since, options.timeZone)}</span>` : '')),
    fact('slot', row.run.slotLine ? escapeHtml(row.run.slotLine) : ''),
    fact('pr', link(row.prUrl)),
    fact('issue', row.run.step === 'fixing' ? link(row.run.issueUrl) : ''),
    fact('preview', row.run.previewResult ? escapeHtml(row.run.previewResult) : ''),
    fact('last fix failed', row.run.lastFixError ? `<span class="fail">${escapeHtml(row.run.lastFixError)}</span>` : ''),
    fact('query failed', row.run.queryError ? `<span class="fail">${escapeHtml(row.run.queryError)}</span>` : ''),
    fact(
      'verdict',
      row.verdictAt
        ? `${formatTime(row.verdictAt, options.timeZone)}${row.verdictSource ? ` <span class="muted">by ${escapeHtml(row.verdictSource)}</span>` : ''}`
        : '',
    ),
    renderVerification(row, options),
  ].join('');
  const form = needsVerdict(row)
    ? [
        `<form class="verdict" method="post" action="/findings/verdict">`,
        `<input type="hidden" name="token" value="${escapeHtml(options.token)}">`,
        `<input type="hidden" name="site" value="${escapeHtml(row.site)}">`,
        `<input type="hidden" name="key" value="${escapeHtml(row.key)}">`,
        `<input type="text" name="reason" maxlength="2000" aria-label="Reason for ${escapeHtml(row.key)}" placeholder="Reason (required to reject)">`,
        '<button class="approve" type="submit" name="verdict" value="approved">Approve</button>',
        '<button class="reject" type="submit" name="verdict" value="rejected">Reject</button>',
        '</form>',
      ].join('')
    : '';
  return [
    `<li class="row${drift ? ' drift' : ''}" id="${escapeHtml(`${row.site}--${row.key}`)}">`,
    '<div class="head">',
    badge(row.status),
    `<span class="key">${escapeHtml(row.key)}</span>`,
    `<button type="button" class="copy" data-key="${escapeHtml(row.key)}" aria-label="Copy key ${escapeHtml(row.key)}">Copy key</button>`,
    row.kind ? `<span class="meta">${escapeHtml(row.kind)}</span>` : '',
    row.priority ? `<span class="meta">${escapeHtml(row.priority)}</span>` : '',
    row.opened ? `<span class="meta">opened <time datetime="${escapeHtml(row.opened)}">${escapeHtml(row.opened)}</time></span>` : '',
    ...row.drift.map((d) => `<span class="flag">drift: ${escapeHtml(d)}</span>`),
    '</div>',
    `<p class="title">${escapeHtml(row.title)}</p>`,
    facts ? `<ul class="facts">${facts}</ul>` : '',
    form,
    '</li>',
  ].join('');
}

function renderRows(rows: FindingRow[], options: PageOptions): string {
  if (rows.length === 0) return '<p class="none">None.</p>';
  return `<ol class="rows">${rows.map((row) => renderRow(row, options)).join('\n')}</ol>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function keepRow(row: FindingRow, query: FindingsQuery): boolean {
  if (query.status && row.status !== query.status) return false;
  if (query.view === 'todo' && !needsMatt(row)) return false;
  return true;
}

function renderCounts(section: SiteSection, query: FindingsQuery): string {
  const statuses = Object.keys(section.counts).sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b));
  const badges = statuses.map((status) => {
    const href = findingsHref(query, { site: section.site, status, view: 'all' });
    return `<a href="${escapeHtml(href)}" title="Show ${escapeHtml(section.site)} ${escapeHtml(status)}">${badge(status, ` ${section.counts[status]}`)}</a>`;
  });
  const drifted = section.rows.filter((row) => row.drift.length > 0).length;
  return [
    '<p class="counts">',
    `<span>${section.rows.length} findings</span>`,
    ...badges,
    `<span>· open runs ${section.openRuns}</span>`,
    drifted ? `<span class="flag">drift ${drifted}</span>` : '',
    '</p>',
  ].join('');
}

function renderSite(section: SiteSection, options: PageOptions, query: FindingsQuery): string {
  const filtered = query.status !== null || query.view === 'todo';
  const group = (g: string) =>
    sortRows(
      section.rows.filter((row) => rowGroup(row.status) === g && keepRow(row, query)),
      query.sort,
    );
  const verdict = group('verdict');
  const flight = group('flight');
  const done = group('done');
  const other = group('other');
  const block = (title: string, rows: FindingRow[], cls = '') =>
    filtered && rows.length === 0
      ? ''
      : `<h3${cls === 'verdict-group' ? ' class="lead"' : ''}>${title} <span class="n">(${rows.length})</span></h3>` +
        `<div class="${cls}">${renderRows(rows, options)}</div>`;
  const doneOpen = filtered && done.length > 0;
  const shown = verdict.length + flight.length + done.length + other.length;
  return [
    `<section aria-labelledby="site-${escapeHtml(section.site)}">`,
    `<h2 id="site-${escapeHtml(section.site)}">${escapeHtml(section.site)}</h2>`,
    renderCounts(section, query),
    section.orphanRuns.length > 0
      ? `<p class="flag">Open runs with no INDEX.md line: ${section.orphanRuns.map((id) => workflowLink(id, options)).join(', ')}</p>`
      : '',
    filtered && shown === 0 ? '<p class="none">No finding here matches.</p>' : '',
    block('Needs a verdict', verdict, 'verdict-group'),
    block('In flight', flight),
    other.length > 0 ? block('Other status', other) : '',
    filtered && done.length === 0
      ? ''
      : `<details${doneOpen ? ' open' : ''}><summary>Done (${done.length})</summary>${renderRows(done, options)}</details>`,
    '</section>',
  ].join('\n');
}

function renderFailedVerifies(model: FindingsModel, options: PageOptions): string {
  if (model.failedVerifies.length === 0) {
    return '<div class="strip" id="failed-verifies">No verify run closed other than Completed in the last 7 days.</div>';
  }
  const items = model.failedVerifies.map(
    (run) =>
      `<li><span class="fail mono">${escapeHtml(run.status)}</span> ${workflowLink(run.workflowId, options)}` +
      `${run.closeTime ? ` <span class="muted">closed ${formatTime(run.closeTime, options.timeZone)}</span>` : ''}</li>`,
  );
  return [
    '<div class="strip alert" id="failed-verifies">',
    `<strong>${model.failedVerifies.length} verify ${model.failedVerifies.length === 1 ? 'run' : 'runs'} closed other than Completed in the last 7 days.</strong> The finding file shows none of these.`,
    `<ul>${items.join('')}</ul>`,
    '</div>',
  ].join('');
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

const SORT_LABELS: Record<FindingsSort, string> = {
  default: 'Drift first',
  opened: 'Opened, newest first',
  'opened-asc': 'Opened, oldest first',
  status: 'Status',
};

function renderControls(model: FindingsModel, query: FindingsQuery, siteKnown: boolean): string {
  const on: string[] = [];
  if (query.site && siteKnown) on.push(`site <strong>${escapeHtml(query.site)}</strong>`);
  if (query.status) on.push(`status <strong>${escapeHtml(query.status)}</strong>`);
  if (query.view === 'todo') on.push('<strong>to do</strong> only');
  if (query.sort !== 'default') on.push(`sorted by <strong>${escapeHtml(SORT_LABELS[query.sort].toLowerCase())}</strong>`);
  return [
    '<form class="filters" method="get" action="/findings">',
    `<label>Site<select name="site">${option('', 'All sites', !query.site || !siteKnown)}${model.sites
      .map((s) => option(s.site, s.site, siteKnown && query.site === s.site))
      .join('')}</select></label>`,
    `<label>Status<select name="status">${option('', 'Any status', !query.status)}${STATUS_ORDER.map((s) =>
      option(s, s, query.status === s),
    ).join('')}</select></label>`,
    `<label>Sort<select name="sort">${SORTS.map((s) => option(s === 'default' ? '' : s, SORT_LABELS[s], query.sort === s)).join('')}</select></label>`,
    `<label class="check"><input type="checkbox" name="view" value="todo"${query.view === 'todo' ? ' checked' : ''}> To do only</label>`,
    '<button type="submit">Apply</button>',
    '</form>',
    on.length > 0
      ? `<p class="active">Showing ${on.join(', ')}. <a href="/findings">Clear filters</a></p>`
      : '<p class="active">Showing every finding.</p>',
  ].join('');
}

/** Rows that wait for a verdict, across every site: the number the tab title leads with. */
export function verdictsDue(model: FindingsModel): number {
  return model.sites.reduce((n, s) => n + s.rows.filter(needsVerdict).length, 0);
}

export function renderFindingsPage(model: FindingsModel, options: PageOptions, query: FindingsQuery = DEFAULT_QUERY): string {
  const siteKnown = query.site !== null && model.sites.some((s) => s.site === query.site);
  const sites = siteKnown ? model.sites.filter((s) => s.site === query.site) : model.sites;
  const todo = query.view === 'todo';
  const todoCount = sites.reduce(
    (n, s) => n + s.rows.filter((row) => needsMatt(row) && (!query.status || row.status === query.status)).length,
    0,
  );
  const due = verdictsDue(model);
  const body = [
    '<header class="top">',
    '<div>',
    '<p class="eyebrow">Steward console</p>',
    '<h1>Findings</h1>',
    `<p class="read">read ${formatTime(model.generatedAt, options.timeZone)} from <code>${escapeHtml(model.repo)}</code> and Temporal · <a href="${escapeHtml(findingsHref(query))}">Refresh</a></p>`,
    '</div>',
    '<nav class="views" aria-label="Views">',
    `<a href="${escapeHtml(findingsHref(query, { view: 'todo' }))}"${todo ? ' aria-current="page"' : ''}>To do</a>`,
    `<a href="${escapeHtml(findingsHref(query, { view: 'all' }))}"${todo ? '' : ' aria-current="page"'}>All</a>`,
    '</nav>',
    '</header>',
    renderControls(model, query, siteKnown),
    todo
      ? `<p class="view-note"><strong>To do: ${todoCount} ${todoCount === 1 ? 'row needs' : 'rows need'} you.</strong> ` +
        'A verdict due, drift, or a PR waiting on a merge, plus any failed verify run. Everything else is hidden.</p>'
      : '',
    renderFailedVerifies(model, options),
    ...sites.map((section) => renderSite(section, options, query)),
    model.sites.length === 0 ? '<p>No site has a findings index.</p>' : '',
    '<p id="copy-status" class="sr-only" role="status" aria-live="polite"></p>',
    `<footer>This refresh: ${model.cost.treeCalls} GitHub tree call, ${model.cost.blobReads} blob reads, ` +
      `${model.cost.stateQueries} state queries, ${model.cost.dispatcherQueries} dispatcher queries.</footer>`,
  ].join('\n');
  return shell(`${due} need a verdict · Steward findings`, body, { ...options, script: true });
}

/** The verdict's answer: what `steward finding approve|reject` prints, as a page. */
export function renderVerdictResult(result: FindingVerdictResult, key: string, options: PageOptions): string {
  const lines = [
    `<p><strong>${escapeHtml(result.sent.status)}</strong> signal sent to <code>${escapeHtml(result.workflowId)}</code></p>`,
    `<p>verdict: ${escapeHtml(result.recorded.status)} (source ${escapeHtml(result.recorded.source)})</p>`,
    result.recorded.source !== 'cli'
      ? '<p>An earlier verdict from the file was recorded first, so nothing was written.</p>'
      : '',
    `<p>commit: <code>${escapeHtml(result.commitSha ?? 'none (the file already carried this verdict)')}</code></p>`,
    result.nextStepError
      ? `<p>auto_fix unread (${escapeHtml(result.nextStepError.message)}): <code>steward finding status ${escapeHtml(key)}</code> shows the next step.</p>`
      : '',
    result.nextStep ? `<p>${escapeHtml(result.nextStep)}</p>` : '',
    `<p>${link(result.webUrl)}</p>`,
  ];
  const body = [
    '<header class="top"><h1>Verdict</h1><a href="/findings">Back to findings</a></header>',
    `<div class="result">${lines.join('')}</div>`,
  ].join('\n');
  return shell(`Verdict: ${key}`, body, options);
}

/** A refusal or failure, as a page. */
export function renderMessagePage(title: string, message: string, options: { fonts: boolean; favicon?: boolean }): string {
  const body = [
    `<header class="top"><h1>${escapeHtml(title)}</h1><a href="/findings">Back to findings</a></header>`,
    `<div class="result"><p>${escapeHtml(message)}</p></div>`,
  ].join('\n');
  return shell(title, body, options);
}
