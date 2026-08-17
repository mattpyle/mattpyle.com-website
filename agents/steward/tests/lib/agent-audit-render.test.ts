import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownSummary } from '../../src/lib/agent-audit/render.js';
import {
  countByCategory,
  excerpt,
  rankedFixes,
  stripControlChars,
  type AuditResult,
  type CheckResult,
} from '../../src/lib/agent-audit/result.js';

/**
 * Written as escape sequences, never as literal bytes: a source file with a raw
 * ESC in it is binary to git and unreadable in a diff.
 */
const ESC = '\u001b';
const ANSI_RED = `${ESC}[31m`;

/**
 * The markdown summary is a pure function of the canonical result, so it is
 * tested against a hand-written result document rather than a live audit. That
 * is the property worth protecting: anything the summary can say, the JSON
 * already carries.
 */

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

function fixture(checks: CheckResult[]): AuditResult {
  return {
    schemaVersion: 1,
    tool: { name: 'steward audit-url', version: '0.2.0' },
    target: { input: 'example.com', origin: 'https://example.com' },
    startedAt: '2026-08-10T19:00:00.000Z',
    finishedAt: '2026-08-10T19:00:04.000Z',
    durationMs: 4000,
    requests: 11,
    categories: countByCategory(checks),
    checks,
    notes: [],
  };
}

