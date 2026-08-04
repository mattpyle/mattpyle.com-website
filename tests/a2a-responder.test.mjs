import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  A2A_METHOD,
  ERROR_CODES,
  LEGACY_METHODS,
  answer,
  classify,
  formatDate,
  respond,
} from '../src/lib/a2a-responder.mjs';

const digest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/a2a-digest.json', import.meta.url)), 'utf8')
);

/** Deterministic ids, so a reply can be asserted whole. */
function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

const call = (body, id = 1) =>
  respond(JSON.stringify({ jsonrpc: '2.0', id, method: A2A_METHOD, ...body }), {
    digest,
    newId: ids(),
  });

const ask = (text) => call({ params: { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text }] } } });

/** The same question from a 0.x client: legacy method name, legacy text part. */
const legacyAsk = (text, method = LEGACY_METHODS[0]) =>
  respond(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text }] } },
    }),
    { digest, newId: ids() }
  );

/** The markdown the webmaster replied with. */
const said = (result) => result.payload.result.message.parts[0].text;

/* ---------------------------------------------------------------- envelope validation */

test('a valid SendMessage returns a direct Message, not a Task', () => {
  const result = ask('What is this site about?');

  assert.equal(result.status, 200);
  assert.equal(result.payload.jsonrpc, '2.0');
  assert.equal(result.payload.id, 1);
  assert.equal(result.payload.error, undefined);

  const { message, task } = result.payload.result;
  assert.equal(task, undefined, 'the v1 has nothing to track, so it must not create a Task');
  assert.equal(message.role, 'ROLE_AGENT');
  assert.equal(message.messageId, 'id-1');
  // Servers MUST set contextId (specification section 4.1.4).
  assert.ok(message.contextId);
  assert.equal(message.parts.length, 1);
  assert.equal(message.parts[0].mediaType, 'text/markdown');
  assert.equal(typeof message.parts[0].text, 'string');
});

test('an inbound contextId is echoed so a client keeps its own thread', () => {
  const result = respond(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'abc',
      method: A2A_METHOD,
      params: { message: { contextId: 'ctx-from-client', parts: [{ text: 'hello' }] } },
    }),
    { digest, newId: ids() }
  );

  assert.equal(result.payload.result.message.contextId, 'ctx-from-client');
  assert.equal(result.payload.id, 'abc');
});

test('the id is echoed exactly, including a string or a null', () => {
  assert.equal(call({ params: { message: { parts: [{ text: 'hi' }] } } }, 'req-7').payload.id, 'req-7');
  assert.equal(call({ params: { message: { parts: [{ text: 'hi' }] } } }, null).payload.id, null);
});

test('a request with no id is a notification and gets no body', () => {
  const result = respond(
    JSON.stringify({ jsonrpc: '2.0', method: A2A_METHOD, params: { message: { parts: [{ text: 'hi' }] } } }),
    { digest, newId: ids() }
  );
  assert.equal(result.status, 204);
  assert.equal(result.payload, null);
});

test('the 0.x method name is accepted, and the 0.x text part shape with it', () => {
  for (const method of LEGACY_METHODS) {
    const result = legacyAsk('What is this site about?', method);
    assert.equal(result.payload.error, undefined, `${method} should be accepted`);
    assert.ok(result.payload.result.parts[0].text.includes('Webmaster'));
  }
});

/* ---------------------------------------------------------------- the 0.x dialect */

test('a legacy alias is answered in the 0.x response shape, not the 1.0 one', () => {
  // Measured against a2a-sdk 0.3.26 and @a2a-js/sdk compat/v0_3: `result` is the Message itself,
  // discriminated by `kind`, with a lowercase role and text parts carrying their own `kind`.
  for (const method of LEGACY_METHODS) {
    const result = legacyAsk('What is this site about?', method);

    assert.equal(result.status, 200);
    assert.equal(result.payload.jsonrpc, '2.0');
    assert.equal(result.payload.id, 1);

    const message = result.payload.result;
    assert.equal(message.message, undefined, 'must not wrap the Message the 1.0 way');
    assert.equal(message.kind, 'message', 'the 0.x discriminator the JS compat client reads');
    assert.equal(message.role, 'agent', 'the 0.x Role enum is lowercase');
    assert.equal(message.messageId, 'id-1');
    assert.ok(message.contextId);
    assert.deepEqual(Object.keys(message.parts[0]), ['kind', 'text']);
    assert.equal(message.parts[0].kind, 'text');
    assert.equal(typeof message.parts[0].text, 'string');
  }
});

