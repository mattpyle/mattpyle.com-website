import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, href, renderHtmlReport } from '../../src/lib/agent-audit/render-html.js';
import {
  countByCategory,
  type AuditResult,
  type CheckResult,
} from '../../src/lib/agent-audit/result.js';

/**
 * The HTML report is a pure function of the canonical result, so it is tested
 * against hand-written result documents rather than a live audit — the same
 * shape as `agent-audit-render.test.ts`, and for the same reason.
 *
 * The hostile fixture below is the point of this file. Every string in a result
 * document is, at some remove, text the audited site chose, and this rendering
 * puts it in a document a person opens in a browser.
 */

const ESC = '\u001b';

function check(partial: Partial<CheckResult> & Pick<CheckResult, 'id'>): CheckResult {
  return {
    title: partial.id,
    category: 'discovery',
    severity: 'medium',
    status: 'pass',
    observed: 'observed something',
    evidence: [],
    ...partial,
  };
}

function fixture(checks: CheckResult[], extra: Partial<AuditResult> = {}): AuditResult {
  return {
    schemaVersion: 2,
    tool: { name: 'steward audit-url', version: '0.1.0' },
    target: { input: 'example.com', origin: 'https://example.com' },
    startedAt: '2026-08-11T19:00:00.000Z',
    finishedAt: '2026-08-11T19:00:04.000Z',
    durationMs: 4000,
    requests: 11,
    categories: countByCategory(checks),
    checks,
    notes: [],
    ...extra,
  };
}

/**
 * A result document written by an audited site that would rather the report said
 * something else: markup and quotes in every field a renderer interpolates.
 */
function hostile(): AuditResult {
  const payload = '<script>alert(1)</script>';
  return fixture(
    [
      check({
        id: `id"><b>${ESC}[31m`,
        title: `A title ${payload}`,
        status: 'fail',
        severity: 'high',
        observed: `the page calls itself "${payload}" & more`,
        fix: `Remove the <img src=x onerror=alert(1)> from the page`,
        evidence: [
          {
            url: 'https://example.com/"><script>alert(1)</script>',
            status: 200,
            headers: { 'content-type': `text/html"><b>${payload}` },
            note: `a note ${payload}`,
            excerpt: `<!doctype html><script>alert(1)</script>`,
          },
          { url: 'javascript:alert(1)', note: 'not a link' },
        ],
      }),
    ],
    {
      target: { input: `example.com"><script>`, origin: 'https://example.com' },
      tool: { name: 'steward audit-url<script>', version: '0.1.0"' },
      notes: [`a run note ${payload}`],
    },
  );
}

test('the report leads with the target, the run, the tool and the cost', () => {
  const html = renderHtmlReport(
    fixture([check({ id: 'llms-txt' })], { browserPages: 3, requests: 14, durationMs: 30000 }),
  );
  assert.match(html, /<title>Agent-readiness audit: example\.com<\/title>/);
  assert.match(html, /<h1>Agent-readiness audit: example\.com<\/h1>/);
  // The zone is named rather than left as a `Z` a reader has to decode: an
  // evening run in Vancouver is already tomorrow in UTC, and a bare ISO stamp
  // is the misreading this repo's date rule exists to stop.
  assert.match(html, /<dt>Run<\/dt><dd>2026-08-11 19:00 UTC<\/dd>/);
  assert.match(html, /result schema v2/);
  assert.match(html, /14 HTTP request\(s\) and 3 page\(s\) rendered in a browser/);
  assert.match(html, /in 30\.0s/);
});

test('the headline is the measured numbers, each with the sample it covers', () => {
  const html = renderHtmlReport(
    fixture([
      check({
        id: 'lighthouse-performance',
        category: 'rendered-experience',
        status: 'fail',
        metric: { label: 'Performance', value: 62, unit: 'score', pages: 3 },
      }),
      check({
        id: 'axe-violations',
        category: 'rendered-experience',
        status: 'pass',
        metric: { label: 'axe violations', value: 0, unit: 'count', pages: 3 },
      }),
    ]),
  );
  assert.match(html, /<p class="tile-label">Performance<\/p>/);
  assert.match(html, /<p class="tile-value">62<span class="tile-of"> \/ 100<\/span><\/p>/);
  // A count gets no denominator; a score does.
  assert.match(html, /<p class="tile-value">0<\/p>/);
  assert.match(html, /over 3 rendered pages/);
  assert.match(html, /class="tile status-fail"/);
  assert.match(html, /class="tile status-pass"/);
});

