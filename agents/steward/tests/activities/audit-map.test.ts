import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  axeFindings,
  lighthouseFindings,
  lighthouseMetrics,
  agenticChecks,
  isExpectedDraftNonFinding,
  isExpectedDraftSeoPenalty,
  overallVerdict,
  type AxeViolation,
} from '../../src/lib/audit-map.js';

/**
 * Audit-result mapping, against canned axe/Lighthouse JSON.
 *
 * The activity's end-to-end behaviour is verified live (it needs a build, a
 * server, and a browser). What is unit-tested here is the branching that decides
 * *what becomes a finding and at what severity* — the part where a mistake would
 * silently produce a clean report for a broken page.
 */

const FILE = 'src/content/writing/example.md';
const URL = 'http://127.0.0.1:1234/writing/example/';

const colourContrast: AxeViolation = {
  id: 'color-contrast',
  impact: 'serious',
  help: 'Elements must have sufficient colour contrast',
  helpUrl: 'https://dequeuniversity.com/rules/axe/color-contrast',
  nodes: [
    { html: '<p class="dek">A dek</p>', target: ['.dek'], failureSummary: 'contrast 3.1:1' },
    { html: '<span>more</span>', target: ['span'] },
  ],
};

test('an axe violation blocks — the site holds a 0-violation record', () => {
  const findings = axeFindings([colourContrast], FILE, URL);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'block');
  assert.equal(findings[0].pass, 'build_audit');
  assert.match(findings[0].message, /colour contrast/i);
  assert.match(findings[0].message, /2 elements/);
  assert.match(findings[0].evidence!, /rule: color-contrast/);
  assert.match(findings[0].evidence!, /contrast 3\.1:1/);
});

test('impact level does not soften the verdict', () => {
  const minor = axeFindings([{ ...colourContrast, impact: 'minor' }], FILE, URL);
  assert.equal(minor[0].severity, 'block');
});

test('a clean axe run produces no findings', () => {
  assert.deepEqual(axeFindings([], FILE, URL), []);
});

// --- the expected draft non-finding ----------------------------------------

test('the missing OG image on a draft is filtered, not reported', () => {
  // Drafts are deliberately excluded from OG generation, so the page points at a
  // PNG that does not exist yet. Reporting it would fail every draft audit on a
  // known non-issue and train the human to ignore the block.
  const ogOnly: AxeViolation = {
    id: 'image-alt',
    nodes: [{ html: '<img src="/og/writing/my-draft.png">', target: ['img'] }],
  };
  assert.equal(isExpectedDraftNonFinding(ogOnly), true);
  assert.deepEqual(axeFindings([ogOnly], FILE, URL), []);
});

test('a real missing-alt violation is NOT filtered', () => {
  const real: AxeViolation = {
    id: 'image-alt',
    nodes: [{ html: '<img src="../../assets/lighthouse.png">', target: ['img'] }],
  };
  assert.equal(isExpectedDraftNonFinding(real), false);
  assert.equal(axeFindings([real], FILE, URL).length, 1);
});

test('a violation mixing the OG image with a real one still reports', () => {
  // The filter must be all-or-nothing per violation: dropping the whole rule
  // because one of its nodes is the OG image would hide a genuine defect.
  const mixed: AxeViolation = {
    id: 'image-alt',
    nodes: [
      { html: '<img src="/og/writing/my-draft.png">', target: ['img'] },
      { html: '<img src="/real-screenshot.png">', target: ['img.real'] },
    ],
  };
  assert.equal(isExpectedDraftNonFinding(mixed), false);
  assert.equal(axeFindings([mixed], FILE, URL).length, 1);
});

// --- Lighthouse ------------------------------------------------------------

const lhr = {
  categories: {
    performance: { score: 0.87 },
    accessibility: { score: 1 },
    'best-practices': { score: 1 },
    seo: { score: 0.91 },
  },
  audits: {
    'agentic-cls': { score: 1 },
    'agentic-content-visibility': { score: 1 },
    'agentic-structured-data': { score: 0 },
    'agentic-semantic-html': { score: 1 },
  },
};

/**
 * Shaped after a real live capture (2026-07-22, `lhr.categories['agentic-browsing']`
 * against production) — see scorecard-build-log.md's Phase 1.5 entry. Includes
 * both weight:1 real checks and the two weight:0 informative/notApplicable
 * audits Lighthouse also returns, so the weight filter is exercised.
 */
const agenticLhr = {
  categories: {
    'agentic-browsing': {
      score: 1,
      auditRefs: [
        { id: 'agent-accessibility-tree', weight: 1 },
        { id: 'webmcp-form-coverage', weight: 0 },
        { id: 'webmcp-registered-tools', weight: 0 },
        { id: 'webmcp-schema-validity', weight: 1 },
        { id: 'cumulative-layout-shift', weight: 1 },
        { id: 'llms-txt', weight: 1 },
      ],
    },
  },
  audits: {
    'agent-accessibility-tree': { title: 'Accessibility tree is well-formed', score: 1, scoreDisplayMode: 'binary' },
    'webmcp-form-coverage': { title: 'WebMCP form coverage', score: null, scoreDisplayMode: 'notApplicable' },
    'webmcp-registered-tools': { title: 'WebMCP tools registered', score: 1, scoreDisplayMode: 'informative' },
    'webmcp-schema-validity': { title: 'WebMCP schemas are valid', score: 1, scoreDisplayMode: 'binary' },
    'cumulative-layout-shift': { title: 'Cumulative Layout Shift', score: 1, scoreDisplayMode: 'numeric' },
    'llms-txt': { title: 'llms.txt follows recommendations', score: 0, scoreDisplayMode: 'binary' },
  },
};