test('an inbound contextId is echoed on the legacy path too', () => {
  const result = respond(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'abc',
      method: LEGACY_METHODS[0],
      params: { message: { parts: [{ kind: 'text', text: 'hello' }] }, },
    }),
    { digest, newId: ids() }
  );
  assert.equal(result.payload.result.contextId, 'id-2', 'a fresh one when the client sent none');

  const echoed = respond(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'abc',
      method: LEGACY_METHODS[0],
      params: { message: { contextId: 'ctx-from-client', parts: [{ kind: 'text', text: 'hello' }] } },
    }),
    { digest, newId: ids() }
  );
  assert.equal(echoed.payload.result.contextId, 'ctx-from-client');
});

test('a current-form SendMessage reply is unchanged by the alias work', () => {
  // The whole payload, byte for byte. The 0.x shape is additive: nothing about it may leak into
  // the answer a 1.0 client gets.
  const result = ask('What is this site about?');
  assert.deepEqual(result.payload, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      message: {
        role: 'ROLE_AGENT',
        messageId: 'id-1',
        contextId: 'id-2',
        parts: [{ text: said(result), mediaType: 'text/markdown' }],
      },
    },
  });
  assert.equal(result.outcome, 'ok/site');
});

test('an error on the legacy path stays readable to the client that sent it', () => {
  // 0.x types JSONRPCError.data as `Any | None`, so the 1.0 array of @type-carrying objects
  // validates there unchanged; the error envelope is identical in both versions. Nothing to
  // translate, which is the finding as much as the behaviour.
  const result = respond(
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: LEGACY_METHODS[0], params: { message: { parts: [] } } }),
    { digest, newId: ids() }
  );

  assert.equal(result.payload.error.code, ERROR_CODES.invalidParams);
  assert.ok(Array.isArray(result.payload.error.data));
  assert.equal(result.payload.error.data[0]['@type'], 'type.googleapis.com/google.rpc.BadRequest');
});

test('a legacy call is countable in the log line, separately from a current-form one', () => {
  // The outcome token is the endpoint's only dataset until the hit counter exists. The dialect
  // rides it as a prefix, since the tokens already carry slashes of their own.
  assert.equal(legacyAsk('What is this site about?').outcome, 'legacy/ok/site');
  assert.equal(ask('What is this site about?').outcome, 'ok/site');

  const noParams = respond(JSON.stringify({ jsonrpc: '2.0', id: 1, method: LEGACY_METHODS[0] }), {
    digest,
    newId: ids(),
  });
  assert.equal(noParams.outcome, 'legacy/invalid-params/no-params');

  const noText = respond(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: LEGACY_METHODS[0], params: {} }),
    { digest, newId: ids() }
  );
  assert.equal(noText.outcome, 'legacy/invalid-params/no-text');
});

/* ---------------------------------------------------------------- error shapes */

