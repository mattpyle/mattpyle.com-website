import {
  rankedFixes,
  stripControlChars,
  type AuditResult,
  type CheckEvidence,
  type CheckMetric,
  type CheckResult,
} from './result.js';

/**
 * The interactive HTML report — the third of the report's three renderings (the
 * JSON is the first, the markdown summary in `render.ts` the second).
 *
 * A pure function of the canonical result, on the same terms as the markdown
 * renderer: if this file ever needs a fact the JSON does not carry, the JSON is
 * wrong, not this file. `CheckMetric` exists because of that rule — the headline
 * numbers are read out of the document rather than recovered by regex from an
 * `observed` sentence.
 *
 * One file a person opens. Everything it needs is inside it:
 *
 * - **No JavaScript.** All drill-down is `<details>`/`<summary>`, which the
 *   browser implements. There is no `<script>` element in the output at all,
 *   which turns "this report cannot execute the audited site's text" from a
 *   claim about the escaping into something a test can assert about the bytes.
 * - **No external request of any kind**: no stylesheet link, no font, no image,
 *   no `url()` in the CSS. A report *about* a site must not fetch anything from
 *   that site — or from anywhere else — when a person opens it days later. Links
 *   to the audited site's URLs are plain anchors, which fetch nothing until
 *   somebody clicks them.
 * - **It passes an accessibility scan.** An agent-readiness report that fails
 *   axe argues against its own tool: heading order, native disclosure widgets,
 *   real table headers, and contrast that holds in both colour schemes. That is
 *   a claim with a command behind it — `npm run check:html-report -w
 *   @mattpyle/steward` renders a fixture worse than any real report and runs
 *   `runAxe` over it, the same runner the audit itself uses. It is a script
 *   rather than a test because it launches a browser, and the Steward suite has
 *   no browser and no network in it.
 *
 * ## Escaping
 *
 * Every interpolated value is, at some remove, text the audited site chose: a
 * page title, a header value, a quoted body, a URL. It lands in an HTML document
 * a person opens in a browser. **Every one of them goes through `esc()`**, and
 * URLs going into an `href` go through `href()` as well, which drops any scheme
 * that is not http(s) — `javascript:` in an anchor is script execution that no
 * amount of entity-escaping prevents.
 *
 * `stripControlChars` runs first, inside `esc()`, but it is not the HTML
 * defence and never was (build-log entry 20 records the warning): it removes
 * bytes that repaint a *terminal*, and `<` is not one of them.
 */

/**
 * Every lookup in this file is `Record<string, string>` rather than a record over
 * the union, and every one of them has a fallback.
 *
 * The result document is an interface, not an internal type: it can be written
 * by a newer version of the auditor, or by hand. A `status` this file has never
 * seen used to render the word `undefined` next to a check, which is a report
 * lying about a verdict rather than admitting it does not know the word.
 */
const STATUS_LABEL: Record<string, string> = {
  pass: 'Pass',
  fail: 'Fail',
  'not-applicable': 'Not applicable',
  error: 'Not judged',
};

const CATEGORY_LABEL: Record<string, string> = {
  crawlability: 'Crawlability',
  discovery: 'Discovery',
  'content-access': 'Content access',
  'rendered-experience': 'Rendered experience',
};

const SEVERITY_LABEL: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** The status as a word, or the raw value escaped when it is not one we know. */
function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? esc(status);
}

/** The severity as a word, on the same terms. */
function severityLabel(severity: string): string {
  return SEVERITY_LABEL[severity] ?? esc(severity);
}

/**
 * A value on its way into a `class` attribute, reduced to a bare CSS token.
 *
 * `status` and `severity` come out of the same document as everything else, so
 * they get the same treatment `category` already gets. Escaping alone would keep
 * a hostile value inside its quotes, but a class name has no business holding
 * anything but a token, and an unknown status styles as no status rather than as
 * a class of the document's choosing.
 */
function cssToken(value: string): string {
  return /^[a-z][a-z0-9-]*$/.test(value) ? value : 'unknown';
}

