import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
process.env.STEWARD_SITE_DIR = fixtures;

const {
  ClaimsStructureResponse,
  clampSeverity,
  judgePatchSize,
  mapClaimsResponse,
  editorialPass,
  clampScore,
  TELL_CATEGORIES,
  FORMAT_DRIVEN_TELLS,
  VOICE_DRIVEN_TELLS,
  UNCLASSIFIED_TELLS,
} = await import('../../src/activities/editorial.js');
const { callRubric, stripFences, withLineNumbers, loadRubric } = await import('../../src/lib/llm.js');

// ---------------------------------------------------------------------------
// Clamp 1 — editorial findings never reach `block` (design rule 1).
// ---------------------------------------------------------------------------

test('clamp 1: block is clamped to flag; pass and flag are untouched', () => {
  assert.equal(clampSeverity('block'), 'flag');
  assert.equal(clampSeverity('flag'), 'flag');
  assert.equal(clampSeverity('pass'), 'pass');
});

test('clamp 1: no mapped editorial finding can carry block, whatever the model returns', () => {
  const response = ClaimsStructureResponse.parse({
    findings: [
      {
        category: 'overclaiming',
        line: 12,
        excerpt: 'this proves agents prefer markdown',
        message: 'States a proven result the post does not support.',
        evidence: 'No measurement is presented anywhere in the post.',
      },
      {
        category: 'contradiction',
        line: 40,
        excerpt: 'nobody reads llms.txt',
        message: 'Conflicts with the earlier claim.',
        evidence: 'Line 8 says the opposite.',
      },
    ],
    patches: [],
  });

  const { findings } = mapClaimsResponse(response, 'x.md');
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.severity === 'flag'));
  assert.ok(findings.every((f) => f.pass === 'claims_structure'));
});

// ---------------------------------------------------------------------------
// Clamp 2 — the patch-size demotion rule (the hard line against rewrites).
// ---------------------------------------------------------------------------

test('clamp 2: a true mechanical fix is accepted', () => {
  // A typo correction: same token count, 1 character different.
  const v = judgePatchSize('accessibiltiy', 'accessibility');
  assert.equal(v.accepted, true);
  assert.equal(v.tokenDelta, 0);
});

test('clamp 2: rejected when token delta exceeds 3', () => {
  const v = judgePatchSize('a b', 'a b c d e f g');
  assert.equal(v.accepted, false);
  assert.equal(v.tokenDelta, 5);
  assert.match(v.reason!, /5 tokens \(limit 3\)/);
});

test('clamp 2: rejected when length delta exceeds 20 even with a small token delta', () => {
  // One token replaced by one token — but a 40-character swing. Token count
  // alone would wave this through, which is exactly why both limits exist.
  const v = judgePatchSize('short', 'a'.repeat(60));
  assert.equal(v.accepted, false);
  assert.equal(v.tokenDelta, 0);
  assert.match(v.reason!, /characters \(limit 20\)/);
});

test('clamp 2: deltas are absolute — a large deletion is a rewrite too', () => {
  const v = judgePatchSize('a'.repeat(60), 'short');
  assert.equal(v.accepted, false);
  assert.match(v.reason!, /characters \(limit 20\)/);
});

test('clamp 2: an oversized patch is demoted to a finding, not silently dropped', () => {
  const response = ClaimsStructureResponse.parse({
    findings: [],
    patches: [
      {
        line: 7,
        oldText: 'The agentic web is coming.',
        newText:
          'The agentic web is arriving in stages, and the shape of that arrival is still contested among the people building it.',
        rationale: 'Softens the claim',
      },
    ],
  });

  const { findings, patches } = mapClaimsResponse(response, 'x.md');

  // No patch — this is a prose rewrite wearing a patch's clothing.
  assert.equal(patches.length, 0);
  // But the suggestion survives for the human to judge.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'flag');
  assert.match(findings[0].message, /too large to apply automatically/);
  assert.match(findings[0].evidence!, /arriving in stages/);
});

test('a no-op patch (oldText === newText) is dropped, not offered to the human', () => {
  // Regression test for real observed behaviour: with the planted typo already
  // fixed, the live model returned a patch whose oldText and newText were
  // identical, rationalised as "no mechanical typo was found". Both size deltas
  // are zero, so the size clamp waves it through — this guard is what stops it.
  const response = ClaimsStructureResponse.parse({
    findings: [],
    patches: [
      {
        line: 4,
        oldText: 'the text is unchanged',
        newText: 'the text is unchanged',
        rationale: 'No mechanical typo was found.',
      },
    ],
  });

  const { findings, patches } = mapClaimsResponse(response, 'x.md');
  assert.deepEqual(patches, [], 'a patch that changes nothing must not be proposed');
  assert.deepEqual(findings, [], 'and it must not become a finding either');
});

