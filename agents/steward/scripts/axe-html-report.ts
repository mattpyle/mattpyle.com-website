/**
 * Runs axe over a generated `audit-url` HTML report.
 *
 * `npm run check:html-report -w @mattpyle/steward`
 *
 * The report claims to be accessible, and an agent-readiness report that fails
 * an accessibility scan argues against its own tool. This is the check behind
 * that claim, and it is a script rather than a test on purpose: it launches a
 * browser, and the Steward suite is plain `node --test` with no browser and no
 * network in it. Keeping this out of `npm test` keeps that property true.
 *
 * The runner is `runAxe` from `lib/audit-engine.ts` — the same one the audit
 * itself calls, and the same one behind /scorecard, so a violation here means
 * what a violation there means.
 *
 * The fixture is built to be worse than a real report: every status, every
 * severity, pass and fail and error tiles side by side, evidence of every shape,
 * and long text. A clean run against a site that passed everything would exercise
 * about half of the markup.
 *
 * With an argument, scans that file instead: `... -- path/to/report.html`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAxe } from '../src/lib/audit-engine.js';
import { renderHtmlReport } from '../src/lib/agent-audit/render-html.js';
import { TOOL_NAME, TOOL_VERSION } from '../src/lib/agent-audit/checks.js';
import { AUDIT_USER_AGENT } from '../src/lib/agent-audit/safe-fetch.js';
import { countByCategory, type AuditResult, type CheckResult } from '../src/lib/agent-audit/result.js';

const CHECKS: CheckResult[] = [
  {
    id: 'robots-txt',
    title: 'robots.txt exists and parses',
    category: 'crawlability',
    severity: 'high',
    status: 'pass',
    observed: 'robots.txt parsed: 4 group(s), 2 sitemap line(s)',
    evidence: [
      {
        url: 'https://example.com/robots.txt',
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=3600' },
        excerpt: 'User-agent: * Allow: / Sitemap: https://example.com/sitemap.xml',
      },
    ],
  },
  {
    id: 'sitemap',
    title: 'A sitemap is declared in robots.txt and fetchable',
    category: 'crawlability',
    severity: 'high',
    status: 'fail',
    observed: 'robots.txt names no sitemap',
    fix: 'Add a `Sitemap:` line to robots.txt pointing at your sitemap index.',
    evidence: [{ note: 'robots.txt parsed cleanly and contained no Sitemap: line' }],
  },
  {
    id: 'content-signals',
    title: 'Content Signals declared',
    category: 'crawlability',
    severity: 'low',
    status: 'fail',
    observed: 'no Content-Signal directive in robots.txt and none on the response',
    fix: 'Optional, and new. Content Signals let you say how the page may be used.',
    evidence: [],
  },
  {
    id: 'agents-md',
    title: 'agents.md exists and is markdown',
    category: 'discovery',
    severity: 'medium',
    status: 'fail',
    observed: '404 at /agents.md',
    fix: 'Publish /agents.md: a short brief telling an agent what the site is and where things are.',
    evidence: [{ url: 'https://example.com/agents.md', status: 404 }],
  },
  {
    id: 'a2a-agent-card',
    title: 'An A2A agent card',
    category: 'discovery',
    severity: 'low',
    status: 'not-applicable',
    observed: 'robots.txt disallows this auditor at /.well-known/',
    evidence: [{ url: 'https://example.com/.well-known/agent.json', note: 'disallowed to steward-audit' }],
  },
  {
    id: 'markdown-negotiation-home',
    title: 'The homepage serves markdown to a client that asks for it',
    category: 'content-access',
    severity: 'high',
    status: 'fail',
    observed: 'Accept: text/markdown returned the same HTML document',
    fix: 'Serve a markdown variant, and send `Vary: Accept` so a cache does not hand one to the other.',
    evidence: [
      {
        url: 'https://example.com/',
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', vary: 'Accept-Encoding' },
        note: 'requested with Accept: text/markdown',
        excerpt: '<!doctype html><html lang="en"><head><title>Example</title>…',
      },
    ],
  },
  {
    id: 'lighthouse-accessibility',
    title: 'Lighthouse accessibility clears 90 on the sampled pages',
    category: 'rendered-experience',
    severity: 'high',
    status: 'fail',
    observed: 'accessibility scored 71 on /about/, below 90 (3 page(s) rendered: / 94, /about/ 71, /blog/ 88)',
    fix: 'An agent reads the page through the accessibility tree, so this score is not only about assistive technology.',
    metric: { label: 'Accessibility', value: 71, unit: 'score', pages: 3 },
    evidence: [
      { url: 'https://example.com/', note: 'Lighthouse 13.4.1: accessibility 94' },
      { url: 'https://example.com/about/', note: 'Lighthouse 13.4.1: accessibility 71' },
    ],
  },
  {
    id: 'lighthouse-performance',
    title: 'Lighthouse performance clears 90 on the sampled pages',
    category: 'rendered-experience',
    severity: 'medium',
    status: 'pass',
    observed: 'performance 96 or better on all 3 rendered page(s)',
    metric: { label: 'Performance', value: 96, unit: 'score', pages: 3 },
    evidence: [{ url: 'https://example.com/', note: 'Lighthouse 13.4.1: performance 96' }],
  },
  {
    id: 'lighthouse-seo',
    title: 'Lighthouse SEO clears 90 on the sampled pages',
    category: 'rendered-experience',
    severity: 'medium',
    status: 'error',
    observed: 'not measured — the browser did not produce a result: connect ECONNREFUSED 127.0.0.1:9222',
    evidence: [{ note: 'connect ECONNREFUSED 127.0.0.1:9222' }],
  },
  // An error that still carries a number, which puts the third tile state on the
  // page. `deep.ts` does not emit this combination — a tier that reached no
  // verdict attaches no metric — but the renderer styles `status-error` on a
  // tile, and a state nothing renders is a state nothing scans. The schema
  // allows it, so a newer check may yet produce it.
  {
    id: 'lighthouse-best-practices',
    title: 'Lighthouse best-practices clears 90 on the sampled pages',
    category: 'rendered-experience',
    severity: 'low',
    status: 'error',
    observed: 'one page scored 88 and the other two ran out of their slice of the time budget',
    metric: { label: 'Best practices', value: 88, unit: 'score', pages: 1 },
    evidence: [
      { url: 'https://example.com/', note: 'Lighthouse 13.4.1: best-practices 88' },
      { url: 'https://example.com/about/', note: 'ran out of its slice of the time budget' },
    ],
  },
  {
    id: 'axe-violations',
    title: 'axe-core finds no accessibility violations on the sampled pages',
    category: 'rendered-experience',
    severity: 'high',
    status: 'fail',
    observed: 'axe-core 4.12.1 found 5 violation(s) on 2 of 3 rendered page(s)',
    fix: 'Each violation names the rule and the elements that broke it.',
    metric: { label: 'axe violations', value: 5, unit: 'count', pages: 3 },
    evidence: [
      { url: 'https://example.com/', note: 'axe-core 4.12.1: 3 violation(s) — color-contrast (serious) × 2, image-alt (critical) × 1' },
    ],
  },
  // Out of the enums the renderer knows, which is a shape the schema allows and
  // a newer auditor could write.
  {
    id: 'future-check',
    title: 'A check from a newer version of the tool',
    category: 'crawlability',
    severity: 'critical' as CheckResult['severity'],
    status: 'inconclusive' as CheckResult['status'],
    observed: 'a status this renderer has never heard of',
    evidence: [],
  },
];

const FIXTURE: AuditResult = {
  schemaVersion: 2,
  // The real constants, so the fixture report is scanned with the header a real one carries.
  tool: { name: TOOL_NAME, version: TOOL_VERSION, userAgent: AUDIT_USER_AGENT },
  target: { input: 'example.com', origin: 'https://example.com' },
  startedAt: '2026-08-11T19:00:00.000Z',
  finishedAt: '2026-08-11T19:00:30.000Z',
  durationMs: 30000,
  requests: 14,
  browserPages: 3,
  categories: countByCategory(CHECKS),
  checks: CHECKS,
  notes: ['Deep tier: 323 page(s) were available to sample and the first 3 were rendered (the cap).'],
};

async function main(): Promise<void> {
  const given = process.argv[2];
  const dir = given ? null : await mkdtemp(path.join(os.tmpdir(), 'steward-report-a11y-'));
  const file = given ?? path.join(dir as string, 'report.html');
  if (!given) await writeFile(file, `${renderHtmlReport(FIXTURE)}\n`, 'utf8');

  try {
    console.log(`  scanning ${file}`);
    const { raw } = await runAxe(pathToFileURL(file).href, AbortSignal.timeout(180_000));
    for (const v of raw) {
      console.log(`  ✖ ${v.id} (${v.impact ?? 'no impact'}) × ${(v.nodes ?? []).length}`);
    }
    if (raw.length > 0) {
      console.error(`\n  axe found ${raw.length} violation(s) in the report.\n`);
      process.exitCode = 1;
      return;
    }
    console.log('\n  axe found no violations in the report.\n');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
