import { DefaultLogger, Runtime, type LogEntry, type LogLevel, type RuntimeOptions } from '@temporalio/worker';
import type { Logger } from 'pino';
import { log } from './logger.js';

/**
 * The Temporal SDK's Runtime logger, handed to the worker's own pino logger
 * (STW-549).
 *
 * ## Why this exists
 *
 * With no Runtime logger installed, the SDK writes every entry at INFO and above
 * to stderr, with the metadata object formatted over many lines. Railway tags
 * everything on stderr as `error`, so the recheck's first scheduled run
 * (2026-11-08) came out as about sixty error-level lines, one per field of a
 * result object. The same entries, handed to pino, are one JSON line each on
 * stdout, with the SDK's level mapped to pino's.
 *
 * ## What reaches pino
 *
 * Workflow logs (`workflow.log`), activity logs (`Context.log`) and the SDK
 * worker's own lifecycle lines reach the Runtime logger directly. The Core
 * library's native logs reach it only when forwarding is on, and are filtered at
 * WARN there, so the Core's INFO chatter (poller start-up, task counts) never
 * reaches the deploy log.
 *
 * ## Where it is installed
 *
 * `installTemporalRuntime` runs once per process, in each worker entry point,
 * before `Worker.create`. `Runtime.install` throws on a second call, and the
 * test environment installs a Runtime of its own, so no module a test imports
 * calls it. This file has no side effect at import for that reason.
 */

/** pino's method for each SDK level. Same names, lower-cased. */
const METHOD: Record<LogLevel, 'trace' | 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

/**
 * Writes one SDK log entry as one pino line. The SDK's metadata (`sdkComponent`,
 * `workflowId`, `runId`, `taskQueue` and the rest) sits on the line as fields.
 */
export function bridgeLogEntry(entry: LogEntry, sink: Pick<Logger, 'trace' | 'debug' | 'info' | 'warn' | 'error'> = log): void {
  sink[METHOD[entry.level]]({ ...entry.meta }, entry.message);
}

/** A Runtime logger that hands INFO and above to `sink`. */
export function temporalLogger(sink?: Parameters<typeof bridgeLogEntry>[1]): DefaultLogger {
  return new DefaultLogger('INFO', (entry) => bridgeLogEntry(entry, sink));
}

export type WorkerKind = 'hosted' | 'local';

/** The three variables that switch SDK metrics on. All three, or none. */
const METRICS_URL_VAR = 'STEWARD_METRICS_OTLP_URL';
const METRICS_USER_VAR = 'STEWARD_METRICS_OTLP_USER';
const METRICS_TOKEN_VAR = 'STEWARD_METRICS_OTLP_TOKEN';
const METRICS_PATH_END = '/v1/metrics';

type TelemetryMetrics = NonNullable<NonNullable<RuntimeOptions['telemetryOptions']>['metrics']>;

/**
 * SDK metrics over OTLP/HTTP to Grafana Cloud (STW-552, stage 2).
 *
 * All three variables set means on; any unset means off and returns `undefined`.
 * A URL that is set but is not an `https` URL ending `/v1/metrics` throws, naming
 * the variable and its host only: Grafana's screen shows a base ending `/otlp`,
 * and the SDK needs the full path. The basic-auth header is built here from the
 * user and the token and is never written to a message.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, when set in the process, overrides the URL
 * inside the SDK; `sdkMetricsState` reports that on the ready line.
 *
 * When the gateway is unreachable the Core logs an ERROR line per failed export
 * (one a minute at this interval) and the worker keeps running. That line is not
 * a Steward fault.
 */
export function sdkMetricsOptions(
  env: Record<string, string | undefined>,
  worker: WorkerKind,
): TelemetryMetrics | undefined {
  const url = env[METRICS_URL_VAR] ?? '';
  const user = env[METRICS_USER_VAR] ?? '';
  const token = env[METRICS_TOKEN_VAR] ?? '';
  if (!url || !user || !token) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${METRICS_URL_VAR} is not a URL; it must end ${METRICS_PATH_END}, such as ${EXAMPLE_URL}`);
  }
  if (parsed.protocol !== 'https:' || !parsed.pathname.endsWith(METRICS_PATH_END)) {
    throw new Error(
      `${METRICS_URL_VAR} must be an https URL that ends ${METRICS_PATH_END}, such as ${EXAMPLE_URL} ` +
        `(host given: ${parsed.host})`,
    );
  }

  return {
    globalTags: { worker },
    otel: {
      url,
      http: true,
      headers: { authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` },
      metricsExportInterval: '60s',
      useSecondsForDurations: true,
      temporality: 'cumulative',
    },
  };
}

const EXAMPLE_URL = 'https://otlp-gateway-<region>.grafana.net/otlp/v1/metrics';

/** The ready line's `sdkMetrics` value. Honest about an override of the URL. */
export function sdkMetricsState(env: Record<string, string | undefined>): string {
  if (!env[METRICS_URL_VAR] || !env[METRICS_USER_VAR] || !env[METRICS_TOKEN_VAR]) return 'OFF';
  return env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? 'configured (OTEL_EXPORTER_OTLP_ENDPOINT overrides the URL)'
    : 'configured';
}

/**
 * Installs the Runtime once for this process: SDK, workflow and activity logs go
 * to pino, Core logs are forwarded at WARN, and SDK metrics go to Grafana Cloud
 * when `sdkMetricsOptions` says so.
 */
export function installTemporalRuntime(worker: WorkerKind, env: Record<string, string | undefined> = process.env): Runtime {
  const metrics = sdkMetricsOptions(env, worker);
  return Runtime.install({
    logger: temporalLogger(),
    telemetryOptions: {
      logging: {
        filter: { core: 'WARN', other: 'WARN' },
        forward: {},
      },
      ...(metrics ? { metrics } : {}),
    },
  });
}
