import type { FindingVerdictResult } from '../lib/finding-verdict.js';
import { rowGroup, type FindingRow, type FindingsModel, type SiteSection } from './findings-model.js';

/**
 * `/findings` as one HTML string: no framework, no client build, no script.
 * The server renders it on each GET, and the Refresh link is a reload.
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
}

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

const FONT_FACES = `
@font-face { font-family: 'JetBrains Mono'; font-weight: 400 600; font-display: swap; src: url('/fonts/jetbrains-mono-latin.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-weight: 400 600; font-display: swap; src: url('/fonts/jetbrains-mono-latin-ext.woff2') format('woff2'); unicode-range: U+0100-024F, U+1E00-1EFF; }
@font-face { font-family: 'Source Serif 4'; font-weight: 400 700; font-display: swap; src: url('/fonts/source-serif-4-latin.woff2') format('woff2'); }
@font-face { font-family: 'Source Serif 4'; font-weight: 400 700; font-display: swap; src: url('/fonts/source-serif-4-latin-ext.woff2') format('woff2'); unicode-range: U+0100-024F, U+1E00-1EFF; }`;

const STYLE = `
:root { --bg: #faf8f3; --fg: #1d1c1a; --muted: #6b675f; --line: #ddd8cc; --card: #fff; --accent: #1f5f8b;
  --warn-bg: #fff1d6; --warn-fg: #7a4b00; --bad: #a3271d; --ok: #2f6b2f;
  --mono: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace;
  --serif: 'Source Serif 4', Georgia, 'Times New Roman', serif; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ece8df; --muted: #a39e93; --line: #36332e; --card: #1f1d1a;
  --accent: #7fb6dd; --warn-bg: #3a2d12; --warn-fg: #f2cf8a; --bad: #f08a80; --ok: #8fcf8f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 var(--serif); }
main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
header { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: .75rem; }
h1 { font: 600 1.25rem var(--mono); margin: 0; }
h2 { font: 600 1.1rem var(--mono); margin: 2.5rem 0 .25rem; }
h3 { font: 600 .95rem var(--mono); margin: 1.5rem 0 .5rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
a { color: var(--accent); overflow-wrap: anywhere; }
code, .mono { font-family: var(--mono); font-size: .85em; }
.muted { color: var(--muted); }
.counts { font: .85rem var(--mono); color: var(--muted); margin: 0; }
.strip { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--line); background: var(--card); border-radius: 4px; }
.strip.alert { border-color: var(--bad); }
.strip ul { margin: .25rem 0 0; padding-left: 1.25rem; }
ol.rows { list-style: none; margin: 0; padding: 0; }
li.row { background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: .6rem .8rem; margin: 0 0 .5rem; }
li.row.drift { border-color: var(--warn-fg); }
.head { display: flex; flex-wrap: wrap; gap: .25rem .75rem; align-items: baseline; font: .8rem var(--mono); }
.key { font-weight: 600; overflow-wrap: anywhere; }
.badge { padding: 0 .4rem; border-radius: 3px; border: 1px solid var(--line); }
.title { margin: .2rem 0; font-size: 1.02rem; overflow-wrap: anywhere; }
.facts { margin: .2rem 0 0; padding: 0; list-style: none; font-size: .9rem; }
.facts li { margin: .1rem 0; overflow-wrap: anywhere; }
.facts .label { font: .75rem var(--mono); color: var(--muted); margin-right: .4rem; }
.flag { background: var(--warn-bg); color: var(--warn-fg); padding: .1rem .4rem; border-radius: 3px; font: .8rem var(--mono); }
.fail { color: var(--bad); }
.pass { color: var(--ok); }
.checks { margin: .2rem 0 0 1.2rem; padding: 0; font-size: .88rem; }
form.verdict { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
form.verdict input[type=text] { flex: 1 1 18rem; min-width: 0; font: .9rem var(--serif); padding: .3rem .5rem; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 3px; }
button { font: .8rem var(--mono); padding: .3rem .7rem; border-radius: 3px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
button.approve { border-color: var(--ok); }
button.reject { border-color: var(--bad); }
details > summary { cursor: pointer; font: 600 .95rem var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 1.5rem 0 .5rem; }
footer { margin-top: 3rem; font: .8rem var(--mono); color: var(--muted); }
.result { background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 1rem; }
.result p { margin: .25rem 0; }`;

function shell(title: string, body: string, options: { fonts: boolean }): string {
  return [
    '<!doctype html>',
    '<html lang="en-CA">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${options.fonts ? FONT_FACES : ''}${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function renderVerification(row: FindingRow, options: PageOptions): string {
  const v = row.verification;
  if (!v) return '';
  const failed = v.checks.filter((c) => !c.pass);
  const outcomeClass = v.outcome === 'reopened' ? 'fail' : v.outcome ? 'pass' : '';
  const head =
    `<span class="label">verification</span><span class="${outcomeClass}">${escapeHtml(v.outcome || 'unknown')}</span>` +
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
  return `<li>${head}${items.length > 0 ? `<ol class="checks">${items.join('')}</ol>` : ''}</li>`;
}

function fact(label: string, value: string): string {
  return value ? `<li><span class="label">${escapeHtml(label)}</span>${value}</li>` : '';
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
  const form =
    rowGroup(row.status) === 'verdict' && row.run.open
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
    `<span class="key">${escapeHtml(row.key)}</span>`,
    `<span class="badge">${escapeHtml(row.status)}</span>`,
    row.kind ? `<span class="muted">${escapeHtml(row.kind)}</span>` : '',
    row.priority ? `<span class="muted">${escapeHtml(row.priority)}</span>` : '',
    ...row.drift.map((d) => `<span class="flag">drift: ${escapeHtml(d)}</span>`),
    '</div>',
    `<p class="title">${escapeHtml(row.title)}</p>`,
    facts ? `<ul class="facts">${facts}</ul>` : '',
    form,
    '</li>',
  ].join('');
}

function renderRows(rows: FindingRow[], options: PageOptions): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  return `<ol class="rows">${rows.map((row) => renderRow(row, options)).join('\n')}</ol>`;
}

/** Drift first, then the newest verdict, then the key, so the rows that need a look lead each group. */
function ordered(rows: FindingRow[]): FindingRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.drift.length > 0) - Number(a.drift.length > 0) ||
      (b.verdictAt ?? '').localeCompare(a.verdictAt ?? '') ||
      a.key.localeCompare(b.key),
  );
}

