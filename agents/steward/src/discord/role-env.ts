import { isDiscordPublicKey } from './signature.js';

/**
 * What the Discord role's environment must hold, and must not.
 *
 * The role decides nothing by itself; a verdict is as trustworthy as this
 * service's environment. So the start is strict in both directions: it refuses
 * without the values it needs, and it refuses beside a credential it has no
 * use for. Errors name variables, never values.
 *
 * Pure: the entry point and the tests both call it with an environment.
 */

export const DISCORD_PUBLIC_KEY_ENV = 'STEWARD_DISCORD_PUBLIC_KEY';
export const DISCORD_OWNER_ID_ENV = 'STEWARD_DISCORD_OWNER_ID';
export const DISCORD_APPLICATION_ID_ENV = 'STEWARD_DISCORD_APPLICATION_ID';
export const DISCORD_BOT_TOKEN_ENV = 'STEWARD_DISCORD_BOT_TOKEN';

/**
 * Each has a reason:
 *
 * - the public key verifies Discord's signature on every request;
 * - the owner id is the one user whose commands are taken;
 * - the three Temporal values reach the namespace that holds the finding runs.
 *   All three, with no local default: this role only ever runs hosted.
 */
export const DISCORD_ROLE_REQUIRED: readonly string[] = [
  DISCORD_PUBLIC_KEY_ENV,
  DISCORD_OWNER_ID_ENV,
  'TEMPORAL_ADDRESS',
  'TEMPORAL_NAMESPACE',
  'TEMPORAL_API_KEY',
];

/**
 * Credentials the role has no use for. It reads GitHub through the hosted
 * worker (`finding-resolver.ts`), so it holds no GitHub credential of any kind.
 * The bot token registers the commands from the owner's machine; with it in
 * this environment, the service could change its own commands.
 */
export const DISCORD_ROLE_REFUSED: readonly string[] = [
  DISCORD_BOT_TOKEN_ENV,
  'STEWARD_GITHUB_APP_ID',
  'STEWARD_GITHUB_APP_PRIVATE_KEY',
  'STEWARD_GITHUB_APP_INSTALLATION_ID',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ANTHROPIC_API_KEY',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  'STEWARD_WEB_BOT_AUTH_KEY',
  'TEMPORAL_METRICS_API_KEY',
  'TEMPORAL_READ_ONLY_API_KEY',
];

export interface DiscordRoleConfig {
  /** The application's public key, hex. */
  publicKey: string;
  ownerId: string;
  port: number;
}

const DEFAULT_PORT = 8080;
const ROLE = 'STEWARD_WORKER_ROLE=discord';

/** The role's settings, or a refusal that names each variable at fault. */
export function readDiscordRoleEnvironment(env: Record<string, string | undefined>): DiscordRoleConfig {
  const set = (name: string) => (env[name] ?? '').trim() !== '';
  const missing = DISCORD_ROLE_REQUIRED.filter((name) => !set(name));
  if (missing.length > 0) {
    throw new Error(
      `${ROLE} refuses to start: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        "Set each in this service's environment and redeploy.",
    );
  }
  const present = DISCORD_ROLE_REFUSED.filter(set);
  if (present.length > 0) {
    throw new Error(
      `${ROLE} refuses to start: ${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set. ` +
        "The Discord service holds its Temporal key and nothing else that is secret: no GitHub credential, no bot token. " +
        "Remove the variable from this service's environment and redeploy.",
    );
  }
  const publicKey = (env[DISCORD_PUBLIC_KEY_ENV] as string).trim();
  if (!isDiscordPublicKey(publicKey)) {
    throw new Error(`${ROLE} refuses to start: ${DISCORD_PUBLIC_KEY_ENV} is not 64 hexadecimal characters, the form the Developer Portal shows.`);
  }
  const ownerId = (env[DISCORD_OWNER_ID_ENV] as string).trim();
  if (!/^\d{15,22}$/.test(ownerId)) {
    throw new Error(`${ROLE} refuses to start: ${DISCORD_OWNER_ID_ENV} is not a Discord user id, which is 15 to 22 digits.`);
  }
  const rawPort = (env.PORT ?? '').trim();
  const port = rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${ROLE} refuses to start: PORT is not a port number.`);
  }
  return { publicKey, ownerId, port };
}
