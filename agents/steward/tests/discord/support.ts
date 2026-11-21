import crypto from 'node:crypto';
import { discordPublicKey } from '../../src/discord/signature.js';
import { startDiscordServer, INTERACTIONS_PATH, type DiscordServer, type DiscordServerOptions } from '../../src/discord/server.js';
import type { InteractionHandler } from '../../src/discord/interactions.js';

/**
 * What the Discord tests share: a throwaway application key pair made at run
 * time, a request signed the way Discord signs one, and a server on a free port.
 */

export const OWNER_ID = '100000000000000001';
export const STRANGER_ID = '100000000000000002';
export const APPLICATION_ID = '200000000000000001';

export interface TestApplication {
  /** The public key as the Developer Portal shows it: hex. */
  publicKeyHex: string;
  sign(timestamp: string, body: string): string;
}

export function testApplication(): TestApplication {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyHex = Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url').toString('hex');
  return {
    publicKeyHex,
    sign: (timestamp, body) => crypto.sign(null, Buffer.from(timestamp + body, 'utf8'), privateKey).toString('hex'),
  };
}

let sequence = 0;

/** A slash command interaction as Discord sends one from a server. */
export function commandInteraction(name: string, options: Record<string, string>, userId = OWNER_ID): Record<string, unknown> {
  sequence++;
  return {
    id: String(300000000000000000n + BigInt(sequence)),
    application_id: APPLICATION_ID,
    type: 2,
    // Not a secret: a label the fake Discord reads back out of the follow-up's path.
    token: ['interaction', 'token', String(sequence)].join('-'),
    guild_id: '400000000000000001',
    member: { user: { id: userId } },
    data: { type: 1, name, options: Object.entries(options).map(([key, value]) => ({ type: 3, name: key, value })) },
  };
}

export interface Posted {
  status: number;
  body: any;
}

export interface TestServer {
  server: DiscordServer;
  app: TestApplication;
  logs: { level: string; fields: Record<string, unknown>; message: string }[];
  /** Posts `body`, signed now unless `headers` says otherwise. */
  post(body: unknown, overrides?: { signature?: string | null; timestamp?: string | null; raw?: string }): Promise<Posted>;
  url: string;
}

export async function startTestServer(
  handler: InteractionHandler,
  options: Partial<DiscordServerOptions> = {},
  app: TestApplication = testApplication(),
): Promise<TestServer> {
  const logs: TestServer['logs'] = [];
  const record = (level: string) => (fields: Record<string, unknown>, message: string) => void logs.push({ level, fields, message });
  const server = await startDiscordServer({
    port: 0,
    host: '127.0.0.1',
    publicKey: discordPublicKey(app.publicKeyHex),
    ownerId: OWNER_ID,
    handler,
    log: { info: record('info'), warn: record('warn'), error: record('error') },
    ...options,
  });
  const url = `http://127.0.0.1:${server.port}${INTERACTIONS_PATH}`;
  const clock = options.now ?? (() => new Date());
  return {
    server,
    app,
    logs,
    url,
    async post(body, overrides = {}) {
      const raw = overrides.raw ?? JSON.stringify(body);
      const timestamp = overrides.timestamp === undefined ? String(Math.floor(clock().getTime() / 1000)) : overrides.timestamp;
      const signature = overrides.signature === undefined ? app.sign(timestamp ?? '', raw) : overrides.signature;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (signature !== null) headers['x-signature-ed25519'] = signature;
      if (timestamp !== null) headers['x-signature-timestamp'] = timestamp;
      const res = await fetch(url, { method: 'POST', headers, body: raw });
      const text = await res.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Left as text.
      }
      return { status: res.status, body: parsed };
    },
  };
}

/** A fake Discord API: records each follow-up and answers with the scripted statuses, then 200. */
export function fakeDiscord(statuses: number[] = []): { fetch: typeof fetch; calls: { method: string; url: string; body: any }[] } {
  const calls: { method: string; url: string; body: any }[] = [];
  const send = (async (input: any, init?: RequestInit) => {
    calls.push({ method: String(init?.method ?? 'GET'), url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response('{}', { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { fetch: send, calls };
}

/** Resolves once `ready` is true, or fails after two seconds. */
export async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
