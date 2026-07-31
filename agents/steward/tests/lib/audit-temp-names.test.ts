import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tempRunName } from '../../src/lib/audit-engine.js';

/**
 * The temp-path collision from the July 2026 codebase review: the old
 * `${pid}-${Date.now()}` key is not unique across two launches in the same
 * millisecond inside one process, which the scorecard fan-out makes ordinary.
 * Two audits then share an axe result file or a Chrome profile directory.
 */

test('names generated in the same millisecond are still unique', () => {
  const names = Array.from({ length: 5_000 }, () => tempRunName('steward-axe'));
  assert.equal(new Set(names).size, names.length);
});

test('the old pid+timestamp key alone would have collided', () => {
  // Guards the reasoning, not just the outcome: if this ever stops colliding,
  // the counter is no longer the thing making the names unique.
  const old = Array.from({ length: 5_000 }, () => `steward-axe-${process.pid}-${Date.now()}`);
  assert.ok(new Set(old).size < old.length);
});

test('names carry the prefix and the pid, so a stale file is still attributable', () => {
  const name = tempRunName('chrome');
  assert.match(name, new RegExp(`^chrome-${process.pid}-\\d+-\\d+$`));
});