/**
 * The one way a value gets into this document.
 *
 * Control characters first (the terminal defence, kept because the same strings
 * are also read in a console), then the five HTML metacharacters. Quotes are
 * escaped too, not only the angle brackets: several of these values land inside
 * a double-quoted attribute, and a `"` there ends the attribute and starts a new
 * one of the site's choosing.
 */
export function esc(value: string): string {
  return stripControlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An escaped `href`, or `null` when the URL is one this report will not link to.
 *
 * Only `http:` and `https:` survive. Everything the auditor fetches is one of
 * those, so nothing legitimate is lost, and the rule holds against a future
 * check that puts a site-supplied URL into evidence — a `javascript:` or `data:`
 * URL in an anchor runs when a reader clicks it, and escaping does not touch it.
 * A refused URL is still shown, as text.
 */
export function href(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return esc(parsed.href);
}

/**
 * An ISO timestamp shown as the UTC wall clock it is, with the zone named.
 *
 * The document stores UTC, which is right for machine data; a person reading it
 * is the problem. A bare `2026-08-12T04:11:00.688Z` reads as a date the reader
 * may not have reached yet, or has already left, depending where they are.
 *
 * No zone is hard-coded here, and none should be: this report is written for
 * whoever the audit was run for, and the renderer knows nothing about them. It
 * cannot convert to the reader's own zone either — that needs JavaScript, and
 * this file ships none. So it prints the UTC wall clock with `UTC` next to it,
 * and a reader who cares does the arithmetic knowing which way to go.
 *
 * An unparseable value is shown verbatim rather than dropped: it is still the
 * document's own claim about when the run happened.
 */
function utcStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A URL as a link where it can be one, and as inert text where it cannot. */
function urlHtml(url: string): string {
  const safeHref = href(url);
  const text = `<code>${esc(url)}</code>`;
  // `rel` because this document is opened from disk and the audited site has no
  // business learning that, or being reachable through `window.opener`.
  return safeHref
    ? `<a href="${safeHref}" rel="noreferrer nofollow noopener">${text}</a>`
    : text;
}

/**
 * The headline tiles: the numbers a person came for.
 *
 * Whatever the checks measured, in declaration order, each with the sample it
 * was measured over. The sample size is not decoration — three pages of a
 * three-hundred-page site is a sample, and a bare number reads as a verdict on
 * the whole site (build-log entry 21).
 */
function metricTile(check: CheckResult, metric: CheckMetric): string {
  // `/ 100` only on a score. A violation count has no denominator, and giving it
  // one would turn "3 violations" into a mark out of a hundred.
  const outOf = metric.unit === 'score' ? '<span class="tile-of"> / 100</span>' : '';
  const over =
    metric.pages === undefined
      ? ''
      : `<p class="tile-sample">over ${metric.pages} rendered page${metric.pages === 1 ? '' : 's'}</p>`;
  return [
    `<li class="tile status-${cssToken(check.status)}">`,
    `<p class="tile-label">${esc(metric.label)}</p>`,
    `<p class="tile-value">${esc(String(metric.value))}${outOf}</p>`,
    `<p class="tile-status">${statusLabel(check.status)}</p>`,
    over,
    '</li>',
  ].join('');
}

function evidenceHtml(evidence: CheckEvidence[]): string {
  if (evidence.length === 0) return '';
  const items = evidence.map((ev) => {
    const parts: string[] = [];
    const head: string[] = [];
    if (ev.url) head.push(urlHtml(ev.url));
    if (ev.status !== undefined) head.push(`<span class="ev-status">→ ${esc(String(ev.status))}</span>`);
    if (head.length > 0) parts.push(`<p class="ev-head">${head.join(' ')}</p>`);
    const headers = Object.entries(ev.headers ?? {});
    if (headers.length > 0) {
      parts.push(
        `<ul class="ev-headers">${headers
          .map(([k, v]) => `<li><code>${esc(k)}: ${esc(v)}</code></li>`)
          .join('')}</ul>`,
      );
    }
    if (ev.note) parts.push(`<p class="ev-note">${esc(ev.note)}</p>`);
    if (ev.excerpt) parts.push(`<blockquote class="ev-excerpt"><p>${esc(ev.excerpt)}</p></blockquote>`);
    return `<li>${parts.join('')}</li>`;
  });
  return [
    '<details class="evidence">',
    `<summary>Evidence (${evidence.length})</summary>`,
    `<ul class="ev-list">${items.join('')}</ul>`,
    '</details>',
  ].join('');
}

function fixHtml(check: CheckResult, index: number): string {
  return [
    '<li class="fix">',
    `<h3><span class="fix-n">${index + 1}.</span> ${esc(check.title)}</h3>`,
    '<p class="fix-meta">',
    `<span class="sev sev-${cssToken(check.severity)}">${severityLabel(check.severity)} severity</span> `,
    `<span class="cat">${esc(CATEGORY_LABEL[check.category] ?? check.category)}</span> `,
    `<code class="cid">${esc(check.id)}</code>`,
    '</p>',
    `<p class="observed"><strong>What was found:</strong> ${esc(check.observed)}</p>`,
    check.fix ? `<p class="fix-do"><strong>Fix:</strong> ${esc(check.fix)}</p>` : '',
    evidenceHtml(check.evidence),
    '</li>',
  ].join('');
}

function checkRowHtml(check: CheckResult): string {
  return [
    '<tr>',
    `<td><span class="pill status-${cssToken(check.status)}">${statusLabel(check.status)}</span></td>`,
    `<td>${esc(check.title)}<br><code class="cid">${esc(check.id)}</code></td>`,
    `<td>${esc(CATEGORY_LABEL[check.category] ?? check.category)}</td>`,
    `<td>${esc(check.observed)}${evidenceHtml(check.evidence)}</td>`,
    '</tr>',
  ].join('');
}

/**
 * The whole stylesheet, inline.
 *
 * No `url()`, no `@import`, no web font: opening this file makes zero network
 * requests, and that is asserted by test rather than asserted here. The fonts
 * are the generic families every platform already has.
 *
 * Both colour schemes are defined, and every foreground/background pair in both
 * clears WCAG AA for its size. `npm run check:html-report -w @mattpyle/steward`
 * scans a rendered fixture with axe, and the axe job in `.github/workflows/
 * a11y.yml` runs that command on every pull request, so a contrast regression
 * here fails a check rather than waiting for somebody to look.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #14161a;
  --muted: #4a5058;
  --rule: #d5d9e0;
  --panel: #f5f6f8;
  --pass: #0b6a34;
  --fail: #a01722;
  --warn: #7a4a00;
  --na: #4a5058;
  --link: #0b4fa8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #eceef2;
    --muted: #b3bac4;
    --rule: #333942;
    --panel: #1d2128;
    --pass: #5fd08a;
    --fail: #ff9aa2;
    --warn: #f0c070;
    --na: #b3bac4;
    --link: #8ab6ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 2rem 1.25rem 5rem;
  max-width: 62rem;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 1rem;
  line-height: 1.55;
}
code, .tile-value { font-family: ui-monospace, monospace; }
a { color: var(--link); }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 .5rem; }
h2 { font-size: 1.25rem; margin: 2.5rem 0 .75rem; }
h3 { font-size: 1.05rem; margin: 0 0 .35rem; }
p { margin: .4rem 0; }
.lede { color: var(--muted); margin-bottom: 1.5rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 1rem 0 0; }
dl.meta dt { color: var(--muted); }
dl.meta dd { margin: 0; }
.tiles { display: flex; flex-wrap: wrap; gap: .75rem; list-style: none; padding: 0; margin: 0; }
.tile {
  flex: 1 1 9rem;
  border: 1px solid var(--rule);
  border-left: .35rem solid var(--na);
  border-radius: .4rem;
  background: var(--panel);
  padding: .75rem .9rem;
}
.tile p { margin: 0; }
.tile-label { color: var(--muted); font-size: .85rem; }
.tile-value { font-size: 1.9rem; line-height: 1.2; }
.tile-of { font-size: .9rem; color: var(--muted); }
.tile-status { font-size: .9rem; font-weight: 600; }
.tile-sample { color: var(--muted); font-size: .8rem; }
.tile.status-pass { border-left-color: var(--pass); }
.tile.status-pass .tile-status { color: var(--pass); }
.tile.status-fail { border-left-color: var(--fail); }
.tile.status-fail .tile-status { color: var(--fail); }
.tile.status-error { border-left-color: var(--warn); }
.tile.status-error .tile-status { color: var(--warn); }
table { border-collapse: collapse; width: 100%; margin: .5rem 0; }
caption { text-align: left; color: var(--muted); padding-bottom: .4rem; }
th, td { border-bottom: 1px solid var(--rule); padding: .45rem .6rem; text-align: left; vertical-align: top; }
th { font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
td.num, th.num { text-align: right; font-family: ui-monospace, monospace; }
.pill { font-size: .8rem; font-weight: 600; white-space: nowrap; }
.pill.status-pass { color: var(--pass); }
.pill.status-fail { color: var(--fail); }
.pill.status-error { color: var(--warn); }
.pill.status-not-applicable { color: var(--na); }
ol.fixes { list-style: none; counter-reset: none; padding: 0; margin: 0; }
li.fix { border: 1px solid var(--rule); border-radius: .4rem; padding: .9rem 1rem; margin: 0 0 .9rem; }
.fix-n { color: var(--muted); }
.fix-meta { font-size: .85rem; color: var(--muted); margin-bottom: .5rem; }
.sev { font-weight: 600; }
.sev-high { color: var(--fail); }
.sev-medium { color: var(--warn); }
.sev-low { color: var(--muted); }
.cid { color: var(--muted); font-size: .85em; }
details.evidence { margin: .6rem 0 0; }
details.evidence summary { cursor: pointer; color: var(--link); font-size: .9rem; }
details.evidence summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
ul.ev-list { list-style: none; padding: 0; margin: .5rem 0 0; }
ul.ev-list > li { border-left: 2px solid var(--rule); padding: .1rem 0 .1rem .75rem; margin: 0 0 .6rem; }
ul.ev-headers { list-style: none; padding: 0; margin: .2rem 0; font-size: .9rem; }
.ev-status { color: var(--muted); }
.ev-note { font-size: .9rem; }
.ev-excerpt { border-left: 2px solid var(--rule); margin: .3rem 0; padding-left: .6rem; color: var(--muted); font-size: .9rem; }
.ev-excerpt p { margin: 0; }
code { word-break: break-word; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .85rem; }
@media (max-width: 34rem) {
  body { padding: 1.25rem .9rem 3rem; }
  dl.meta { grid-template-columns: 1fr; }
  dl.meta dd { margin-bottom: .4rem; }
}
`;

export function renderHtmlReport(audit: AuditResult): string {
  const host = new URL(audit.target.origin).host;
  const fixes = rankedFixes(audit.checks);
  const measured = audit.checks.filter(
    (c): c is CheckResult & { metric: CheckMetric } => c.metric !== undefined,
  );

  const cost =
    `${audit.requests} HTTP request(s)` +
    (audit.browserPages === undefined
      ? ''
      : ` and ${audit.browserPages} page(s) rendered in a browser, whose own requests are not counted here`) +
    ` in ${(audit.durationMs / 1000).toFixed(1)}s`;

  const out: string[] = [];
  out.push('<!doctype html>');
  out.push('<html lang="en">');
  out.push('<head>');
  out.push('<meta charset="utf-8">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>Agent-readiness audit: ${esc(host)}</title>`);
  out.push(`<style>${STYLE}</style>`);
  out.push('</head>');
  out.push('<body>');

  out.push('<header>');
  out.push(`<h1>Agent-readiness audit: ${esc(host)}</h1>`);
  out.push(
    `<p class="lede">What an AI agent gets when it comes to this site, checked by ${esc(audit.tool.name)}.</p>`,
  );
  out.push('<dl class="meta">');
  out.push(`<dt>Target</dt><dd>${urlHtml(audit.target.origin)} (given as <code>${esc(audit.target.input)}</code>)</dd>`);
  out.push(`<dt>Run</dt><dd>${esc(utcStamp(audit.startedAt))}</dd>`);
  out.push(
    `<dt>Tool</dt><dd>${esc(audit.tool.name)} ${esc(audit.tool.version)}, result schema v${esc(String(audit.schemaVersion))}</dd>`,
  );
  out.push(`<dt>Cost</dt><dd>${esc(cost)}</dd>`);
  out.push('</dl>');
  out.push('</header>');

  out.push('<main>');

  if (measured.length > 0) {
    out.push('<section aria-labelledby="measured">');
    out.push('<h2 id="measured">The numbers</h2>');
    out.push(
      '<p class="lede">Each number is the worst result across the pages that were rendered, from the same tool runs the checks below were decided on.</p>',
    );
    out.push('<ul class="tiles">');
    for (const check of measured) out.push(metricTile(check, check.metric));
    out.push('</ul>');
    out.push('</section>');
  }

  out.push('<section aria-labelledby="counts">');
  out.push('<h2 id="counts">Checks passed</h2>');
  out.push('<table>');
  out.push(
    '<caption>Per-category counts.</caption>',
  );
  out.push(
    '<thead><tr><th scope="col">Category</th><th scope="col" class="num">Checked</th><th scope="col" class="num">Passed</th><th scope="col" class="num">Not applicable</th><th scope="col" class="num">Not judged</th></tr></thead>',
  );
  out.push('<tbody>');
  for (const row of audit.categories) {
    out.push(
      `<tr><th scope="row">${esc(CATEGORY_LABEL[row.category] ?? row.category)}</th>` +
        `<td class="num">${row.applicable}</td><td class="num">${row.passed}</td>` +
        `<td class="num">${row.notApplicable}</td><td class="num">${row.errors}</td></tr>`,
    );
  }
  out.push('</tbody></table>');
  out.push('</section>');

  out.push('<section aria-labelledby="fixes">');
  out.push('<h2 id="fixes">Fixes, most important first</h2>');
  if (fixes.length === 0) {
    out.push('<p>Nothing failed. Every applicable check passed.</p>');
  } else {
    out.push('<ol class="fixes">');
    fixes.forEach((check, i) => out.push(fixHtml(check, i)));
    out.push('</ol>');
  }
  out.push('</section>');

  out.push('<section aria-labelledby="all-checks">');
  out.push('<h2 id="all-checks">Every check</h2>');
  out.push('<table>');
  out.push('<caption>All checks the run made, in the order they were run, whatever the verdict.</caption>');
  out.push(
    '<thead><tr><th scope="col">Status</th><th scope="col">Check</th><th scope="col">Category</th><th scope="col">What was observed</th></tr></thead>',
  );
  out.push('<tbody>');
  for (const check of audit.checks) out.push(checkRowHtml(check));
  out.push('</tbody></table>');
  out.push('</section>');

  if (audit.notes.length > 0) {
    out.push('<section aria-labelledby="notes">');
    out.push('<h2 id="notes">Notes on the run</h2>');
    out.push('<ul>');
    for (const note of audit.notes) out.push(`<li>${esc(note)}</li>`);
    out.push('</ul>');
    out.push('</section>');
  }

  out.push('</main>');
  out.push(
    `<footer><p>Generated by ${esc(audit.tool.name)} ${esc(audit.tool.version)} at ${esc(utcStamp(audit.finishedAt))}.</p></footer>`,
  );
  out.push('</body>');
  out.push('</html>');

  return out.join('\n');
}
