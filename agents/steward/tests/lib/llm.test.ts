import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsTemperature } from '../../src/lib/llm.js';

/**
 * The gate is an allowlist, and the point of these tests is that it stays one.
 * The version this replaced was a denylist of models known to reject
 * `temperature`, which meant every model it had never heard of got the field
 * sent — and `claude-opus-5` shipped after the list was written, so pointing
 * `STEWARD_MODEL` at it 400'd every editorial pass.
 */

const ACCEPTS = [
  'claude-sonnet-4-6', // the STEWARD_MODEL default
  'claude-sonnet-4-5',
  'claude-sonnet-4-0',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-haiku-4-5',
  'claude-3-haiku-20240307',
];

const REJECTS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5',
];

for (const model of ACCEPTS) {
  test(`${model} accepts temperature`, () => {
    assert.equal(acceptsTemperature(model), true);
  });
}

for (const model of REJECTS) {
  test(`${model} must omit temperature (400 if sent)`, () => {
    assert.equal(acceptsTemperature(model), false);
  });
}

test('an unknown future model omits temperature rather than guessing', () => {
  // The whole reason this is an allowlist. Omitting the field is valid on every
  // model that accepts it, so failing closed costs nothing and cannot 400.
  assert.equal(acceptsTemperature('claude-opus-9'), false);
  assert.equal(acceptsTemperature('claude-something-entirely-new'), false);
});
