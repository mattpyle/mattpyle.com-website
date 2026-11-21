import type crypto from 'node:crypto';
import http from 'node:http';
import {
  CallbackType,
  EPHEMERAL,
  InteractionType,
  clipContent,
  invokingUserId,
  type Interaction,
  type InteractionHandler,
  type InteractionMessage,
} from './interactions.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, TIMESTAMP_TOLERANCE_MS, refuseSignedRequest } from './signature.js';

/**
 * The Interactions Endpoint: the HTTP side of the Discord service.
 *
 * It knows the transport and nothing about findings. For each `POST` to
 * {@link INTERACTIONS_PATH}:
 *
 * 1. The signature and the timestamp are checked against the raw body, before
 *    the body is parsed. A failure answers 401.
 * 2. `PING` is answered with `PONG`.
 * 3. An interaction id seen before is refused.
 * 4. The invoking user must be the owner. Anyone else gets a refusal only they
 *    can see, and no handler runs.
 * 5. The handler says what to answer (`interactions.ts`).
 *
 * **The reply deadline.** Discord wants the first response within 3 seconds
 * and keeps the interaction's token for 15 minutes. Work that finishes inside
 * {@link REPLY_BUDGET_MS} is answered in the HTTP response. Otherwise the
 * response is a deferred acknowledgement, and the result is edited into it
 * afterwards with `PATCH /webhooks/<application_id>/<token>/messages/@original`.
 * That call is authorized by the token in its path, so the service holds no
 * Discord secret.
 *
 * Every message is sent with mentions switched off, since it can repeat what a
 * person typed. The interaction token and the request body are never logged.
 */

export const INTERACTIONS_PATH = '/discord/interactions';
export const HEALTH_PATH = '/healthz';

/** How long work may take and still be answered in the HTTP response; the rest of the 3 seconds is the network's. */
export const REPLY_BUDGET_MS = 2000;

export const DISCORD_API = 'https://discord.com/api/v10';

const MAX_BODY_BYTES = 64 * 1024;
/** One more try for a follow-up Discord answered 5xx or 429 to. */
const FOLLOW_UP_RETRY_MS = 1000;

export const NOT_OWNER = 'Only the owner of this Steward can use its commands.';
export const UNKNOWN_INTERACTION = 'Steward does not handle this command.';
export const WORK_FAILED = 'Steward could not complete the command. Its log has the error; nothing is assumed recorded.';

export interface DiscordServerLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DiscordServerOptions {
  port: number;
  /** Defaults to every interface: the platform's router reaches the container from outside it. */
  host?: string;
  publicKey: crypto.KeyObject;
  /** The one Discord user id whose commands are taken. */
  ownerId: string;
  handler: InteractionHandler;
  log: DiscordServerLog;
  replyBudgetMs?: number;
  timestampToleranceMs?: number;
  now?: () => Date;
  /** The follow-up's transport. */
  fetch?: typeof fetch;
  followUpRetryMs?: number;
}

export interface DiscordServer {
  port: number;
  /** Stops accepting requests, then waits up to `drainMs` for follow-ups still in flight. */
  close(drainMs?: number): Promise<void>;
}

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Refused(413, 'request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function messageData(message: InteractionMessage): Record<string, unknown> {
  return {
    content: clipContent(message.content),
    allowed_mentions: { parse: [] },
    ...(message.ephemeral ? { flags: EPHEMERAL } : {}),
  };
}

const TIMED_OUT = Symbol('timed out');

