import { Client, Connection } from '@temporalio/client';
import { IS_TEMPORAL_CLOUD, NAMESPACE, QUEUE_FINDINGS, TEMPORAL_ADDRESS, temporalConnectionOptions } from '../config.js';
import { sendFindingVerdict } from '../lib/finding-verdict.js';
import { log } from '../lib/logger.js';
import { commandHandler } from './commands.js';
import { createFindingResolver } from './finding-resolver.js';
import { firstHandler } from './interactions.js';
import { readDiscordRoleEnvironment } from './role-env.js';
import { INTERACTIONS_PATH, startDiscordServer } from './server.js';
import { discordPublicKey } from './signature.js';
import { verdictCommands } from './verdict-commands.js';

/**
 * The Discord role of the hosted image (`STEWARD_WORKER_ROLE=discord`): the
 * Interactions Endpoint of Steward's Discord application.
 *
 * No worker, no workflow bundle, no browser, no GitHub credential. It holds a
 * Temporal client for the namespace with the finding runs, and an HTTP
 * listener. A slash command arrives as a request Discord signed; the service
 * checks the signature and the invoking user, asks the hosted worker which
 * findings the ids name (`finding-resolver.ts`), and sends the verdict as the
 * `record-verdict` Update through `sendFindingVerdict`, the same call the CLI
 * and the console make.
 *
 * `hosted-entry.ts` loads this file; it starts itself.
 *
 * To add a command, add an entry to a `SlashCommand` list and pass it to
 * `commandHandler`. To take buttons, add an `InteractionHandler` to the
 * `firstHandler` list. Neither touches `server.ts` or `signature.ts`.
 */

/** How long a redeploy waits for answers still on their way to Discord. */
const DRAIN_MS = 20_000;

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandled rejection: logged, not fatal');
});

async function main(): Promise<void> {
  // First: nothing connects anywhere from a misconfigured environment.
  const config = readDiscordRoleEnvironment(process.env);

  const connection = await Connection.connect(temporalConnectionOptions());
  const client = new Client({ connection, namespace: NAMESPACE });

  const commands = verdictCommands({
    resolve: createFindingResolver({ client, taskQueue: QUEUE_FINDINGS }),
    // The flag came with the lookup, so the verdict's own GitHub read is never made here.
    sendVerdict: (request, autoFix) => sendFindingVerdict(request, { client, readAutoFix: async () => autoFix }),
    onError: (err, entry) => log.error({ err, site: entry?.site, key: entry?.key }, 'discord command failed'),
  });

  const server = await startDiscordServer({
    port: config.port,
    publicKey: discordPublicKey(config.publicKey),
    ownerId: config.ownerId,
    handler: firstHandler([commandHandler(commands)]),
    log,
  });

  log.info(
    {
      role: 'discord',
      port: server.port,
      path: INTERACTIONS_PATH,
      commands: commands.map((command) => command.definition.name),
      namespace: NAMESPACE,
      address: TEMPORAL_ADDRESS,
      service: IS_TEMPORAL_CLOUD ? 'temporal-cloud' : 'local-dev-server',
      resolver: `standalone activity on ${QUEUE_FINDINGS}`,
      github: 'none (discord role)',
    },
    'steward discord service listening',
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'steward discord service draining');
    void server
      .close(DRAIN_MS)
      .then(() => connection.close())
      .catch((err: unknown) => log.error({ err }, 'discord service did not stop cleanly'))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'discord service exited');
  process.exit(1);
});
