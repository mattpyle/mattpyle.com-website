/**
 * The worker's settings, all from the environment. `readConfig` returns the problems instead of
 * throwing, and names variables only, never a value, so its output is safe to log.
 */
import { capsFromEnv, type Caps } from './caps.js';

export const DEFAULT_TASK_QUEUE = 'audit-consultant';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_MCP_URL = 'https://www.mattpyle.com/mcp';

export interface Config {
  temporal: { address: string; namespace: string; apiKey: string | undefined };
  taskQueue: string;
  model: string;
  anthropicApiKey: string;
  mcpUrl: URL;
  caps: Caps;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

export function readConfig(env: Record<string, string | undefined>): ConfigResult {
  const problems: string[] = [];
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is not set`);
    return v ?? '';
  };

  // No defaults for where the worker connects: the namespace is the deploy's decision alone.
  const address = need('TEMPORAL_ADDRESS');
  const namespace = need('TEMPORAL_NAMESPACE');
  const anthropicApiKey = need('ANTHROPIC_API_KEY');

  let mcpUrl: URL | undefined;
  const rawUrl = env.CONSULTANT_MCP_URL?.trim() || DEFAULT_MCP_URL;
  try {
    mcpUrl = new URL(rawUrl);
    if (mcpUrl.protocol !== 'https:') problems.push('CONSULTANT_MCP_URL must be an https: URL');
  } catch {
    problems.push('CONSULTANT_MCP_URL is not a URL');
  }

  let caps: Caps | undefined;
  try {
    caps = capsFromEnv(env);
  } catch (err) {
    problems.push(`a CONSULTANT_CAP_ value is invalid: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`);
  }

  if (problems.length > 0 || !mcpUrl || !caps) return { ok: false, problems };
  return {
    ok: true,
    config: {
      temporal: { address, namespace, apiKey: env.TEMPORAL_API_KEY?.trim() || undefined },
      taskQueue: env.CONSULTANT_TASK_QUEUE?.trim() || DEFAULT_TASK_QUEUE,
      model: env.CONSULTANT_MODEL?.trim() || DEFAULT_MODEL,
      anthropicApiKey,
      mcpUrl,
      caps,
    },
  };
}
