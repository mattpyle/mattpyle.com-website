import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
process.env.STEWARD_SITE_DIR = fixtures;

const { synthesizeReport } = await import('../../src/activities/synthesize.js');
const { ReviewReport, toolFailurePass } = await import('../../src/lib/report.js');
import type { DraftSnapshot, PassResult } from '../../src/lib/report.js';

const snapshot: DraftSnapshot = {
  slug: 'x',
  file: 'posts/known-good.md',
  contentSha256: 'a'.repeat(64),
  frontmatter: { draft: true },
  body: '## hi',
};

function pass(overrides: Partial<PassResult>): PassResult {
  return {
    pass: 'cspell',
    verdict: 'pass',
    findings: [],
    patches: [],
    startedAt: new Date().toISOString(),
    durationMs: 1,
    ...overrides,
  };
}

const base = { snapshot, workflowId: 'wf', runId: 'run' };

test('the report validates against its own schema', async () => {
  const report = await synthesizeReport({ ...base, passes: [pass({})] });
  assert.doesNotThrow(() => ReviewReport.parse(report));
  assert.equal(report.contentSha256, snapshot.contentSha256);
  assert.equal(report.workflowId, 'wf');
});

test('overall verdict is the worst pass verdict', async () => {
  const all = await synthesizeReport({
    ...base,
    passes: [
      pass({ pass: 'cspell', verdict: 'block' }),
      pass({ pass: 'frontmatter', verdict: 'flag' }),
    ],
  });
  assert.equal(all.overall, 'block');

  const flagged = await synthesizeReport({
    ...base,
    passes: [pass({ pass: 'frontmatter', verdict: 'flag' }), pass({ pass: 'cspell', verdict: 'pass' })],
  });
  assert.equal(flagged.overall, 'flag');

  const clean = await synthesizeReport({ ...base, passes: [pass({})] });
  assert.equal(clean.overall, 'pass');
});

test('editorial passes cannot emit block — severities are clamped (design rule 1)', async () => {
  const report = await synthesizeReport({
    ...base,
    passes: [
      pass({
        pass: 'claims_structure',
        verdict: 'block',
        findings: [
          { id: 'claims-1', pass: 'claims_structure', severity: 'block', message: 'overclaim' },
        ],
      }),
    ],
  });
  assert.equal(report.passes[0].findings[0].severity, 'flag');
  assert.equal(report.passes[0].verdict, 'flag');
  assert.equal(report.overall, 'flag', 'an LLM must never be able to block publish');
});

test('mechanical passes keep their block severity', async () => {
  const report = await synthesizeReport({
    ...base,
    passes: [
      pass({
        pass: 'cspell',
        verdict: 'block',
        findings: [{ id: 'cspell-1', pass: 'cspell', severity: 'block', message: 'typo' }],
      }),
    ],
  });
  assert.equal(report.passes[0].findings[0].severity, 'block');
  assert.equal(report.overall, 'block');
});

test('patches are re-keyed uniquely across passes', async () => {
  const report = await synthesizeReport({
    ...base,
    passes: [
      pass({
        pass: 'cspell',
        patches: [
          { id: 'patch-1', findingId: 'cspell-1', file: 'f', oldText: 'a', newText: 'b', rationale: 'r', source: 'mechanical' },
        ],
      }),
      pass({
        pass: 'frontmatter',
        patches: [
          { id: 'patch-1', findingId: 'frontmatter-1', file: 'f', oldText: 'c', newText: 'd', rationale: 'r', source: 'mechanical' },
        ],
      }),
    ],
  });
  assert.deepEqual(report.patches.map((p) => p.id), ['patch-1', 'patch-2']);
});

test('findings are ordered blocks-first, then by file and line', async () => {
  const report = await synthesizeReport({
    ...base,
    passes: [
      pass({
        verdict: 'block',
        findings: [
          { id: 'a', pass: 'cspell', severity: 'flag', message: 'f', file: 'z.md', line: 1 },
          { id: 'b', pass: 'cspell', severity: 'block', message: 'b', file: 'z.md', line: 9 },
          { id: 'c', pass: 'cspell', severity: 'block', message: 'b', file: 'z.md', line: 2 },
        ],
      }),
    ],
  });
  assert.deepEqual(report.passes[0].findings.map((f) => f.id), ['c', 'b', 'a']);
});

test('the template summary leads with the verdict', async () => {
  const blocked = await synthesizeReport({
    ...base,
    passes: [
      pass({
        verdict: 'block',
        findings: [{ id: 'x', pass: 'cspell', severity: 'block', message: 'typo' }],
      }),
    ],
  });
  assert.match(blocked.summary, /^BLOCK — 1 blocking finding/);

  const clean = await synthesizeReport({ ...base, passes: [pass({})] });
  assert.match(clean.summary, /^PASS/);
});

test('a failed tool becomes a flag, never a silent pass', () => {
  const failed = toolFailurePass('cspell', 'binary missing', '2026-07-18T00:00:00.000Z');
  assert.equal(failed.verdict, 'flag');
  assert.equal(failed.findings.length, 1);
  assert.match(failed.findings[0].message, /not a clean bill of health/);
  assert.equal(failed.startedAt, '2026-07-18T00:00:00.000Z');
});

test('the summary pluralizes "patch" correctly', async () => {
  const patch = (id: string) => ({
    id,
    findingId: 'cspell-1',
    file: 'f',
    oldText: id,
    newText: 'x',
    rationale: 'r',
    source: 'mechanical' as const,
  });

  const many = await synthesizeReport({
    ...base,
    passes: [pass({ patches: [patch('a'), patch('b'), patch('c')] })],
  });
  assert.match(many.summary, /3 patches proposed/);
  assert.doesNotMatch(many.summary, /patchs/);

  const one = await synthesizeReport({ ...base, passes: [pass({ patches: [patch('a')] })] });
  assert.match(one.summary, /1 patch proposed/);
});