test('malformed JSON returns -32700 and says what failed', () => {
  const result = respond('{"jsonrpc": "2.0", oops', { digest, newId: ids() });

  assert.equal(result.status, 200, 'a JSON-RPC error rides a 200; the HTTP call itself succeeded');
  assert.equal(result.payload.id, null);
  assert.equal(result.payload.error.code, ERROR_CODES.parse);
  assert.match(result.payload.error.message, /did not parse as JSON/);
  // Specification section 9.5: data is an array of objects each carrying an @type.
  assert.ok(Array.isArray(result.payload.error.data));
  assert.equal(result.payload.error.data[0]['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
  assert.equal(result.payload.error.data[0].reason, 'INVALID_JSON');
});

test('an unknown method returns -32601 naming the one method that works', () => {
  const result = respond(
    JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tasks/get', params: {} }),
    { digest, newId: ids() }
  );

  assert.equal(result.payload.error.code, ERROR_CODES.methodNotFound);
  assert.match(result.payload.error.message, /tasks\/get/, 'names what was asked for');
  assert.match(result.payload.error.message, /"SendMessage"/, 'names what would have worked');

  const info = result.payload.error.data[0];
  assert.equal(info['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
  assert.equal(info.reason, 'METHOD_NOT_FOUND');
  assert.equal(info.metadata.supported, A2A_METHOD);
  assert.match(info.metadata.agentCard, /\/\.well-known\/agent-card\.json$/);
});

test('a bad envelope returns -32600 with a request that would have worked', () => {
  const result = respond(JSON.stringify({ id: 1, method: A2A_METHOD }), { digest, newId: ids() });

  assert.equal(result.payload.error.code, ERROR_CODES.invalidRequest);
  assert.match(result.payload.error.message, /"jsonrpc":"2\.0"/, 'shows a working call');
  const violations = result.payload.error.data[0];
  assert.equal(violations['@type'], 'type.googleapis.com/google.rpc.BadRequest');
  assert.deepEqual(violations.fieldViolations, [
    { field: 'jsonrpc', description: 'Must be exactly "2.0".' },
  ]);
});

test('a batch request is refused by name rather than half-handled', () => {
  const result = respond(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: A2A_METHOD }]), {
    digest,
    newId: ids(),
  });
  assert.equal(result.payload.error.code, ERROR_CODES.invalidRequest);
  assert.match(result.payload.error.message, /batch/);
  assert.equal(result.payload.error.data[0].reason, 'BATCH_NOT_SUPPORTED');
});

test('a message with no text returns -32602 pointing at the field', () => {
  for (const [params, field] of [
    [{}, 'message'],
    // A Message that exists but has no parts is a parts problem, and saying so is more use than
    // pointing back at the object the caller clearly did send.
    [{ message: {} }, 'message.parts'],
    [{ message: { parts: [] } }, 'message.parts'],
    [{ message: { parts: [{ raw: 'AAAA', mediaType: 'image/png' }] } }, 'message.parts'],
    [{ message: { parts: [{ text: '   ' }] } }, 'message.parts'],
  ]) {
    const result = call({ params });
    assert.equal(result.payload.error.code, ERROR_CODES.invalidParams, JSON.stringify(params));
    const violations = result.payload.error.data[0];
    assert.equal(violations['@type'], 'type.googleapis.com/google.rpc.BadRequest');
    assert.equal(violations.fieldViolations[0].field, field, JSON.stringify(params));
  }
});

test('missing params is distinguished from a message with no text', () => {
  const result = call({});
  assert.equal(result.payload.error.code, ERROR_CODES.invalidParams);
  assert.equal(result.payload.error.data[0].fieldViolations[0].field, 'params');
  assert.match(result.payload.error.message, /SendMessageRequest/);
});

/* ---------------------------------------------------------------- the answers */

test('every intent answers from the digest and cites a real site URL', () => {
  const questions = {
    site: 'What is this site about?',
    writing: 'What has Matt written recently?',
    builds: 'What projects has he built?',
    changelog: 'What has shipped on this site lately?',
    surfaces: 'What agent-readable surfaces does this site expose?',
    scorecard: 'What is the accessibility score?',
    person: 'Who is Matt Pyle?',
  };

  for (const [intent, question] of Object.entries(questions)) {
    assert.equal(answer(question, digest).intent, intent, `"${question}" should answer as ${intent}`);

    const reply = said(ask(question));
    assert.match(reply, /https:\/\/www\.mattpyle\.com/, `${intent} reply should cite a site URL`);
    assert.ok(reply.length > 120, `${intent} reply should say something`);
    assert.doesNotMatch(reply, /undefined|NaN|\[object Object\]/, `${intent} reply leaked a value`);
  }
});

test('the responder writes no em dashes of its own', () => {
  // House style, and on this repo an em dash reads as a generator fingerprint. Asserted against a
  // digest whose content strings are scrubbed, because the raw reply also contains authored post
  // and build descriptions, and this is a check on the webmaster's prose rather than on Matt's.
  const scrub = (value) =>
    typeof value === 'string'
      ? value.replaceAll('—', '-')
      : Array.isArray(value)
        ? value.map(scrub)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrub(child)]))
          : value;

  const scrubbed = scrub(digest);
  for (const question of [
    'What is this site about?',
    'What has Matt written recently?',
    'What projects has he built?',
    'What shipped lately?',
    'What agent surfaces does this expose?',
    'What is the accessibility score?',
    'Who is Matt Pyle?',
    'zzzz qqqq',
  ]) {
    assert.doesNotMatch(answer(question, scrubbed).text, /—/, `em dash in the reply to "${question}"`);
  }
});

