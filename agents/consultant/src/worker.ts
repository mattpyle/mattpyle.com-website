/**
 * The audit consultant's worker. Reads everything from the environment (src/config.ts) and starts
 * nothing when a required value is missing: it names the missing variables, never a value, and
 * exits non-zero.
 *
 *   npm start -w @mattpyle/consultant
 */
import { fileURLToPath } from 'node:url';
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AgentHarnessPlugin } from '@temporalio/agent-harness-worker';
import { StrandsPlugin } from '@temporalio/agent-harness-worker/ai-sdks/strands-agents';
import { harnessObserverFactory } from '@temporalio/agent-harness-worker/ai-sdks/strands-agents-harness';
import { createActivities } from './activities.js';
import { MODEL } from './names.js';
import { readConfig, type Config } from './config.js';
import { bundlerOptions } from './sdk-compat.js';
import { mcpSiteClient } from './site.js';

export const workflowsPath = fileURLToPath(new URL('./agent.ts', import.meta.url));

/** The model factory: Claude with prompt caching on, since every call resends prompt and tools. */
export function claudeModel(config: Pick<Config, 'model' | 'anthropicApiKey' | 'caps'>) {
  return () =>
    new AnthropicModel({
      modelId: config.model,
      apiKey: config.anthropicApiKey,
      maxTokens: config.caps.maxOutputTokens,
      cacheConfig: { strategy: 'anthropic' },
    });
}

async function main(): Promise<number> {
  const result = readConfig(process.env);
  if (!result.ok) {
    console.error(`audit-consultant worker not started:\n  ${result.problems.join('\n  ')}`);
    return 1;
  }
  const config = result.config;
  const { address, namespace, apiKey } = config.temporal;
  const tls = apiKey !== undefined;

  const connection = await NativeConnection.connect({ address, tls, apiKey });
  const clientConnection = await Connection.connect({ address, tls, apiKey });
  const client = new Client({ connection: clientConnection, namespace });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: config.taskQueue,
    workflowsPath,
    bundlerOptions,
    activities: createActivities({ site: mcpSiteClient(config.mcpUrl), caps: config.caps, client }),
    plugins: [
      new StrandsPlugin({ models: { [MODEL]: claudeModel(config) }, observerFactory: harnessObserverFactory }),
      new AgentHarnessPlugin(),
    ],
  });
  console.log(
    `audit-consultant worker up: namespace=${namespace} queue=${config.taskQueue} model=${config.model} ` +
      `mcp=${config.mcpUrl.origin} pid=${process.pid}`,
  );
  await worker.run();
  await clientConnection.close();
  await connection.close();
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
