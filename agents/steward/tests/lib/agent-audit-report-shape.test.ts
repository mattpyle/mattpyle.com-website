import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderedNothing, reportIntegrity } from '../../src/lib/agent-audit/report-shape.js';
import { deepAuditShape } from '../../src/lib/run-health.js';

/**
 * The report-shape invariant, and the property that makes it worth having: the
 * document's own verdict and the alert's verdict come from one predicate and
 * cannot disagree about a run.
 *
 * Written against the 2026-08-15 incident — a deep audit that sampled a page,
 * rendered nothing, and reported itself finished — rather than against the
 * general idea of an incomplete report.
 */

test('zero rendered of a nonzero sample is the defect', () => {
  assert.equal(renderedNothing(3, 0), true);
  assert.equal(renderedNothing(1, 0), true);
});

test('a sample of zero is not a defect, however many pages were rendered', () => {
  // A small site, or one whose robots.txt refuses this auditor, legitimately has
  // nothing to render. That is the site's answer, not a broken run.
  assert.equal(renderedNothing(0, 0), false);
});

test('any rendered page clears the invariant', () => {
  assert.equal(renderedNothing(3, 1), false);
  assert.equal(renderedNothing(3, 3), false);
});

test('a clean report carries no reason', () => {
  const integrity = reportIntegrity({ sampled: 3, rendered: 2 });
  assert.equal(integrity.status, 'clean');
  assert.equal(integrity.reason, undefined);
});

test('a degraded report says which half is missing and which is still readable', () => {
  const integrity = reportIntegrity({ sampled: 3, rendered: 0 });
  assert.equal(integrity.status, 'degraded');
  // The reason is served to a stranger through an MCP client with no other
  // context, so it has to carry both halves of the sentence.
  assert.match(integrity.reason ?? '', /0 of 3/);
  assert.match(integrity.reason ?? '', /rendered-experience/);
  assert.match(integrity.reason ?? '', /fetch-based checks/);
});

test('a sample of zero assembles clean', () => {
  assert.deepEqual(reportIntegrity({ sampled: 0, rendered: 0 }), { status: 'clean' });
});

// --- the property the shared predicate exists for ---------------------------

test('the report and the alert never disagree about one run', () => {
  // The failure this guards is not either function being wrong on its own. It is
  // an operator holding an email that says a run went wrong beside a report that
  // calls itself clean, which is what two copies of the rule eventually produce.
  for (const [sampled, rendered] of [
    [0, 0],
    [1, 0],
    [3, 0],
    [3, 1],
    [3, 3],
  ]) {
    const integrity = reportIntegrity({ sampled, rendered });
    const alert = deepAuditShape({ origin: 'https://example.com', sampled, rendered });
    assert.equal(
      integrity.status === 'clean',
      alert.ok,
      `sampled=${sampled} rendered=${rendered}: the document and the alert disagree`,
    );
  }
});