function renderSite(section: SiteSection, options: PageOptions): string {
  const group = (g: string) => ordered(section.rows.filter((row) => rowGroup(row.status) === g));
  const verdict = group('verdict');
  const flight = group('flight');
  const done = group('done');
  const other = group('other');
  const counts = Object.entries(section.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${escapeHtml(status)} ${n}`)
    .join(' · ');
  const drifted = section.rows.filter((row) => row.drift.length > 0).length;
  return [
    `<section aria-labelledby="site-${escapeHtml(section.site)}">`,
    `<h2 id="site-${escapeHtml(section.site)}">${escapeHtml(section.site)}</h2>`,
    `<p class="counts">${section.rows.length} findings: ${counts} · open runs ${section.openRuns}${drifted ? ` · drift ${drifted}` : ''}</p>`,
    section.orphanRuns.length > 0
      ? `<p class="flag">Open runs with no INDEX.md line: ${section.orphanRuns.map((id) => workflowLink(id, options)).join(', ')}</p>`
      : '',
    `<h3>Needs a verdict (${verdict.length})</h3>`,
    renderRows(verdict, options),
    `<h3>In flight (${flight.length})</h3>`,
    renderRows(flight, options),
    other.length > 0 ? `<h3>Other status (${other.length})</h3>${renderRows(other, options)}` : '',
    `<details><summary>Done (${done.length})</summary>${renderRows(done, options)}</details>`,
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

export function renderFindingsPage(model: FindingsModel, options: PageOptions): string {
  const body = [
    '<header>',
    '<h1>Steward console · findings</h1>',
    `<span class="muted">read ${formatTime(model.generatedAt, options.timeZone)} from <code>${escapeHtml(model.repo)}</code> and Temporal</span>`,
    '<a href="/findings">Refresh</a>',
    '</header>',
    renderFailedVerifies(model, options),
    ...model.sites.map((section) => renderSite(section, options)),
    model.sites.length === 0 ? '<p>No site has a findings index.</p>' : '',
    `<footer>This refresh: ${model.cost.treeCalls} GitHub tree call, ${model.cost.blobReads} blob reads, ` +
      `${model.cost.stateQueries} state queries, ${model.cost.dispatcherQueries} dispatcher queries.</footer>`,
  ].join('\n');
  return shell('Steward console: findings', body, options);
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
    '<header><h1>Steward console · verdict</h1><a href="/findings">Back to findings</a></header>',
    `<div class="result">${lines.join('')}</div>`,
  ].join('\n');
  return shell(`Verdict: ${key}`, body, options);
}

/** A refusal or failure, as a page. */
export function renderMessagePage(title: string, message: string, options: { fonts: boolean }): string {
  const body = [
    `<header><h1>Steward console · ${escapeHtml(title)}</h1><a href="/findings">Back to findings</a></header>`,
    `<div class="result"><p>${escapeHtml(message)}</p></div>`,
  ].join('\n');
  return shell(title, body, options);
}