// ---------------------------------------------------------------------------
// Clamp 3 — no patch may rewrite text the model flagged as editorial judgment.
// ---------------------------------------------------------------------------

test('clamp 3: a patch rewriting a flagged overclaim is refused despite passing the size clamp', () => {
  // Verbatim from the live Phase 1b run. The size clamp waves this through:
  // token delta is exactly 3 and character delta is 12. It is nonetheless a
  // semantic reversal of the post's central claim.
  const oldText = 'this proves agents prefer markdown over HTML';
  const newText = 'this does not yet prove agents prefer markdown over HTML';

  // Precondition: confirm the size clamp really does accept it, so this test
  // fails loudly if someone "fixes" it by tightening the size limits instead.
  assert.equal(judgePatchSize(oldText, newText).accepted, true);

  const response = ClaimsStructureResponse.parse({
    findings: [
      {
        category: 'overclaiming',
        line: 10,
        excerpt: oldText,
        message: 'Claims proof the post never provides.',
        evidence: 'The measurement section says nothing was measured.',
      },
    ],
    patches: [{ line: 10, oldText, newText, rationale: 'Removes the contradiction.' }],
  });

  const { findings, patches } = mapClaimsResponse(response, 'x.md');

  assert.deepEqual(patches, [], 'the overclaim must be flagged with NO patch');
  const refusal = findings.find((f) => f.id.startsWith('claims-judgment-patch'));
  assert.ok(refusal, 'the refusal is surfaced rather than silently dropped');
  assert.match(refusal!.message, /editorial judgment, not a mechanical defect/);
  assert.match(refusal!.evidence!, /does not yet prove/, 'the suggestion survives for the human');
});

test('clamp 3: refuses on text overlap even when the cited line number differs', () => {
  const response = ClaimsStructureResponse.parse({
    findings: [
      {
        category: 'contradiction',
        line: 10,
        excerpt: 'the rollout was a complete success',
        message: 'Contradicts the failure described later.',
        evidence: 'Line 30 says it was rolled back.',
      },
    ],
    // Same text, different line number — a model citing a block, not a line.
    patches: [
      {
        line: 11,
        oldText: 'a complete success',
        newText: 'a partial success',
        rationale: 'softens',
      },
    ],
  });

  assert.deepEqual(mapClaimsResponse(response, 'x.md').patches, []);
});

test('clamp 3: a genuine typo fix on an unflagged line is still allowed through', () => {
  // The clamp must not become "no editorial patches ever" — mechanical fixes
  // away from judgment findings are the whole point of the patch channel.
  const response = ClaimsStructureResponse.parse({
    findings: [
      {
        category: 'overclaiming',
        line: 10,
        excerpt: 'this proves everything',
        message: 'Overclaims.',
        evidence: 'No data.',
      },
    ],
    patches: [{ line: 42, oldText: 'accessibiltiy', newText: 'accessibility', rationale: 'typo' }],
  });

  const { patches } = mapClaimsResponse(response, 'x.md');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].newText, 'accessibility');
});

test('clamp 2: an accepted patch produces both a finding and a linked patch', () => {
  const response = ClaimsStructureResponse.parse({
    findings: [],
    patches: [
      { line: 3, oldText: 'damanging', newText: 'damaging', rationale: 'typo' },
    ],
  });

  const { findings, patches } = mapClaimsResponse(response, 'src/content/writing/x.md');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].source, 'editorial');
  assert.equal(patches[0].oldText, 'damanging');
  assert.equal(patches[0].newText, 'damaging');
  // The patch must point at a finding that actually exists in the report.
  assert.ok(findings.some((f) => f.id === patches[0].findingId));
});

// ---------------------------------------------------------------------------
// JSON validation + the single in-activity retry (spec §8.6 step 3).
// ---------------------------------------------------------------------------

const VALID = JSON.stringify({ findings: [], patches: [] });

