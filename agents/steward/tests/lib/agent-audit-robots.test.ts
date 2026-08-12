import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFor, isAllowed, parseRobots } from '../../src/lib/agent-audit/robots.js';

/**
 * The robots.txt parser, which the auditor uses to obey the target as well as to
 * report on it. Obedience is the load-bearing half: a wrong `isAllowed` makes
 * this tool fetch something the site asked it not to.
 */

const SAMPLE = `
# a comment
User-agent: *
Disallow: /admin/
Allow: /admin/public/
Crawl-delay: 10

User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /

Sitemap: https://example.com/sitemap-index.xml
Content-Signal: search=yes, ai-train=no
`;

test('parses groups, sitemaps and Content-Signal', () => {
  const robots = parseRobots(SAMPLE);
  assert.equal(robots.groups.length, 2);
  assert.deepEqual(robots.groups[0].agents, ['*']);
  assert.equal(robots.groups[0].crawlDelay, 10);
  // Consecutive User-agent lines form one group; a rule line ends the run.
  assert.deepEqual(robots.groups[1].agents, ['gptbot', 'claudebot']);
  assert.deepEqual(robots.sitemaps, ['https://example.com/sitemap-index.xml']);
  assert.deepEqual(robots.contentSignals, ['search=yes, ai-train=no']);
  assert.equal(robots.malformedLines.length, 0);
});

test('the longest matching rule wins, and Allow wins a tie', () => {
  const robots = parseRobots(SAMPLE);
  assert.equal(isAllowed(robots, 'steward-audit-url', '/admin/secret').allowed, false);
  assert.equal(isAllowed(robots, 'steward-audit-url', '/admin/public/x').allowed, true);
  assert.equal(isAllowed(robots, 'steward-audit-url', '/writing/hello/').allowed, true);

  const tie = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x\n');
  assert.equal(isAllowed(tie, 'anyone', '/x').allowed, true);
});

test('a specific record beats the wildcard, and is not merged with it', () => {
  const robots = parseRobots(SAMPLE);
  // GPTBot's own record says Disallow: / — the wildcard's Allow does not apply.
  assert.equal(isAllowed(robots, 'GPTBot', '/admin/public/x').allowed, false);
  assert.equal(groupFor(robots, 'GPTBot')?.agents.includes('gptbot'), true);
  // An unnamed agent falls back to the wildcard.
  assert.equal(groupFor(robots, 'Bingbot')?.agents[0], '*');
});

test('an agent token matches as a case-insensitive substring, longest first', () => {
  const robots = parseRobots(
    'User-agent: googlebot\nDisallow: /a\n\nUser-agent: googlebot-news\nDisallow: /b\n',
  );
  assert.equal(isAllowed(robots, 'Googlebot-News', '/b').allowed, false);
  assert.equal(isAllowed(robots, 'Googlebot-News', '/a').allowed, true, 'the more specific record wins outright');
  assert.equal(isAllowed(robots, 'Googlebot-Image', '/a').allowed, false);
});

test('wildcards and end-anchors in paths are honoured', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp\n');
  assert.equal(isAllowed(robots, 'x', '/papers/report.pdf').allowed, false);
  assert.equal(isAllowed(robots, 'x', '/papers/report.pdf.html').allowed, true);
  // An unanchored rule is a prefix match, so /tmp covers /tmpfiles too.
  assert.equal(isAllowed(robots, 'x', '/tmpfiles/a').allowed, false);
});

test('an empty Disallow allows everything, per the standard', () => {
  const robots = parseRobots('User-agent: *\nDisallow:\n');
  assert.equal(isAllowed(robots, 'x', '/anything').allowed, true);
});

test('malformed lines are reported rather than silently dropped', () => {
  const robots = parseRobots('User-agent: *\nDisallow /admin\nDisallow: /ok\n');
  assert.equal(robots.malformedLines.length, 1);
  assert.equal(robots.malformedLines[0].line, 2);
  // The rule with the missing colon is not in force — which is the point of
  // reporting it, since the author clearly thought it was.
  assert.equal(isAllowed(robots, 'x', '/admin').allowed, true);
});

test('a pathological wildcard pattern cannot hang the matcher', () => {
  // The pattern comes from the audited site. Compiled to a regex, which is what
  // this did first, `/a*a*a*…$` against a long non-matching path is
  // catastrophic backtracking: the site being audited hangs the auditor with a
  // file the auditor is obliged to read first.
  // The trailing literal is what makes it pathological: every `*` has to be
  // re-tried before the whole thing can fail.
  const robots = parseRobots(`User-agent: *\nDisallow: /${'a*'.repeat(24)}b$\n`);
  const path = `/${'a'.repeat(4000)}c`;
  const started = Date.now();
  assert.equal(isAllowed(robots, 'steward-audit-url', path).allowed, true);
  assert.ok(Date.now() - started < 1000, 'the matcher took longer than a second on one path');
});

test('rules before any User-agent line are reported as malformed', () => {
  const robots = parseRobots('Disallow: /everything\n');
  assert.equal(robots.malformedLines.length, 1);
  assert.equal(robots.groups.length, 0);
  assert.equal(isAllowed(robots, 'x', '/everything').allowed, true);
});
