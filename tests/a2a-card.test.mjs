import assert from 'node:assert/strict';
import test from 'node:test';
import { readCard, readSchema, validateAgentCard } from '../scripts/validate-a2a-card.mjs';
import { PRODUCTION_ORIGIN } from '../src/data/site-origin.mjs';
import { A2A_METHOD } from '../src/lib/a2a-responder.mjs';

const schema = readSchema();

test('the published Agent Card conforms to the A2A 1.0 schema', () => {
  assert.deepEqual(validateAgentCard(readCard(), schema), []);
});

test('the card carries none of the 0.x fields the 1.0 schema dropped', () => {
  // Both were in the draft card and both are rejected by additionalProperties: false. In 1.0
  // `url` and `protocolVersion` moved onto the AgentInterface entries; the top-level spellings
  // are the single easiest way to ship a card that a conforming client refuses to parse.
  const card = readCard();
  assert.equal('url' in card, false);
  assert.equal('protocolVersion' in card, false);
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
});

test('the validator rejects the 0.x field spellings rather than ignoring them', () => {
  const errors = validateAgentCard(
    { ...readCard(), url: `${PRODUCTION_ORIGIN}/a2a`, protocolVersion: '1.0' },
    schema
  );
  assert.deepEqual(errors.sort(), [
    '/protocolVersion: property is not allowed by this schema',
    '/url: property is not allowed by this schema',
  ]);
});

test('the validator catches a card that drifts from the endpoint', () => {
  const card = readCard();
  const errors = validateAgentCard(
    { ...card, supportedInterfaces: [{ ...card.supportedInterfaces[0], url: 'https://example.com/a2a' }] },
    schema
  );
  assert.deepEqual(errors, [
    `supportedInterfaces[0].url: expected ${PRODUCTION_ORIGIN}/a2a, got https://example.com/a2a`,
  ]);
});

test('the validator catches a capability the responder does not implement', () => {
  const card = readCard();
  const errors = validateAgentCard(
    { ...card, capabilities: { ...card.capabilities, streaming: true } },
    schema
  );
  assert.deepEqual(errors, [
    'capabilities.streaming: the v1 responder implements none of these; must be false',
  ]);
});

test('the validator enforces the required fields and the non-empty-array rule', () => {
  const card = readCard();
  assert.deepEqual(validateAgentCard({ ...card, defaultInputModes: [] }, schema), [
    '/defaultInputModes: required array is empty',
  ]);

  const { skills, ...withoutSkills } = card;
  assert.ok(
    validateAgentCard(withoutSkills, schema).includes('/: missing required property "skills"')
  );
});

test('the card documents the endpoint the responder actually answers on', () => {
  const card = readCard();
  const jsonrpc = card.supportedInterfaces.find((entry) => entry.protocolBinding === 'JSONRPC');
  assert.equal(jsonrpc.url, `${PRODUCTION_ORIGIN}/a2a`);
  // Not asserted from a literal: if the responder's method name ever changes, this fails here
  // rather than in production, where the symptom is a client reading the card and getting -32601.
  assert.equal(A2A_METHOD, 'SendMessage');
});
