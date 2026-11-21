import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOT_OWNER, UNKNOWN_INTERACTION, WORK_FAILED, HEALTH_PATH } from '../../src/discord/server.js';
import type { HandlerResult, InteractionHandler } from '../../src/discord/interactions.js';
import { APPLICATION_ID, STRANGER_ID, commandInteraction, fakeDiscord, startTestServer, testApplication, until } from './support.js';

/**
 * The Interactions Endpoint over real HTTP on a loopback port, with requests
 * signed by a throwaway key: the signature and timestamp gate, PING, the owner
 * check, the replay guard, and the two ways an answer leaves, in the response
 * or as a deferred acknowledgement and a follow-up edit.
 */

const none: InteractionHandler = () => null;
const working = (run: () => Promise<string>, ephemeral?: boolean): InteractionHandler => () => ({ kind: 'work', run, ephemeral }) as HandlerResult;

test('PING is answered with PONG as JSON', async () => {
  const t = await startTestServer(none);
  try {
    const res = await fetch(t.url, {
      method: 'POST',
      headers: (() => {
        const stamp = String(Math.floor(Date.now() / 1000));
        return { 'x-signature-timestamp': stamp, 'x-signature-ed25519': t.app.sign(stamp, '{"type":1}') };
      })(),
      body: '{"type":1}',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await res.json(), { type: 1 });
  } finally {
    await t.server.close();
  }
});

test('a bad signature, a missing header and another key each answer 401, and the handler never runs', async () => {
  let ran = 0;
  const t = await startTestServer(() => {
    ran++;
    return null;
  });
  try {
    const body = commandInteraction('approve', { ids: 'MP-1' });
    const stamp = String(Math.floor(Date.now() / 1000));
    const forged = testApplication().sign(stamp, JSON.stringify(body));
    assert.equal((await t.post(body, { signature: forged, timestamp: stamp })).status, 401);
    assert.equal((await t.post(body, { signature: null })).status, 401);
    assert.equal((await t.post(body, { timestamp: null })).status, 401);
    // Signed, then the body changed on the way.
    const signed = t.app.sign(stamp, JSON.stringify(body));
    assert.equal((await t.post(body, { signature: signed, timestamp: stamp, raw: JSON.stringify({ ...body, type: 1 }) })).status, 401);
    // Even a PING needs the signature.
    assert.equal((await t.post({ type: 1 }, { signature: forged, timestamp: stamp })).status, 401);
    assert.equal(ran, 0);
    assert.ok(t.logs.every((entry) => entry.level === 'warn'));
  } finally {
    await t.server.close();
  }
});

test('a correctly signed request with a stale timestamp answers 401', async () => {
  const t = await startTestServer(none);
  try {
    const old = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const res = await t.post({ type: 1 }, { timestamp: old });
    assert.equal(res.status, 401);
    assert.equal(t.logs[0].fields.refusal, 'stale-timestamp');
  } finally {
    await t.server.close();
  }
});

test("another user's command is refused to them alone, and the handler never runs", async () => {
  let ran = 0;
  const t = await startTestServer(() => {
    ran++;
    return null;
  });
  try {
    const res = await t.post(commandInteraction('approve', { ids: 'MP-1' }, STRANGER_ID));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { type: 4, data: { content: NOT_OWNER, allowed_mentions: { parse: [] }, flags: 64 } });
    // An interaction that names no user at all is not the owner's either.
    const nobody = { ...commandInteraction('approve', { ids: 'MP-1' }), member: {} };
    assert.equal((await t.post(nobody)).body.data.content, NOT_OWNER);
    assert.equal(ran, 0);
  } finally {
    await t.server.close();
  }
});

test('in a direct message the invoking user is read from `user`', async () => {
  const t = await startTestServer(() => ({ kind: 'reply', message: { content: 'hello' } }));
  try {
    const { member, ...rest } = commandInteraction('approve', { ids: 'MP-1' }) as { member: unknown };
    const res = await t.post({ ...rest, user: (member as { user: unknown }).user });
    assert.equal(res.body.data.content, 'hello');
  } finally {
    await t.server.close();
  }
});

test('an interaction no handler knows gets a plain refusal', async () => {
  const t = await startTestServer(none);
  try {
    const res = await t.post(commandInteraction('defer', { id: 'MP-1' }));
    assert.equal(res.body.type, 4);
    assert.equal(res.body.data.content, UNKNOWN_INTERACTION);
    assert.equal(res.body.data.flags, 64);
  } finally {
    await t.server.close();
  }
});

test('the same interaction sent twice is taken once', async () => {
  let ran = 0;
  const t = await startTestServer(() => {
    ran++;
    return { kind: 'reply', message: { content: 'done' } };
  });
  try {
    const body = commandInteraction('approve', { ids: 'MP-1' });
    assert.equal((await t.post(body)).status, 200);
    assert.equal((await t.post(body)).status, 409);
    assert.equal(ran, 1);
  } finally {
    await t.server.close();
  }
});