test('a fast-only run renders without a headline section rather than with an empty one', () => {
  const html = renderHtmlReport(fixture([check({ id: 'llms-txt' })]));
  assert.ok(!html.includes('The numbers'), 'a headline section was rendered with nothing to put in it');
  assert.ok(!html.includes('class="tiles"'));
});

test('the counts are per category, and no composite score is printed', () => {
  const html = renderHtmlReport(
    fixture([
      check({ id: 'robots-txt', category: 'crawlability', status: 'pass' }),
      check({ id: 'sitemap', category: 'crawlability', status: 'fail', fix: 'Publish a sitemap.' }),
      check({ id: 'agents-md', category: 'discovery', status: 'not-applicable' }),
    ]),
  );
  assert.match(html, /<th scope="row">Crawlability<\/th><td class="num">1<\/td><td class="num">2<\/td>/);
  // "score" appears legitimately in the caption's reason for not printing one,
  // and in a Lighthouse metric label; what must not appear is a total.
  assert.ok(!/composite score of/i.test(html));
});

test('failures are ranked worst first and carry their fix and evidence', () => {
  const html = renderHtmlReport(
    fixture([
      check({ id: 'content-signals', title: 'Content Signals declared', severity: 'low', status: 'fail', fix: 'Optional.' }),
      check({
        id: 'markdown-negotiation-home',
        title: 'The homepage serves markdown',
        severity: 'high',
        status: 'fail',
        fix: 'Serve the markdown variant.',
        evidence: [{ url: 'https://example.com/', status: 200, headers: { 'content-type': 'text/html' }, excerpt: 'hi' }],
      }),
    ]),
  );
  const high = html.indexOf('The homepage serves markdown');
  const low = html.indexOf('Content Signals declared');
  assert.ok(high > 0 && low > high, 'the low-severity failure was not ranked above the high one');
  assert.match(html, /<h3><span class="fix-n">1\.<\/span> The homepage serves markdown<\/h3>/);
  assert.match(html, /High severity/);
  assert.match(html, /<strong>Fix:<\/strong> Serve the markdown variant\./);
  assert.match(html, /<summary>Evidence \(1\)<\/summary>/);
  assert.match(html, /<a href="https:\/\/example\.com\/" rel="noreferrer nofollow noopener">/);
});

test('a clean audit says so instead of printing an empty fix list', () => {
  const html = renderHtmlReport(fixture([check({ id: 'llms-txt' })]));
  assert.match(html, /Nothing failed\. Every applicable check passed\./);
});

test('every check is listed with a status word, not only a colour', () => {
  const checks = [
    check({ id: 'a', status: 'pass' }),
    check({ id: 'b', status: 'fail', fix: 'do the thing' }),
    check({ id: 'c', status: 'not-applicable' }),
    check({ id: 'd', status: 'error' }),
  ];
  const html = renderHtmlReport(fixture(checks));
  for (const c of checks) assert.match(html, new RegExp(`<code class="cid">${c.id}</code>`), c.id);
  for (const label of ['Pass', 'Fail', 'Not applicable', 'Not judged']) {
    assert.ok(html.includes(`>${label}</span>`), `no text carried the ${label} status`);
  }
});

test('run-level notes are rendered when there are any', () => {
  const result = fixture([check({ id: 'llms-txt' })]);
  result.notes = ['robots.txt disallows this auditor at the site root'];
  assert.match(renderHtmlReport(result), /Notes on the run/);
  result.notes = [];
  assert.ok(!/Notes on the run/.test(renderHtmlReport(result)));
});

// ---------------------------------------------------------------------------
// The hostile fixture
// ---------------------------------------------------------------------------

