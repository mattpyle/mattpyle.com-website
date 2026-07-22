import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../../src/lib/render-report.js';
import type { ReviewReport } from '../../src/lib/report.js';

/** Strips ANSI colour codes so assertions can match on plain text. */
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9]+m/g, '');
}

function baseReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    schemaVersion: 1,
    slug: 'hello-world',
    collection: 'writing',
    mode: 'gate',
    file: 'src/content/writing/hello-world.md',
    contentSha256: 'abc123',
    reviewedAt: '2026-07-20T12:00:00.000Z',
    workflowId: 'steward-review-hello-world',
    runId: 'run-1',
    passes: [],
    patches: [],
    overall: 'pass',
    summary: 'All checks passed.',
    human: {},
    publish: {},
    ...overrides,
  };
}

test('header shows slug, collection, overall verdict, and the summary', () => {
  const out = plain(renderReport(baseReport({ overall: 'flag', summary: 'One flag, no blocks.' })));
  assert.match(out, /hello-world/);
  assert.match(out, /writing/);
  assert.match(out, /overall: FLAG/);
  assert.match(out, /One flag, no blocks\./);
});

test('claims_structure gets its own labelled section even when it did not run', () => {
  const out = plain(renderReport(baseReport()));
  assert.match(out, /EDITORIAL QUALITY — claims_structure/);
  assert.match(out, /Pass did not run\./);
});

test('claims_structure section renders its findings and leads OTHER CHECKS regardless of verdict rank', () => {
  const report = baseReport({
    overall: 'block',
    passes: [
      {
        pass: 'cspell',
        verdict: 'block',
        findings: [
          { id: 'cspell-1', pass: 'cspell', severity: 'block', message: 'unknown word "recieve"', file: 'x.md', line: 3 },
        ],
        startedAt: '2026-07-20T12:00:00.000Z',
        durationMs: 10,
      },
      {
        pass: 'claims_structure',
        verdict: 'flag',
        findings: [
          {
            id: 'claims-1',
            pass: 'claims_structure',
            severity: 'flag',
            message: 'buried lede: the real result is in paragraph four',
            file: 'x.md',
            line: 5,
            excerpt: 'Some context first...',
            evidence: 'The answer should lead.',
          },
        ],
        startedAt: '2026-07-20T12:00:00.000Z',
        durationMs: 20,
      },
    ],
  });

  const out = plain(renderReport(report));
  const claimsIdx = out.indexOf('EDITORIAL QUALITY');
  const otherIdx = out.indexOf('OTHER CHECKS');
  assert.ok(claimsIdx !== -1 && otherIdx !== -1);
  assert.ok(claimsIdx < otherIdx, 'claims_structure section must precede OTHER CHECKS');
  assert.match(out, /buried lede: the real result is in paragraph four/);
  assert.match(out, /"Some context first\.\.\."/);
  assert.match(out, /why: The answer should lead\./);
});

test('a finding with a proposed patch shows the patch id inline', () => {
  const report = baseReport({
    passes: [
      {
        pass: 'cspell',
        verdict: 'flag',
        findings: [{ id: 'cspell-1', pass: 'cspell', severity: 'flag', message: 'typo: "teh"' }],
        startedAt: '2026-07-20T12:00:00.000Z',
        durationMs: 5,
      },
    ],
    patches: [
      {
        id: 'patch-1',
        findingId: 'cspell-1',
        file: 'x.md',
        oldText: 'teh',
        newText: 'the',
        rationale: 'unambiguous suggestion',
        source: 'mechanical',
      },
    ],
  });

  const out = plain(renderReport(report));
  assert.match(out, /typo: "teh"\s+\(patch-1\)/);
  assert.match(out, /patch-1\s+"teh" -> "the"/);
});

test('no patches renders "None."', () => {
  const out = plain(renderReport(baseReport()));
  assert.match(out, /PROPOSED PATCHES \(0\)/);
  assert.match(out, /None\./);
});

test('build audit renders axe violations and Lighthouse scores against their floors', () => {
  const report = baseReport({
    passes: [
      {
        pass: 'build_audit',
        verdict: 'flag',
        findings: [],
        startedAt: '2026-07-20T12:00:00.000Z',
        durationMs: 5000,
        metrics: {
          scores: { performance: 85, accessibility: 100, 'best-practices': 100, seo: 100, 'agentic-browsing': 100 },
          axeViolations: 0,
          axeFiltered: 1,
        },
      },
    ],
  });

  const out = plain(renderReport(report));
  assert.match(out, /axe: 0 violations/);
  assert.match(out, /performance: 85\s+\(floor 90\)/);
  assert.match(out, /accessibility: 100\s+\(floor 100\)/);
});

test('build audit section says Skipped when the pass did not run', () => {
  const out = plain(renderReport(baseReport()));
  assert.match(out, /BUILD AUDIT/);
  assert.match(out, /Skipped/);
});

test('next hint: block points at rereview or approve --force', () => {
  const out = plain(renderReport(baseReport({ overall: 'block' })));
  assert.match(out, /next: block — fix the blocking findings, then `steward rereview hello-world`/);
  assert.match(out, /--force/);
});

test('next hint: flag and pass point at approve', () => {
  const flag = plain(renderReport(baseReport({ overall: 'flag' })));
  assert.match(flag, /next: flag — `steward approve hello-world` when ready\./);

  const pass = plain(renderReport(baseReport({ overall: 'pass' })));
  assert.match(pass, /next: pass — `steward approve hello-world` when ready\./);
});

test('next hint: audit mode is always advisory, regardless of overall verdict', () => {
  const out = plain(renderReport(baseReport({ mode: 'audit', overall: 'block' })));
  assert.match(out, /next: audited — advisory only/);
});

test('next hint: an already-decided review says so instead of proposing a next action', () => {
  const out = plain(
    renderReport(
      baseReport({
        overall: 'flag',
        human: { decision: 'approved', decidedAt: '2026-07-21T09:00:00.000Z' },
      }),
    ),
  );
  assert.match(out, /next: approved on 2026-07-21 09:00:00 UTC — nothing further to do here\./);
});
