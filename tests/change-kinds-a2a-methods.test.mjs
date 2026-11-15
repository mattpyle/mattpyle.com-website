import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { A2A_METHOD_PHRASES, A2A_METHODS as LISTED, methodsClause } from '../src/lib/a2a-methods.mjs';
import { A2A_METHOD, A2A_METHODS, CANCEL_TASK_METHOD, GET_TASK_METHOD, STREAM_METHOD, respond } from '../src/lib/a2a-responder.mjs';
import { A2A_METHODS_LEGEND } from '../src/lib/activity-summary.mjs';
import { buildDigest } from '../scripts/generate-a2a-digest.mjs';

/**
 * Change kind "an agent endpoint method". The method names and their phrases are written once in
 * src/lib/a2a-methods.mjs. The digest description, the unknown-method error and the activity
 * legend are built from it, and the two hand-written surfaces, public/agents.md and the A2A line in
 * src/pages/llms.txt.ts, are checked here to name every method. See CHANGE-KINDS.md.
 */

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('the listed methods are the ones the responder dispatches on', () => {
  assert.deepEqual([...LISTED], [A2A_METHOD, STREAM_METHOD, GET_TASK_METHOD, CANCEL_TASK_METHOD]);
  assert.equal(A2A_METHODS, LISTED);
  assert.deepEqual(A2A_METHOD_PHRASES.map((method) => method.name), [...LISTED]);
});

test('the legend names every method', () => {
  for (const name of LISTED) assert.ok(A2A_METHODS_LEGEND.includes(name), `the activity legend does not name ${name}`);
});

test('the unknown-method error names every method', async () => {
  const reply = respond(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'NoSuchMethod' }), { digest: buildDigest(), newId: () => 'id-1' });
  const message = JSON.stringify(await reply);
  for (const name of LISTED) assert.ok(message.includes(name), `the unknown-method error does not name ${name}`);
});

test('the digest endpoint description names every method', () => {
  const description = buildDigest().surfaces.find((resource) => resource.name === 'A2A endpoint').description;
  for (const name of LISTED) assert.ok(description.includes(name), `the digest description does not name ${name}`);
  assert.ok(description.includes(methodsClause()));
});

test('agents.md names every method', () => {
  const text = read('public/agents.md');
  const missing = LISTED.filter((name) => !text.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `public/agents.md does not name: ${missing.join(', ')}`);
});

test('the A2A line in llms.txt names every method', () => {
  const line = read('src/pages/llms.txt.ts').split('\n').find((text) => text.includes('[A2A Agent Card]'));
  assert.ok(line, 'src/pages/llms.txt.ts has an A2A Agent Card line');
  const missing = LISTED.filter((name) => !line.includes(name));
  assert.deepEqual(missing, [], `the A2A line in src/pages/llms.txt.ts does not name: ${missing.join(', ')}`);
});