test('only POST on the interactions path; the health path answers GET; a large body is refused', async () => {
  const t = await startTestServer(none);
  try {
    assert.equal((await fetch(t.url)).status, 405);
    const base = t.url.replace(/\/discord\/interactions$/, '');
    assert.equal((await fetch(`${base}${HEALTH_PATH}`)).status, 200);
    assert.equal((await fetch(`${base}/findings`)).status, 404);
    const big = await t.post({ type: 1, pad: 'x'.repeat(70 * 1024) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    assert.equal((await t.post(null, { raw: 'not json' })).status, 400);
  } finally {
    await t.server.close();
  }
});

test('work that finishes inside the reply window is answered in the response, with mentions off', async () => {
  const discord = fakeDiscord();
  const t = await startTestServer(working(async () => 'MP-1 A title: recorded @everyone'), { fetch: discord.fetch, replyBudgetMs: 500 });
  try {
    const res = await t.post(commandInteraction('approve', { ids: 'MP-1' }));
    assert.deepEqual(res.body, { type: 4, data: { content: 'MP-1 A title: recorded @everyone', allowed_mentions: { parse: [] } } });
    assert.equal(discord.calls.length, 0);
  } finally {
    await t.server.close();
  }
});

test('work that outlasts the reply window is acknowledged as deferred, then edited in as a follow-up', async () => {
  const discord = fakeDiscord();
  let finish: (text: string) => void = () => undefined;
  const slow = new Promise<string>((resolve) => (finish = resolve));
  const t = await startTestServer(working(() => slow), { fetch: discord.fetch, replyBudgetMs: 30 });
  try {
    const body = commandInteraction('approve', { ids: 'MP-1' });
    const started = Date.now();
    const res = await t.post(body);
    assert.ok(Date.now() - started < 1500, 'the acknowledgement did not wait for the work');
    assert.deepEqual(res.body, { type: 5 });
    assert.equal(discord.calls.length, 0);

    finish('MP-1 A title: recorded');
    await until(() => discord.calls.length === 1, 'the follow-up');
    assert.deepEqual(discord.calls[0], {
      method: 'PATCH',
      url: `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${body.token as string}/messages/@original`,
      body: { content: 'MP-1 A title: recorded', allowed_mentions: { parse: [] } },
    });
    // The token is in the URL only: no log line carries it.
    assert.ok(!JSON.stringify(t.logs).includes(body.token as string));
  } finally {
    await t.server.close();
  }
});

test('a deferred answer for the invoking user alone carries the flag on the acknowledgement', async () => {
  const discord = fakeDiscord();
  const t = await startTestServer(working(() => new Promise((resolve) => setTimeout(() => resolve('late'), 80)), true), {
    fetch: discord.fetch,
    replyBudgetMs: 10,
  });
  try {
    const res = await t.post(commandInteraction('approve', { ids: 'MP-1' }));
    assert.deepEqual(res.body, { type: 5, data: { flags: 64 } });
    await until(() => discord.calls.length === 1, 'the follow-up');
  } finally {
    await t.server.close();
  }
});

test('work that throws is answered with a fixed sentence, inline or deferred, and the error is logged', async () => {
  const discord = fakeDiscord();
  const secret = ['internal', 'detail'].join('-');
  const quick = await startTestServer(working(async () => Promise.reject(new Error(secret))), { fetch: discord.fetch, replyBudgetMs: 500 });
  try {
    const res = await quick.post(commandInteraction('approve', { ids: 'MP-1' }));
    assert.equal(res.body.data.content, WORK_FAILED);
    assert.ok(quick.logs.some((entry) => entry.level === 'error' && (entry.fields.err as Error).message === secret));
  } finally {
    await quick.server.close();
  }
  const slow = await startTestServer(
    working(() => new Promise<string>((_, reject) => setTimeout(() => reject(new Error(secret)), 60))),
    { fetch: discord.fetch, replyBudgetMs: 10 },
  );
  try {
    assert.equal((await slow.post(commandInteraction('approve', { ids: 'MP-1' }))).body.type, 5);
    await until(() => discord.calls.length === 1, 'the follow-up');
    assert.equal(discord.calls[0].body.content, WORK_FAILED);
  } finally {
    await slow.server.close();
  }
});

test('a follow-up Discord answers 500 to is tried once more; a 404 is logged and dropped', async () => {
  const retried = fakeDiscord([500]);
  const a = await startTestServer(working(() => new Promise((resolve) => setTimeout(() => resolve('late'), 40))), {
    fetch: retried.fetch,
    replyBudgetMs: 5,
    followUpRetryMs: 5,
  });
  try {
    await a.post(commandInteraction('approve', { ids: 'MP-1' }));
    await until(() => retried.calls.length === 2, 'the second try');
  } finally {
    await a.server.close();
  }
  const gone = fakeDiscord([404]);
  const b = await startTestServer(working(() => new Promise((resolve) => setTimeout(() => resolve('late'), 40))), {
    fetch: gone.fetch,
    replyBudgetMs: 5,
    followUpRetryMs: 5,
  });
  try {
    await b.post(commandInteraction('approve', { ids: 'MP-1' }));
    await until(() => b.logs.some((entry) => entry.level === 'error' && entry.fields.status === 404), 'the refusal in the log');
    assert.equal(gone.calls.length, 1);
  } finally {
    await b.server.close();
  }
});

test('a long answer is cut to 2000 characters', async () => {
  const t = await startTestServer(working(async () => 'x'.repeat(2500)), { replyBudgetMs: 500 });
  try {
    const res = await t.post(commandInteraction('approve', { ids: 'MP-1' }));
    assert.equal(res.body.data.content.length, 2000);
  } finally {
    await t.server.close();
  }
});

test('closing with a drain waits for a follow-up still on its way', async () => {
  const discord = fakeDiscord();
  const t = await startTestServer(working(() => new Promise((resolve) => setTimeout(() => resolve('late'), 150))), {
    fetch: discord.fetch,
    replyBudgetMs: 10,
  });
  await t.post(commandInteraction('approve', { ids: 'MP-1' }));
  assert.equal(discord.calls.length, 0);
  await t.server.close(5000);
  assert.equal(discord.calls.length, 1);
});