export async function startDiscordServer(options: DiscordServerOptions): Promise<DiscordServer> {
  const { log } = options;
  const now = options.now ?? (() => new Date());
  const budgetMs = options.replyBudgetMs ?? REPLY_BUDGET_MS;
  const toleranceMs = options.timestampToleranceMs ?? TIMESTAMP_TOLERANCE_MS;
  const send = options.fetch ?? fetch;
  const retryMs = options.followUpRetryMs ?? FOLLOW_UP_RETRY_MS;

  /** Interaction ids already taken, each until a request carrying it would be refused as stale anyway. */
  const seen = new Map<string, number>();
  const firstSight = (id: string): boolean => {
    const at = now().getTime();
    for (const [each, until] of seen) if (until < at) seen.delete(each);
    if (seen.has(id)) return false;
    seen.set(id, at + 2 * toleranceMs);
    return true;
  };

  /** Follow-ups not yet delivered, for the drain. */
  const pending = new Set<Promise<void>>();

  const followUp = async (interaction: Interaction, content: string): Promise<void> => {
    const url = `${DISCORD_API}/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`;
    const init = {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: clipContent(content), allowed_mentions: { parse: [] } }),
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      let status: number;
      try {
        status = (await send(url, init)).status;
      } catch (err) {
        status = 0;
        log.warn({ interactionId: interaction.id, attempt, err: err instanceof Error ? err.message : String(err) }, 'discord follow-up did not send');
      }
      if (status >= 200 && status < 300) return;
      const again = attempt === 1 && (status === 0 || status === 429 || status >= 500);
      if (!again) {
        log.error({ interactionId: interaction.id, status }, 'discord refused the follow-up; the answer was not delivered');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  };

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const reply = (res: http.ServerResponse, message: InteractionMessage) =>
    sendJson(res, 200, { type: CallbackType.CHANNEL_MESSAGE_WITH_SOURCE, data: messageData(message) });

  const interact = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const rawBody = await readBody(req);
    const refusal = refuseSignedRequest({
      publicKey: options.publicKey,
      signature: header(req, SIGNATURE_HEADER),
      timestamp: header(req, TIMESTAMP_HEADER),
      rawBody,
      now: now(),
      toleranceMs,
    });
    if (refusal) {
      log.warn({ refusal }, 'discord request refused');
      throw new Refused(401, 'invalid request signature');
    }

    let interaction: Interaction;
    try {
      interaction = JSON.parse(rawBody.toString('utf8')) as Interaction;
    } catch {
      throw new Refused(400, 'the body is not JSON');
    }
    if (typeof interaction !== 'object' || interaction === null) throw new Refused(400, 'the body is not an interaction');

    if (interaction.type === InteractionType.PING) {
      sendJson(res, 200, { type: CallbackType.PONG });
      return;
    }
    if (typeof interaction.id !== 'string' || typeof interaction.token !== 'string' || typeof interaction.application_id !== 'string') {
      throw new Refused(400, 'the interaction has no id, token or application id');
    }
    if (!firstSight(interaction.id)) {
      log.warn({ interactionId: interaction.id }, 'discord interaction seen before; refused');
      throw new Refused(409, 'interaction already received');
    }

    const userId = invokingUserId(interaction);
    if (userId !== options.ownerId) {
      log.warn({ interactionId: interaction.id, userId, command: interaction.data?.name }, 'discord interaction from another user; refused');
      reply(res, { content: NOT_OWNER, ephemeral: true });
      return;
    }

    const result = options.handler(interaction);
    if (!result) {
      reply(res, { content: UNKNOWN_INTERACTION, ephemeral: true });
      return;
    }
    if (result.kind === 'reply') {
      reply(res, result.message);
      return;
    }

    // The work, turned into the text to show whether it succeeds or throws.
    const work = result.run().catch((err: unknown) => {
      log.error({ interactionId: interaction.id, command: interaction.data?.name, err }, 'discord command failed');
      return WORK_FAILED;
    });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
    });
    const first = await Promise.race([work, late]);
    clearTimeout(timer);
    if (first !== TIMED_OUT) {
      log.info({ interactionId: interaction.id, command: interaction.data?.name, deferred: false }, 'discord command answered');
      reply(res, { content: first, ephemeral: result.ephemeral });
      return;
    }
    sendJson(res, 200, {
      type: CallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      ...(result.ephemeral ? { data: { flags: EPHEMERAL } } : {}),
    });
    const delivery = work
      .then((content) => followUp(interaction, content))
      .then(() => log.info({ interactionId: interaction.id, command: interaction.data?.name, deferred: true }, 'discord command answered'));
    pending.add(delivery);
    void delivery.finally(() => pending.delete(delivery));
  };

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === HEALTH_PATH && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok\n');
      return;
    }
    if (pathname !== INTERACTIONS_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, { error: 'POST only' });
      return;
    }
    interact(req, res).catch((err: unknown) => {
      if (!(err instanceof Refused)) log.error({ err }, 'discord request failed');
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, err instanceof Refused ? err.status : 500, { error: err instanceof Refused ? err.message : 'internal error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    async close(drainMs = 0) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Requests still waiting on their work keep their connection; idle ones go now.
      server.closeIdleConnections();
      if (drainMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainMs);
        });
        // `closed` first: a request inside its reply window adds its follow-up only once it defers.
        await Promise.race([closed.then(() => Promise.allSettled([...pending])), limit]);
        clearTimeout(timer);
      }
      server.closeAllConnections();
      await closed;
    },
  };
}