test('the writing answer lists the real posts, newest first, with markdown URLs offered', () => {
  const reply = said(ask('What has Matt written recently?'));

  for (const article of digest.writing) {
    assert.ok(reply.includes(article.title), `missing "${article.title}"`);
    assert.ok(reply.includes(article.url), `missing ${article.url}`);
  }
  const positions = digest.writing.map((article) => reply.indexOf(article.title));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'newest first');
  assert.match(reply, /Accept: text\/markdown/);
});

test('the changelog answer says what it truncated instead of implying that is everything', () => {
  const reply = said(ask('What shipped lately?'));
  assert.ok(reply.includes(String(digest.counts.changelog)), 'states the full count');
  assert.ok(reply.includes(String(digest.counts.changelogListed)), 'states how many it listed');
  assert.ok(reply.includes(digest.changelog[0].title));
});

test('the scorecard answer refuses to quote a number it does not have', () => {
  const reply = said(ask('How does this site score on Lighthouse?'));
  assert.match(reply, /will not quote you a number/);
  assert.match(reply, /https:\/\/www\.mattpyle\.com\/scorecard/);
  assert.doesNotMatch(reply, /\b100\b|\b9[0-9]\b/, 'must not invent a score');
});

test('an unrecognised question says so and hands over the orientation answer', () => {
  const reply = said(ask('zzzz qqqq'));
  assert.match(reply, /did not recognise the question/);
  assert.match(reply, /Sections/);
  // The apology only belongs on a question that was actually asked.
  assert.doesNotMatch(said(ask('What is this site about?')), /did not recognise/);
});

test('keyword matching does not fire on substrings', () => {
  // "blog" contains "log", "newest" contains "new": unpadded matching would make the changelog
  // intent win almost everything.
  assert.equal(classify('where is the blog?')?.id, 'writing');
  assert.equal(classify('what is in the log?')?.id, 'changelog');
});

test('every reply carries its own provenance, so it survives being quoted', () => {
  for (const question of ['What is this site about?', 'What has shipped lately?', 'Who is Matt?']) {
    assert.match(said(ask(question)), /Compiled from this site's own published content/);
  }
});

test('the answer is a pure function of the question and the digest', () => {
  assert.equal(answer('what shipped?', digest).text, answer('what shipped?', digest).text);
});

test('an empty digest degrades to prose rather than to a crash', () => {
  const empty = {
    ...digest,
    writing: [],
    builds: [],
    changelog: [],
    counts: { writing: 0, builds: 0, changelog: 0, changelogListed: 0 },
  };
  assert.match(answer('what has he written?', empty).text, /nothing is published/i);
  assert.match(answer('what projects?', empty).text, /Nothing on the projects shelf/);
  assert.match(answer('what shipped?', empty).text, /log book is empty/);
});

test('dates render the same everywhere, regardless of the region the function wakes up in', () => {
  assert.equal(formatDate('2026-07-18T00:00:00.000Z'), '18 Jul 2026');
  assert.equal(formatDate('2026-01-02T23:59:59.000Z'), '2 Jan 2026');
  assert.equal(formatDate('not a date'), 'not a date');
});
