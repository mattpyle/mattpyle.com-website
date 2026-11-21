import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerGuildCommands } from '../../src/discord/register.js';
import { verdictCommandDefinitions } from '../../src/discord/verdict-commands.js';

/** Registering the commands for one server: a dry run sends nothing, and applying is one PUT. */

const APPLICATION_ID = '200000000000000001';
const GUILD_ID = '400000000000000001';
const URL = `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;

function fakeDiscord(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(status === 200 ? String(init?.body) : JSON.stringify({ message: 'Missing Access', code: 50001 }), { status });
  }) as typeof fetch;
  return { send, calls };
}

test('a dry run sends nothing and returns the request it would make', async () => {
  const { send, calls } = fakeDiscord();
  const commands = verdictCommandDefinitions();
  const result = await registerGuildCommands({ applicationId: APPLICATION_ID, guildId: GUILD_ID, commands, apply: false, fetch: send });
  assert.equal(calls.length, 0);
  assert.deepEqual(result, { method: 'PUT', url: URL, body: commands, applied: false, registered: [] });
});

test('applying is one PUT of both commands with the bot token', async () => {
  const { send, calls } = fakeDiscord();
  const token = ['bot', 'token', 'stand', 'in'].join('-');
  const result = await registerGuildCommands({
    applicationId: APPLICATION_ID,
    guildId: GUILD_ID,
    commands: verdictCommandDefinitions(),
    apply: true,
    botToken: token,
    fetch: send,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bot ${token}`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).map((command: { name: string }) => command.name), ['approve', 'reject']);
  assert.equal(result.applied, true);
  assert.deepEqual(result.registered, ['approve', 'reject']);
});

test("a refusal from Discord is an error with Discord's message and without the token", async () => {
  const { send } = fakeDiscord(403);
  const token = ['bot', 'token', 'stand', 'in'].join('-');
  await assert.rejects(
    registerGuildCommands({ applicationId: APPLICATION_ID, guildId: GUILD_ID, commands: verdictCommandDefinitions(), apply: true, botToken: token, fetch: send }),
    (err: Error) => /Discord answered 403/.test(err.message) && /Missing Access/.test(err.message) && !err.message.includes(token),
  );
});

test('an id that is not a Discord id, or applying with no token, fails before any request', async () => {
  const { send, calls } = fakeDiscord();
  const base = { applicationId: APPLICATION_ID, guildId: GUILD_ID, commands: verdictCommandDefinitions(), fetch: send };
  await assert.rejects(registerGuildCommands({ ...base, guildId: 'my-server', apply: false }), /guild id/);
  await assert.rejects(registerGuildCommands({ ...base, applicationId: '../x', apply: false }), /application id/);
  await assert.rejects(registerGuildCommands({ ...base, apply: true }), /bot token/);
  assert.equal(calls.length, 0);
});
