import assert from 'node:assert/strict';
import test from 'node:test';
import { readCard, readSchema, validateAgentCard } from '../scripts/validate-a2a-card.mjs';
import { PRODUCTION_ORIGIN } from '../src/data/site-origin.mjs';
import { A2A_METHOD, GET_TASK_METHOD } from '../src/lib/a2a-responder.mjs';
import { ASK_SKILL_ID, AUDIT_SKILL_ID, CONSULTANT_SKILL_ID, SKILL_IDS, routeMessage } from '../src/lib/a2a-audit-skill.mjs';

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

test('the validator holds the capabilities to what the responder implements', () => {
  const card = readCard();
  assert.equal(card.capabilities.streaming, true, 'the endpoint answers SendStreamingMessage');
  assert.deepEqual(
    validateAgentCard({ ...card, capabilities: { ...card.capabilities, streaming: false } }, schema),
    ['capabilities.streaming: the responder answers SendStreamingMessage; must be true']
  );
  assert.deepEqual(
    validateAgentCard({ ...card, capabilities: { pushNotifications: false, extendedAgentCard: false } }, schema),
    ['capabilities.streaming: the responder answers SendStreamingMessage; must be true']
  );
  assert.deepEqual(
    validateAgentCard({ ...card, capabilities: { ...card.capabilities, pushNotifications: true } }, schema),
    ['capabilities.pushNotifications: the responder does not implement this; must be false']
  );
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

test('the card declares exactly the skills the endpoint dispatches', () => {
  const card = readCard();
  assert.deepEqual(card.skills.map((skill) => skill.id), [...SKILL_IDS]);

  // A card advertising a skill id no message can route to is the failure this pins. The number is
  // not the point; the ids are.
  const errors = validateAgentCard(
    { ...card, skills: [...card.skills, { id: 'explain-finding', name: 'x', description: 'y' }] },
    schema
  );
  assert.deepEqual(errors, [
    'skills: expected exactly [consult-on-a-site, audit-a-site, ask-about-site], found [consult-on-a-site, audit-a-site, ask-about-site, explain-finding]',
  ]);
});

test('the audit skill advertises both methods a caller needs and both output modes', () => {
  const audit = readCard().skills.find((skill) => skill.id === AUDIT_SKILL_ID);
  // The deep tier is a Task, so a caller who reads only the card has to learn the polling method
  // from it. Pinned because the description is the only place that says so.
  assert.match(audit.description, new RegExp(GET_TASK_METHOD));
  assert.match(audit.description, /TASK_STATE_COMPLETED/);
  assert.deepEqual(audit.outputModes, ['text/markdown', 'application/json']);
});

test('the card is Steward, and nothing in it says webmaster', () => {
  const card = readCard();
  assert.equal(card.name, 'Steward');
  assert.doesNotMatch(JSON.stringify(card), /webmaster|retro/i);
});

test('the first skill is the one a message that names no skill reaches, and its examples reach it', () => {
  const card = readCard();
  assert.equal(card.skills[0].id, CONSULTANT_SKILL_ID);
  for (const example of card.skills[0].examples) {
    assert.equal(routeMessage({}, example, { model: true }).skill, CONSULTANT_SKILL_ID, example);
  }
  // What a caller reads to use the reply: the artifact, the context, and the two pauses.
  for (const word of ['artifact', 'contextId', 'TASK_STATE_COMPLETED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_WORKING', 'CancelTask', 'returnImmediately']) {
    assert.ok(card.skills[0].description.includes(word), word);
  }
});

test('the two skills with no model say they are reached by name', () => {
  const card = readCard();
  for (const id of [AUDIT_SKILL_ID, ASK_SKILL_ID]) {
    const skill = card.skills.find((entry) => entry.id === id);
    assert.ok(skill.description.includes(`{"skill": "${id}"}`), id);
    assert.match(skill.description, /no model/, id);
  }
});

test("every audit example the card publishes routes to the audit skill, named or by wording", () => {
  // The examples are the vocabulary a caller copies. An example that falls through to
  // ask-about-site would teach the wrong words, and nothing else in the build would notice.
  const audit = readCard().skills.find((skill) => skill.id === AUDIT_SKILL_ID);
  for (const example of audit.examples) {
    const named = routeMessage({ message: { metadata: { skill: AUDIT_SKILL_ID } } }, example, { model: true });
    assert.equal(named.skill, AUDIT_SKILL_ID);
    assert.ok(named.target, `"${example}" should name a target when the skill is named`);
    const route = routeMessage({}, example);
    assert.equal(route.skill, AUDIT_SKILL_ID, `"${example}" should route to the audit skill`);
    assert.ok(route.target, `"${example}" should name a target`);
  }
});

test('no ask-about-site example is caught by the audit skill', () => {
  const ask = readCard().skills.find((skill) => skill.id === ASK_SKILL_ID);
  for (const example of ask.examples) {
    assert.equal(routeMessage({}, example).skill, ASK_SKILL_ID, `"${example}" must stay unchanged`);
  }
});

test('the card documents the endpoint the responder actually answers on', () => {
  const card = readCard();
  const jsonrpc = card.supportedInterfaces.find((entry) => entry.protocolBinding === 'JSONRPC');
  assert.equal(jsonrpc.url, `${PRODUCTION_ORIGIN}/a2a`);
  // Not asserted from a literal: if the responder's method name ever changes, this fails here
  // rather than in production, where the symptom is a client reading the card and getting -32601.
  assert.equal(A2A_METHOD, 'SendMessage');
});