test('category scores are recorded as integers out of 100', () => {
  const m = lighthouseMetrics(lhr, URL);
  assert.deepEqual(m.scores, {
    performance: 87,
    accessibility: 100,
    'best-practices': 100,
    seo: 91,
  });
  assert.equal(m.url, URL);
});

// --- Agentic Browsing checks -------------------------------------------------

test('agenticChecks returns only the weight>0 checks, dropping the weight:0 informative/notApplicable audits', () => {
  const checks = agenticChecks(agenticLhr);
  assert.deepEqual(
    checks.map((c) => c.id).sort(),
    ['agent-accessibility-tree', 'cumulative-layout-shift', 'llms-txt', 'webmcp-schema-validity'],
  );
});

test('score === 1 means pass; a real live run shows 3 of 4 passing here (llms-txt scored 0)', () => {
  const checks = agenticChecks(agenticLhr);
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId['agent-accessibility-tree'].passed, true);
  assert.equal(byId['webmcp-schema-validity'].passed, true);
  assert.equal(byId['cumulative-layout-shift'].passed, true);
  assert.equal(byId['llms-txt'].passed, false);
  for (const c of checks) assert.equal(c.applicable, true, `${c.id} expected applicable`);
});

test('a null score (scoreDisplayMode notApplicable) is applicable: false, not a silent pass or fail', () => {
  const notApplicable = {
    ...agenticLhr,
    audits: { ...agenticLhr.audits, 'webmcp-schema-validity': { title: 'WebMCP schemas are valid', score: null, scoreDisplayMode: 'notApplicable' } },
  };
  const checks = agenticChecks(notApplicable);
  const webmcp = checks.find((c) => c.id === 'webmcp-schema-validity')!;
  assert.equal(webmcp.applicable, false);
  assert.equal(webmcp.passed, false);
});

test('agenticChecks is empty when Lighthouse returned no agentic-browsing category', () => {
  assert.deepEqual(agenticChecks({ categories: {}, audits: {} }), []);
});

test('below-floor scores flag and never block — lab variance is real', () => {
  const findings = lighthouseFindings(lighthouseMetrics(lhr, URL).scores, FILE, URL);
  // performance 87 < 90, seo 91 < 100. accessibility/best-practices are at 100.
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.severity === 'flag'));
  assert.deepEqual(
    findings.map((f) => f.id).sort(),
    ['build_audit.lighthouse.performance', 'build_audit.lighthouse.seo'],
  );
});

test('performance at exactly its floor of 90 does not flag', () => {
  const findings = lighthouseFindings({ performance: 90 }, FILE, URL);
  assert.deepEqual(findings, []);
});

test('a missing category score is not treated as a zero', () => {
  // An absent category means Lighthouse skipped it, not that the page scored 0.
  assert.deepEqual(lighthouseFindings({}, FILE, URL), []);
});

// --- the expected draft SEO penalty ----------------------------------------

test('a noindex draft does not get flagged for its SEO score', () => {
  // Drafts render `<meta name="robots" content="noindex">` on purpose, and
  // Lighthouse scores "blocked from indexing" as a near-total SEO failure. This
  // fires on every draft, always, for a reason the site intends.
  const noindex = { ...lhr, audits: { ...lhr.audits, 'is-crawlable': { score: 0 } } };
  assert.equal(isExpectedDraftSeoPenalty(noindex), true);

  const findings = lighthouseFindings(lighthouseMetrics(noindex, URL).scores, FILE, URL, {
    suppressSeo: isExpectedDraftSeoPenalty(noindex),
  });
  assert.equal(
    findings.find((f) => f.id.endsWith('.seo')),
    undefined,
  );
  // Suppressing SEO must not suppress anything else.
  assert.ok(findings.some((f) => f.id.endsWith('.performance')));
});

test('a low SEO score with a crawlable page IS still flagged', () => {
  // The suppression is specifically about noindex — a genuine SEO regression on
  // a crawlable page must survive it.
  const crawlable = { ...lhr, audits: { ...lhr.audits, 'is-crawlable': { score: 1 } } };
  assert.equal(isExpectedDraftSeoPenalty(crawlable), false);
  const findings = lighthouseFindings(lighthouseMetrics(crawlable, URL).scores, FILE, URL, {
    suppressSeo: isExpectedDraftSeoPenalty(crawlable),
  });
  assert.ok(findings.some((f) => f.id.endsWith('.seo')));
});

test('failing audit ids are recorded, so a score is diagnosable later', () => {
  const m = lighthouseMetrics(lhr, URL);
  assert.deepEqual(m.failedAudits, ['agentic-structured-data']);
});

test('agentic-browsing has a floor of 100 like the other non-performance categories', () => {
  const findings = lighthouseFindings({ 'agentic-browsing': 75 }, FILE, URL);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'flag');
});

// --- overall verdict -------------------------------------------------------

test('overall verdict: axe block outranks a Lighthouse flag', () => {
  const findings = [
    ...axeFindings([colourContrast], FILE, URL),
    ...lighthouseFindings({ performance: 40 }, FILE, URL),
  ];
  assert.equal(overallVerdict(findings), 'block');
});

test('overall verdict: flags alone flag, nothing passes', () => {
  assert.equal(overallVerdict(lighthouseFindings({ performance: 40 }, FILE, URL)), 'flag');
  assert.equal(overallVerdict([]), 'pass');
});