test('accepts a valid response on the first attempt', async () => {
  const rubric = await loadRubric('claims-structure');
  let calls = 0;
  const result = await callRubric({
    rubric,
    userContent: 'x',
    schema: ClaimsStructureResponse,
    send: async () => {
      calls += 1;
      return VALID;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
});

test('retries once with the validation error appended, then succeeds', async () => {
  const rubric = await loadRubric('claims-structure');
  const sent: string[] = [];
  let calls = 0;

  const result = await callRubric({
    rubric,
    userContent: 'x',
    schema: ClaimsStructureResponse,
    send: async (messages) => {
      calls += 1;
      sent.push(String(messages[messages.length - 1].content));
      // First reply is schema-invalid: `findings` is the wrong type.
      return calls === 1 ? JSON.stringify({ findings: 'nope' }) : VALID;
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  // The retry turn must name the actual validation failure — that is the whole
  // reason a second attempt does better than a blind re-ask.
  assert.match(sent[1], /failed validation/);
  assert.match(sent[1], /findings/);
});

test('throws after two invalid responses rather than fuzzily parsing (design rule 5)', async () => {
  const rubric = await loadRubric('claims-structure');
  let calls = 0;
  await assert.rejects(
    callRubric({
      rubric,
      userContent: 'x',
      schema: ClaimsStructureResponse,
      send: async () => {
        calls += 1;
        return '{"findings": "still wrong"}';
      },
    }),
    /invalid response twice/,
  );
  assert.equal(calls, 2);
});

test('non-JSON responses take the same retry path', async () => {
  const rubric = await loadRubric('claims-structure');
  let calls = 0;
  const result = await callRubric({
    rubric,
    userContent: 'x',
    schema: ClaimsStructureResponse,
    send: async () => {
      calls += 1;
      return calls === 1 ? 'Sure! Here is the review:' : VALID;
    },
  });
  assert.equal(result.attempts, 2);
});

test('strips markdown fences the model adds despite instructions', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('  {"a":1}  '), '{"a":1}');
});

test('a fenced but otherwise valid response is accepted without a retry', async () => {
  const rubric = await loadRubric('claims-structure');
  let calls = 0;
  const result = await callRubric({
    rubric,
    userContent: 'x',
    schema: ClaimsStructureResponse,
    send: async () => {
      calls += 1;
      return '```json\n' + VALID + '\n```';
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
});

// ---------------------------------------------------------------------------
// Line numbering and rubric hashing.
// ---------------------------------------------------------------------------

test('line numbers are prepended and right-aligned so citations are verifiable', () => {
  const numbered = withLineNumbers('alpha\nbeta\ngamma');
  assert.deepEqual(numbered.split('\n'), ['1| alpha', '2| beta', '3| gamma']);
});

test('rubric load records a path and content hash (design rule 6)', async () => {
  const rubric = await loadRubric('claims-structure');
  assert.equal(rubric.path, 'agents/steward/src/rubrics/claims-structure.md');
  assert.match(rubric.sha256, /^[0-9a-f]{64}$/);
  assert.match(rubric.content, /OVERCLAIMING/);
});

test('an unknown rubric name fails clearly', async () => {
  await assert.rejects(loadRubric('no-such-rubric'), /No rubric named/);
});

// ---------------------------------------------------------------------------
// The activity end to end, still with no network.
// ---------------------------------------------------------------------------

test('editorialPass produces a PassResult with rubric provenance and no network', async () => {
  const result = await editorialPass('posts/known-good.md', 'claims-structure', {
    send: async () =>
      JSON.stringify({
        findings: [
          {
            category: 'overclaiming',
            line: 5,
            excerpt: 'this proves it',
            message: 'Overclaims.',
            evidence: 'No data shown.',
          },
        ],
        patches: [],
      }),
  });

  assert.equal(result.pass, 'claims_structure');
  assert.equal(result.verdict, 'flag'); // never block
  assert.equal(result.findings.length, 1);
  assert.equal(result.rubric?.path, 'agents/steward/src/rubrics/claims-structure.md');
  assert.match(result.rubric!.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.metrics?.validationAttempts, 1);
});

test('a clean post yields a pass verdict and no findings', async () => {
  const result = await editorialPass('posts/known-good.md', 'claims-structure', {
    send: async () => VALID,
  });
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.patches, []);
});

// ---------------------------------------------------------------------------
// The ai-tells pass (spec §8.6, §9.2).
//
// The predecessor of this block asserted that the rubric was *refused* until its
// phase landed. It has landed, so that test was replaced rather than deleted —
// what it guarded (nothing reaches this rubric by accident) is now guarded by
// the workflow input flag, and these tests guard the behaviour instead.
// ---------------------------------------------------------------------------

const AI_TELLS_VALID = JSON.stringify({
  aiLikenessScore: 62,
  findings: [
    {
      category: 'NOT_X_BUT_Y',
      line: 12,
      excerpt: "it's not about the tooling, it's about the taste",
      message: 'Contrast construction used as a rhetorical beat.',
      evidence: 'Classic AI cadence; the sentence carries no information the previous one lacked.',
    },
    {
      category: 'RULE_OF_THREE',
      line: 20,
      excerpt: 'faster, cleaner, and more honest',
      message: 'Triadic list used rhythmically.',
      evidence: 'The third item adds nothing; the triple exists for cadence.',
    },
    {
      category: 'NOT_X_BUT_Y',
      line: 31,
      excerpt: 'this is not a benchmark — it is a habit',
      message: 'Second contrast construction.',
      evidence: 'Same shape as line 12.',
    },
  ],
});

test('ai-tells reports the composite score and a per-category breakdown', async () => {
  const result = await editorialPass('posts/known-good.md', 'ai-tells', {
    send: async () => AI_TELLS_VALID,
  });

  assert.equal(result.pass, 'ai_tells');
  assert.equal(result.metrics?.aiLikenessScore, 62);
  assert.equal(result.findings.length, 3);

  // The breakdown is what lets the study separate format-driven tells from
  // voice-driven ones without retuning the rubric, so it is asserted directly.
  const counts = result.metrics?.tellCounts as Record<string, number>;
  assert.equal(counts.NOT_X_BUT_Y, 2);
  assert.equal(counts.RULE_OF_THREE, 1);

  // Every category is present even at zero. An absent key and a zero are very
  // different things to anything doing arithmetic across pieces.
  assert.equal(Object.keys(counts).length, TELL_CATEGORIES.length);
  for (const c of TELL_CATEGORIES) assert.equal(typeof counts[c], 'number');
  assert.equal(counts.STOCK_TRANSITIONS, 0);
});

test('ai-tells findings are clamped to flag and never block (clamp 1)', async () => {
  const result = await editorialPass('posts/known-good.md', 'ai-tells', {
    send: async () => AI_TELLS_VALID,
  });
  assert.equal(result.verdict, 'flag');
  for (const f of result.findings) assert.equal(f.severity, 'flag');
});

test('ai-tells never yields a patch, even when the model proposes one (clamp 3)', async () => {
  // The rubric says "No patches. Style is the author's call." Phase 1b
  // established that saying so is not sufficient: the model proposed patches for
  // judgment-class findings when explicitly told not to. Every ai-tells category
  // IS judgment-class, so clamp 3 rejects all of them — and the count is
  // surfaced rather than silently swallowed.
  const withPatches = JSON.stringify({
    ...JSON.parse(AI_TELLS_VALID),
    patches: [
      { line: 12, oldText: "it's not about the tooling", newText: 'the tooling matters less' },
      { line: 20, oldText: 'faster, cleaner, and more honest', newText: 'faster and cleaner' },
    ],
  });

  const result = await editorialPass('posts/known-good.md', 'ai-tells', {
    send: async () => withPatches,
  });

  assert.deepEqual(result.patches, []);
  assert.equal(result.metrics?.droppedPatches, 2);
  // The findings survive: dropping the patches must not cost us the analysis.
  assert.equal(result.findings.length, 3);
});

test('an out-of-range aiLikenessScore is clamped rather than discarded', () => {
  assert.equal(clampScore(105), 100);
  assert.equal(clampScore(-4), 0);
  assert.equal(clampScore(62), 62);
  // A NaN reaching a study aggregate would poison every number computed from
  // it, so it becomes 0 — safe, because this pass can only ever flag.
  assert.equal(clampScore(Number.NaN), 0);
});

test('an unrecognised tell category fails validation rather than going uncounted', async () => {
  // The enum is the guard. A silently-uncounted finding would understate a
  // score in a study whose whole output is a ranking.
  const bogus = JSON.stringify({
    aiLikenessScore: 10,
    findings: [
      {
        category: 'VIBES',
        line: 1,
        excerpt: 'x',
        message: 'y',
        evidence: 'z',
      },
    ],
  });
  await assert.rejects(
    editorialPass('posts/known-good.md', 'ai-tells', { send: async () => bogus }),
  );
});

test('the format/voice split partitions the tells without overlap or omission', () => {
  // The study's honest read depends on this split, and a tell silently in both
  // lists (or in neither, unnoticed) would quietly corrupt the re-ranked
  // analysis. EM_DASH_DENSITY is deliberately unclassified — see the source.
  const all = [...FORMAT_DRIVEN_TELLS, ...VOICE_DRIVEN_TELLS, ...UNCLASSIFIED_TELLS];
  assert.equal(new Set(all).size, all.length, 'a tell appears in more than one bucket');
  assert.deepEqual([...all].sort(), [...TELL_CATEGORIES].sort(), 'a tell is unbucketed');
});
