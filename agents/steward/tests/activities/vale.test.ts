import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ValeOutput,
  valeAlertsToFindings,
  valeSeverityToVerdict,
} from '../../src/activities/vale.js';

/**
 * Canned Vale output, copied verbatim from a real `vale --output=JSON` run
 * (v3.15.1, Windows) rather than hand-written to match the parser. Note the
 * backslash-separated key and the `Action`/`Span` fields the mapping ignores —
 * both are real, and both are the kind of thing a hand-written fixture omits.
 */
const CANNED = {
  'tests\\fixtures\\posts\\known-good.md': [
    {
      Action: { Name: '', Params: null },
      Span: [35, 36],
      Check: 'write-good.E-Prime',
      Description: '',
      Link: '',
      Message: "Try to avoid using 'is'.",
      Severity: 'suggestion',
      Match: 'is',
      Line: 13,
    },
    {
      Action: { Name: '', Params: null },
      Span: [1, 10],
      Check: 'write-good.Weasel',
      Description: '',
      Link: '',
      Message: "'obviously' is a weasel word!",
      Severity: 'warning',
      Match: 'obviously',
      Line: 40,
    },
    {
      Action: { Name: '', Params: null },
      Span: [4, 8],
      Check: 'Vale.Spelling',
      Description: '',
      Link: '',
      Message: "Did you really mean 'teh'?",
      Severity: 'error',
      Match: 'teh',
      Line: 7,
    },
  ],
};

test('parses real Vale JSON output', () => {
  const parsed = ValeOutput.parse(CANNED);
  assert.equal(Object.values(parsed).flat().length, 3);
});

test('maps alerts to findings, ordered error → warning → suggestion', () => {
  const findings = valeAlertsToFindings(ValeOutput.parse(CANNED), 'src/content/writing/x.md');

  assert.deepEqual(
    findings.map((f) => f.message.split(' ')[0]),
    ['Vale.Spelling', 'write-good.Weasel', 'write-good.E-Prime'],
  );
  assert.deepEqual(findings.map((f) => f.id), ['vale-1', 'vale-2', 'vale-3']);
  assert.deepEqual(findings.map((f) => f.line), [7, 40, 13]);
});

test('every Vale finding is a flag — prose linting never blocks (design rule 1)', () => {
  const findings = valeAlertsToFindings(ValeOutput.parse(CANNED), 'x.md');
  assert.ok(findings.every((f) => f.severity === 'flag'));
  // Explicitly including the `error` severity, which is the tempting one to
  // promote to `block`.
  assert.equal(valeSeverityToVerdict('error'), 'flag');
  assert.equal(valeSeverityToVerdict('warning'), 'flag');
  assert.equal(valeSeverityToVerdict('suggestion'), 'flag');
});

test('carries the rule name, file, line and match into the finding', () => {
  const [first] = valeAlertsToFindings(ValeOutput.parse(CANNED), 'src/content/writing/x.md');
  assert.equal(first.pass, 'vale');
  assert.equal(first.file, 'src/content/writing/x.md');
  assert.equal(first.line, 7);
  assert.equal(first.excerpt, 'teh');
  // The rule name is what you paste into .vale.ini to silence it, so it has to
  // survive into the message the human reads.
  assert.match(first.message, /Vale\.Spelling/);
  assert.match(first.message, /Did you really mean 'teh'\?/);
});

test('an empty alert array is a clean pass, not a parse failure', () => {
  const findings = valeAlertsToFindings(ValeOutput.parse({ 'x.md': [] }), 'x.md');
  assert.deepEqual(findings, []);
});

test('unknown extra fields do not fail the parse', () => {
  const parsed = ValeOutput.parse({
    'x.md': [
      {
        Check: 'write-good.So',
        Message: "Don't start a sentence with 'So'.",
        Severity: 'warning',
        Line: 3,
        SomeFutureFieldValeAdds: true,
      },
    ],
  });
  assert.equal(valeAlertsToFindings(parsed, 'x.md').length, 1);
});