test('a hostile result document produces no script element at all', () => {
  const html = renderHtmlReport(hostile());
  // The strongest form of the claim, and the one worth asserting on the bytes:
  // the only `<` that survives from a site-supplied string is an escaped one.
  assert.ok(!/<script/i.test(html), 'a script element reached the report');
  assert.ok(!/onerror/i.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'an event handler survived unescaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'the payload was not displayed as text');
});

test('site-supplied markup is displayed as text in every field the report renders', () => {
  const html = renderHtmlReport(hostile());
  for (const fragment of [
    'A title &lt;script&gt;',       // title
    'calls itself &quot;',          // observed, with its quotes escaped
    '&amp; more',                   // an ampersand, escaped once and only once
    'Remove the &lt;img src=x',     // fix copy
    'a note &lt;script&gt;',        // evidence note
    'text/html&quot;&gt;&lt;b&gt;', // a header value
    'a run note &lt;script&gt;',    // a run-level note
    'example.com&quot;&gt;&lt;script&gt;', // the target as the caller typed it
    'steward audit-url&lt;script&gt;',     // even the tool name
  ]) {
    assert.ok(html.includes(fragment), `not escaped into the document: ${fragment}`);
  }
});

test('nothing reaches an attribute unescaped, and a non-http URL is text rather than a link', () => {
  const html = renderHtmlReport(hostile());
  // The evidence URL carries a quote and a tag: it must not be able to close the
  // `href` attribute and open an attribute of its own.
  assert.ok(!/href="[^"]*<"/.test(html));
  assert.match(html, /href="https:\/\/example\.com\/%22%3E%3Cscript%3Ealert\(1\)%3C\/script%3E"/);
  assert.ok(!html.includes('href="javascript:'), 'a javascript: URL was rendered as a link');
  assert.match(html, /<code>javascript:alert\(1\)<\/code>/);
});

test('control characters are stripped as well as escaped', () => {
  const html = renderHtmlReport(hostile());
  assert.ok(!html.includes(ESC), 'an ESC reached the rendered report');
});

test('the report requests nothing from the network', () => {
  // A report that fetched anything when a reader opened it — from the audited
  // site or anywhere else — would be a tracking beacon with a byline.
  //
  // Asserted over the real tags rather than over the whole string: site-supplied
  // text can legitimately contain `src=` or `url(`, and by that point it is
  // escaped and is prose. Every `<` that is still a tag is one this file wrote.
  const html = renderHtmlReport(hostile());
  const tags = html.match(/<[a-z!/][^>]*>/gi) ?? [];
  const fetching = /^<(script|link|img|iframe|object|embed|video|audio|source|track|input)\b/i;
  for (const tag of tags) {
    assert.ok(!fetching.test(tag), `the report carries a fetching element: ${tag}`);
    assert.ok(!/\ssrc=|\ssrcset=|\sbackground=|\sposter=/i.test(tag), `a tag can fetch: ${tag}`);
  }
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.ok(style.length > 0, 'no inline stylesheet was found');
  assert.ok(!/url\(|@import|@font-face/i.test(style), 'the stylesheet reaches off the page');
  // Anchors are fine: they fetch nothing until a person clicks them.
  assert.match(html, /<a href="https:\/\/example\.com\/"/);
});

test('the document is a well-formed page a browser will not quirks-mode', () => {
  const html = renderHtmlReport(fixture([check({ id: 'llms-txt' })]));
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
  // Heading order: one h1, then h2 sections, then h3 inside the fix list only.
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1);
  const firstH3 = html.indexOf('<h3');
  const firstH2 = html.indexOf('<h2');
  assert.ok(firstH2 > 0 && (firstH3 === -1 || firstH3 > firstH2), 'an h3 appeared before any h2');
});

test('a timestamp the document cannot parse is shown rather than dropped', () => {
  const html = renderHtmlReport(fixture([check({ id: 'a' })], { startedAt: 'some time on Tuesday' }));
  assert.match(html, /<dt>Run<\/dt><dd>some time on Tuesday<\/dd>/);
});

test('esc covers the five metacharacters and leaves real text alone', () => {
  assert.equal(esc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(esc('plain — text, ünicode, 日本語'), 'plain — text, ünicode, 日本語');
  assert.equal(esc(`a${ESC}[31mb`), 'a[31mb');
});

test('href passes http and https, and refuses everything else', () => {
  assert.equal(href('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(href('http://example.com/'), 'http://example.com/');
  assert.equal(href('javascript:alert(1)'), null);
  assert.equal(href('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(href('file:///C:/secrets.txt'), null);
  assert.equal(href('not a url'), null);
});
