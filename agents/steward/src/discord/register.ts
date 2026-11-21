import type { CommandDefinition } from './commands.js';
import { DISCORD_API } from './server.js';

/**
 * Registers the slash commands with Discord for one server (a "guild").
 *
 * One call: `PUT /applications/<application id>/guilds/<guild id>/commands`
 * replaces the application's whole command list in that server, so running it
 * again after a change is the update, and a command dropped from the code is
 * dropped there. Guild commands take effect at once.
 *
 * It runs on the owner's machine, through `steward discord register`, with the
 * application's bot token. The hosted service never holds that token.
 *
 * Without `apply` nothing is sent: the caller gets the request it would make.
 */

export interface RegisterOptions {
  applicationId: string;
  guildId: string;
  commands: readonly CommandDefinition[];
  /** False for a dry run. */
  apply: boolean;
  /** Needed only to apply. */
  botToken?: string;
  fetch?: typeof fetch;
}

export interface RegisterResult {
  method: 'PUT';
  url: string;
  body: readonly CommandDefinition[];
  applied: boolean;
  /** The names Discord answered with, when applied. */
  registered: string[];
}

const SNOWFLAKE = /^\d{15,22}$/;

export async function registerGuildCommands(options: RegisterOptions): Promise<RegisterResult> {
  if (!SNOWFLAKE.test(options.applicationId)) throw new Error('The application id is not a Discord id, which is 15 to 22 digits.');
  if (!SNOWFLAKE.test(options.guildId)) throw new Error('The guild id is not a Discord id, which is 15 to 22 digits.');
  const url = `${DISCORD_API}/applications/${options.applicationId}/guilds/${options.guildId}/commands`;
  const result: RegisterResult = { method: 'PUT', url, body: options.commands, applied: false, registered: [] };
  if (!options.apply) return result;
  if (!options.botToken) throw new Error('Applying needs the bot token.');

  const res = await (options.fetch ?? fetch)(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bot ${options.botToken}` },
    body: JSON.stringify(options.commands),
  });
  const text = await res.text();
  if (!res.ok) {
    // Discord's own message; it never repeats the token.
    throw new Error(`Discord answered ${res.status} to the registration: ${text.slice(0, 500)}`);
  }
  let listed: unknown = [];
  try {
    listed = JSON.parse(text);
  } catch {
    listed = [];
  }
  result.applied = true;
  result.registered = Array.isArray(listed) ? listed.map((command) => String((command as { name?: unknown }).name ?? '')) : [];
  return result;
}
