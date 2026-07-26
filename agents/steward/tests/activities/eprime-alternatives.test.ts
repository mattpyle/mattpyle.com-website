import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
process.env.STEWARD_SITE_DIR = fixtures;

const {
  EprimeAlternativesResponse,
  buildEprimePayload,
  mapEprimeAlternativesResponse,
  eprimeAlternativesPass,
} = await import('../../src/activities/editorial.js');
const { isEprimeFinding, selectEprimeFindings } = await import('../../src/lib/eprime.js');

type Finding = import('../../src/lib/report.js').Finding;
type PassResult = import('../../src/lib/report.js').PassResult;

function valeFinding(id: string, line: number, check: string, excerpt: string): Finding {
  return {
    id,
    pass: 'vale',
    severity: 'flag',
    message: `${check} (suggestion): try to avoid "${excerpt}"`,
    file: 'posts/known-good.md',
    line,
    excerpt,
  };
}

function valePass(findings: Finding[]): PassResult {
  return {
    pass: 'vale',
    verdict: 'flag',
    findings,
    patches: [],
    startedAt: '2026-07-25T00:00:00.000Z',
    durationMs: 1,
  };
}

// ---------------------------------------------------------------------------
// Selection — the pass consumes Vale's findings rather than re-running Vale.
// ---------------------------------------------------------------------------

test('only write-good.E-Prime findings are selected out of the Vale pass', () => {
  const eprime = valeFinding('vale-1', 4, 'write-good.E-Prime', 'was');
  const wordy = valeFinding('vale-2', 5, 'write-good.TooWordy', 'utilise');
  const weasel = valeFinding('vale-3', 6, 'write-good.Weasel', 'clearly');

  assert.equal(isEprimeFinding(eprime), true);
  assert.equal(isEprimeFinding(wordy), false);
  assert.equal(isEprimeFinding(weasel), false);

  const selected = selectEprimeFindings([valePass([eprime, wordy, weasel])]);
  assert.deepEqual(
    selected.map((f) => f.id),
    ['vale-1'],
  );
});

test('a rule whose name merely starts with E-Prime is not selected', () => {
  // Guards against a `startsWith` that would also match a hypothetical
  // `write-good.E-Primer`. The check name ends where Vale's ` (severity)` begins.
  const lookalike = valeFinding('vale-9', 3, 'write-good.E-Primer', 'was');
  assert.equal(isEprimeFinding(lookalike), false);
});

test('no Vale pass at all selects nothing rather than throwing', () => {
  assert.deepEqual(selectEprimeFindings([]), []);
});

// ---------------------------------------------------------------------------
// The payload — flagged lines plus one line of context, not the whole post.
// ---------------------------------------------------------------------------

const TEN_LINES = [
  'alpha one',
  'bravo two is here',
  'charlie three',
  'delta four',
  'echo five',
  'foxtrot six',
  'golf seven',
  'hotel eight is here',
  'india nine',
  'juliet ten',
].join('\n');

test('the payload carries only the flagged lines and one line of context each', () => {
  const payload = buildEprimePayload(TEN_LINES, [
    valeFinding('vale-1', 2, 'write-good.E-Prime', 'is'),
    valeFinding('vale-2', 8, 'write-good.E-Prime', 'is'),
  ]);

  for (const included of ['alpha one', 'bravo two', 'charlie three', 'golf seven', 'hotel eight', 'india nine']) {
    assert.ok(payload.includes(included), `payload should include "${included}"`);
  }
  for (const excluded of ['delta four', 'echo five', 'foxtrot six', 'juliet ten']) {
    assert.ok(!payload.includes(excluded), `payload should not include "${excluded}"`);
  }
});

test('payload line numbers are the real file line numbers', () => {
  const payload = buildEprimePayload(TEN_LINES, [valeFinding('vale-1', 8, 'write-good.E-Prime', 'is')]);
  assert.ok(/^\s*8\| hotel eight is here$/m.test(payload), payload);
});