test('the summary leads with the target, the date and the cost', () => {
  const md = renderMarkdownSummary(fixture([check({ id: 'llms-txt' })]));
  assert.match(md, /^# Agent-readiness audit: example\.com$/m);
  assert.match(md, /https:\/\/example\.com/);
  assert.match(md, /2026-08-10T19:00:00/);
  assert.match(md, /11 HTTP request\(s\) in 4\.0s/);
});

test('the header carries the User-Agent the audit was sent under, when the document has one', () => {
  // The report is what a site owner reads after finding the traffic, so the string they have to
  // match in a log or name in robots.txt belongs in it. A document written before `tool.userAgent`
  // existed is still valid and simply has no such line, which is the second case here.
  const audit = fixture([check({ id: 'llms-txt' })]);
  const withUa = renderMarkdownSummary({
    ...audit,
    tool: { ...audit.tool, userAgent: 'steward-audit/0.2.0 (+https://www.mattpyle.com/steward)' },
  });
  assert.match(withUa, /- \*\*Sent as:\*\* `steward-audit\/0\.2\.0 \(\+https:\/\/www\.mattpyle\.com\/steward\)`/);
  assert.ok(!/Sent as/.test(renderMarkdownSummary(audit)));
});

test('the counts are per category, and no composite score is printed', () => {
  const md = renderMarkdownSummary(
    fixture([
      check({ id: 'robots-txt', category: 'crawlability', status: 'pass' }),
      check({ id: 'sitemap', category: 'crawlability', status: 'fail', fix: 'Publish a sitemap.' }),
      check({ id: 'llms-txt', category: 'discovery', status: 'pass' }),
      check({ id: 'agents-md', category: 'discovery', status: 'not-applicable' }),
      check({ id: 'markdown-negotiation-home', category: 'content-access', status: 'error' }),
    ]),
  );
  assert.match(md, /\| Crawlability \| 1 \| 2 \| 0 \| 0 \|/);
  assert.match(md, /\| Discovery \| 1 \| 1 \| 1 \| 0 \|/);
  assert.match(md, /\| Content access \| 0 \| 0 \| 0 \| 1 \|/);
  assert.ok(!/\bscore\b/i.test(md), 'the summary printed something calling itself a score');
});

test('failures are ranked by severity and carry their fix and evidence', () => {
  const md = renderMarkdownSummary(
    fixture([
      check({
        id: 'content-signals',
        title: 'Content Signals declared',
        severity: 'low',
        status: 'fail',
        observed: 'no Content-Signal directive',
        fix: 'Optional, and new.',
      }),
      check({
        id: 'markdown-negotiation-home',
        title: 'The homepage serves markdown',
        category: 'content-access',
        severity: 'high',
        status: 'fail',
        observed: 'Accept: text/markdown is ignored',
        fix: 'Serve the markdown variant.',
        evidence: [
          { url: 'https://example.com/', status: 200, headers: { 'content-type': 'text/html' }, excerpt: '<!doctype html>…' },
        ],
      }),
    ]),
  );
  const high = md.indexOf('The homepage serves markdown');
  const low = md.indexOf('Content Signals declared');
  assert.ok(high > 0 && low > high, 'the low-severity failure was not ranked below the high one');
  assert.match(md, /### 1\. The homepage serves markdown — high \(Content access\)/);
  assert.match(md, /\*\*Fix:\*\* Serve the markdown variant\./);
  assert.match(md, /`https:\/\/example\.com\/` → 200 `content-type: text\/html`/);
  assert.match(md, /> <!doctype html>…/);
});

test('a clean audit says so instead of printing an empty fix list', () => {
  const md = renderMarkdownSummary(fixture([check({ id: 'llms-txt' })]));
  assert.match(md, /Nothing failed\. Every applicable check passed\./);
});

test('every check is listed with its status, whatever the verdict', () => {
  const checks = [
    check({ id: 'a', status: 'pass' }),
    check({ id: 'b', status: 'fail', fix: 'do the thing' }),
    check({ id: 'c', status: 'not-applicable' }),
    check({ id: 'd', status: 'error' }),
  ];
  const md = renderMarkdownSummary(fixture(checks));
  for (const c of checks) assert.match(md, new RegExp(`\\(\`${c.id}\`\\)`), c.id);
});

test('run-level notes are printed when there are any', () => {
  const result = fixture([check({ id: 'llms-txt' })]);
  result.notes = ['robots.txt disallows this auditor at the site root'];
  assert.match(renderMarkdownSummary(result), /## Notes on the run/);
  result.notes = [];
  assert.ok(!/## Notes on the run/.test(renderMarkdownSummary(result)));
});

test('excerpt strips the control characters that survive whitespace collapsing', () => {
  // `\x1b` is not whitespace, so the old `\s+`-collapsing excerpt passed ANSI
  // straight through to a terminal. A response body is the audited site's text.
  const body = `${ANSI_RED}<!doctype html>${ESC}[0m\u0007 with a bell`;
  const quoted = excerpt(body);
  assert.ok(!quoted.includes(ESC), 'an ESC survived into the excerpt');
  assert.ok(!quoted.includes('\u0007'), 'a BEL survived into the excerpt');
  assert.match(quoted, /\[31m<!doctype html>\[0m with a bell/);
});

test('excerpt keeps a space where each line break was', () => {
  // An excerpt exists to be quoted as evidence, so a fused one misrepresents the
  // file it quotes. temporal.io's robots.txt is two clean lines and read as one
  // malformed line in the 2026-08-16 deep report, because the control-character
  // strip deleted the newline before the whitespace collapse could see it.
  assert.equal(
    excerpt('Sitemap: https://example.com/sitemap.xml\nUser-agent: *\r\nDisallow:'),
    'Sitemap: https://example.com/sitemap.xml User-agent: * Disallow:',
  );

  // And removing a control character that is not whitespace leaves no double
  // space behind it, because the collapse runs on both sides of the strip.
  assert.equal(excerpt(`one ${ESC} two`), 'one two');
});

test('stripControlChars covers C0, C1 and DEL, and leaves real text alone', () => {
  assert.equal(stripControlChars('a\u0000b\u001bc\u007fde'), 'abcde');
  assert.equal(stripControlChars('plain — text, ünicode, 日本語'), 'plain — text, ünicode, 日本語');
});

test('the renderer strips control characters from every remote-derived string', () => {
  // The second layer: `observed` lines interpolate site-chosen text (a page
  // title, a header value) without going through `excerpt`.
  const md = renderMarkdownSummary(
    fixture([
      check({
        id: `id${ESC}[31m`,
        title: `A title${ANSI_RED}`,
        status: 'fail',
        observed: `the page calls itself "${ANSI_RED}Not really"`,
        fix: `do the thing${ESC}[0m`,
        evidence: [
          {
            url: `https://example.com/${ESC}[2K`,
            status: 200,
            headers: { 'content-type': `text/html${ANSI_RED}` },
            note: `a note${ESC}[1m`,
            excerpt: `an excerpt${ESC}[0m`,
          },
        ],
      }),
    ]),
  );
  const result = fixture([check({ id: 'x' })]);
  result.notes = [`a run note${ANSI_RED}`];
  assert.ok(!md.includes(ESC), 'an ESC reached the rendered summary');
  assert.ok(!renderMarkdownSummary(result).includes(ESC), 'an ESC reached a run note');
  // The visible text is kept; only the control byte goes.
  assert.match(md, /A title\[31m/);
});

test('rankedFixes returns only failures, worst first', () => {
  const ranked = rankedFixes([
    check({ id: 'low', severity: 'low', status: 'fail' }),
    check({ id: 'passing', severity: 'high', status: 'pass' }),
    check({ id: 'high', severity: 'high', status: 'fail' }),
    check({ id: 'errored', severity: 'high', status: 'error' }),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.id),
    ['high', 'low'],
  );
});
