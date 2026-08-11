import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownSummary } from '../../src/lib/agent-audit/render.js';
import { countByCategory, rankedFixes, type AuditResult, type CheckResult } from '../../src/lib/agent-audit/result.js';

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
    tool: { name: 'steward audit-url', version: '0.1.0' },
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