test('a gap between two context windows is marked, not silently closed', () => {
  const payload = buildEprimePayload(TEN_LINES, [
    valeFinding('vale-1', 2, 'write-good.E-Prime', 'is'),
    valeFinding('vale-2', 8, 'write-good.E-Prime', 'is'),
  ]);
  assert.ok(payload.includes('...'), 'a skipped region should be visibly elided');
});

// ---------------------------------------------------------------------------
// Guarantee 1 — the cap is enforced in code, not asked of the model.
// ---------------------------------------------------------------------------

const EIGHT_LINE_POST = Array.from(
  { length: 8 },
  (_, i) => `Sentence number ${i + 1} was written by somebody.`,
).join('\n');

function eightGoodSuggestions() {
  return Array.from({ length: 8 }, (_, i) => ({
    line: i + 1,
    original: `Sentence number ${i + 1} was written by somebody.`,
    suggestion: `Somebody wrote sentence number ${i + 1}.`,
    reason: 'Names the actor instead of hiding it behind a passive construction.',
  }));
}

test('at most five suggestions survive, however many the model returns', () => {
  const response = EprimeAlternativesResponse.parse({ suggestions: eightGoodSuggestions() });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);

  assert.equal(mapped.findings.length, 5);
  assert.equal(mapped.returned, 8);
  assert.equal(mapped.capped, 3);
});

test('every surviving suggestion is a flag on the eprime_alternatives pass, and never a patch', () => {
  const response = EprimeAlternativesResponse.parse({
    suggestions: eightGoodSuggestions().slice(0, 2),
    // The ai-tells pass established that the model proposes patches even when
    // told not to. Accepting the key and dropping its contents beats throwing
    // away good suggestions over it.
    patches: [{ line: 1, oldText: 'x', newText: 'y' }],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);

  assert.equal(mapped.findings.length, 2);
  assert.ok(mapped.findings.every((f) => f.severity === 'flag'));
  assert.ok(mapped.findings.every((f) => f.pass === 'eprime_alternatives'));
  assert.equal(mapped.droppedPatches, 1);
});

test('the reason and the suggested rewrite both reach the finding', () => {
  const response = EprimeAlternativesResponse.parse({ suggestions: eightGoodSuggestions().slice(0, 1) });
  const { findings } = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);

  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].excerpt, 'Sentence number 1 was written by somebody.');
  assert.ok(findings[0].message.includes('Names the actor'));
  assert.ok(findings[0].evidence?.includes('Somebody wrote sentence number 1.'));
});

// ---------------------------------------------------------------------------
// Guarantee 2 — the tell gate.
// ---------------------------------------------------------------------------

const TELL_GATE_POST = 'The result was surprising to everyone who read it.';

test('a rewrite that introduces an em dash is rejected by the tell gate', () => {
  const response = EprimeAlternativesResponse.parse({
    suggestions: [
      {
        line: 1,
        original: TELL_GATE_POST,
        suggestion: 'The result surprised everyone who read it — genuinely.',
        reason: 'Replaces a static verb with an active one.',
      },
    ],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', TELL_GATE_POST);

  assert.equal(mapped.findings.length, 0);
  assert.equal(mapped.rejectedWorseTells, 1);
});

test('a rewrite that adds no tells survives the gate', () => {
  const response = EprimeAlternativesResponse.parse({
    suggestions: [
      {
        line: 1,
        original: TELL_GATE_POST,
        suggestion: 'The result surprised everyone who read it.',
        reason: 'Replaces a static verb with an active one.',
      },
    ],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', TELL_GATE_POST);

  assert.equal(mapped.findings.length, 1);
  assert.equal(mapped.rejectedWorseTells, 0);
});

test('a rewrite that removes an existing tell is not penalised for the tells already there', () => {
  const original = 'The audit was slow, noisy, and expensive — every time.';
  const response = EprimeAlternativesResponse.parse({
    suggestions: [
      {
        line: 1,
        original,
        suggestion: 'The audit ran slow, noisy, and expensive every time.',
        reason: 'Removes a static verb.',
      },
    ],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', original);

  assert.equal(mapped.findings.length, 1, 'fewer tells than the original must pass');
});

// ---------------------------------------------------------------------------
// Guarantee 3 — a hallucinated excerpt never reaches the report.
// ---------------------------------------------------------------------------

test('a suggestion whose original is nowhere in the post is dropped', () => {
  const response = EprimeAlternativesResponse.parse({
    suggestions: [
      {
        line: 1,
        original: 'This sentence does not appear anywhere in the post.',
        suggestion: 'Nor does this one.',
        reason: 'Invented wholesale.',
      },
    ],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);

  assert.equal(mapped.findings.length, 0);
  assert.equal(mapped.rejectedNotFound, 1);
});

test('a suggestion citing real text at the wrong line is dropped, not silently re-homed far away', () => {
  const response = EprimeAlternativesResponse.parse({
    suggestions: [
      {
        line: 1,
        original: 'Sentence number 7 was written by somebody.',
        suggestion: 'Somebody wrote sentence number 7.',
        reason: 'Names the actor.',
      },
    ],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);

  assert.equal(mapped.findings.length, 0);
  assert.equal(mapped.rejectedNotFound, 1);
});

test('a one-line citation drift is tolerated and the finding is re-anchored to the real line', () => {
  const response = EprimeAlternativesResponse.parse({
    suggestions: [
      {
        line: 4,
        original: 'Sentence number 3 was written by somebody.',
        suggestion: 'Somebody wrote sentence number 3.',
        reason: 'Names the actor.',
      },
    ],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);

  assert.equal(mapped.findings.length, 1);
  assert.equal(mapped.findings[0].line, 3);
});

test('a no-op suggestion is dropped rather than offered as an improvement', () => {
  const response = EprimeAlternativesResponse.parse({
    suggestions: [
      {
        line: 1,
        original: 'Sentence number 1 was written by somebody.',
        suggestion: 'Sentence number 1 was written by somebody.',
        reason: 'No change needed.',
      },
    ],
  });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);

  assert.equal(mapped.findings.length, 0);
  // Counted rather than silently swallowed. Observed on every real run: the
  // model pads its list with entries whose `suggestion` equals the `original`
  // and whose reason says "no change needed here". Knowing how often it does
  // that is the difference between "the model had two ideas" and "the model had
  // two ideas and three non-ideas".
  assert.equal(mapped.rejectedNoOp, 1);
});

test('zero suggestions is a valid, clean answer', () => {
  const response = EprimeAlternativesResponse.parse({ suggestions: [] });
  const mapped = mapEprimeAlternativesResponse(response, 'posts/known-good.md', EIGHT_LINE_POST);
  assert.deepEqual(mapped.findings, []);
  assert.equal(mapped.returned, 0);
});

// ---------------------------------------------------------------------------
// The activity end to end, over the injected transport (spec §11 — no network).
// ---------------------------------------------------------------------------

test('the pass returns a flag PassResult with no patches and countable metrics', async () => {
  const result = await eprimeAlternativesPass(
    {
      file: 'posts/known-good.md',
      eprimeFindings: [valeFinding('vale-1', 20, 'write-good.E-Prime', 'is')],
    },
    {
      send: async () =>
        JSON.stringify({
          suggestions: [
            {
              line: 20,
              original: 'The alt text conveys what the image shows, not the filename.',
              suggestion: 'The alt text says what the image shows, not the filename.',
              reason: 'Says what the text does rather than describing it at one remove.',
            },
          ],
        }),
    },
  );

  assert.equal(result.pass, 'eprime_alternatives');
  assert.equal(result.verdict, 'flag');
  assert.deepEqual(result.patches, []);
  assert.equal(result.rubric?.path, 'agents/steward/src/rubrics/eprime-alternatives.md');
  assert.equal(result.metrics?.eprimeInstances, 1);
  assert.equal(result.metrics?.suggestionsReturned, 1);
});

test('a post the model finds nothing worth rewriting in passes cleanly', async () => {
  const result = await eprimeAlternativesPass(
    {
      file: 'posts/known-good.md',
      eprimeFindings: [valeFinding('vale-1', 20, 'write-good.E-Prime', 'is')],
    },
    { send: async () => JSON.stringify({ suggestions: [] }) },
  );

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.findings, []);
});
