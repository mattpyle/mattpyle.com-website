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

/** The slice of the SDK meter the sampler uses. A test passes a fake. */
export type ProcessMeter = Pick<Runtime['metricMeter'], 'createGauge' | 'createCounter' | 'withTags'>;

/** What one tick reads from the process. */
export interface ProcessReading {
  rssBytes: number;
  heapUsedBytes: number;
  /** Cumulative CPU time since the process started, in microseconds. */
  cpuUserMicros: number;
  cpuSystemMicros: number;
}

/** What one tick records, and the state the next tick needs. */
export interface ProcessSample {
  rssBytes: number;
  heapUsedBytes: number;
  /** Whole milliseconds of CPU since the previous tick. */
  cpuUserMs: number;
  cpuSystemMs: number;
  /** Microseconds not yet reported, carried to the next tick. */
  carry: { userMicros: number; systemMicros: number };
}

export function readProcess(): ProcessReading {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system };
}

/**
 * Turns two readings into one sample (STW-604). Gauges are the reading as read.
 * The CPU counter takes whole milliseconds, so the sub-millisecond remainder is
 * carried to the next tick instead of being lost. `prev` is the previous reading
 * (`undefined` on the first tick: the first tick reports all CPU time so far).
 * A reading that goes backwards is clamped to zero.
 */
export function sampleProcess(
  now: ProcessReading,
  prev: ProcessReading | undefined,
  carry: ProcessSample['carry'] = { userMicros: 0, systemMicros: 0 },
): ProcessSample {
  const user = Math.max(0, now.cpuUserMicros - (prev?.cpuUserMicros ?? 0)) + carry.userMicros;
  const system = Math.max(0, now.cpuSystemMicros - (prev?.cpuSystemMicros ?? 0)) + carry.systemMicros;
  return {
    rssBytes: now.rssBytes,
    heapUsedBytes: now.heapUsedBytes,
    cpuUserMs: Math.floor(user / 1000),
    cpuSystemMs: Math.floor(system / 1000),
    carry: { userMicros: user % 1000, systemMicros: system % 1000 },
  };
}

const PROCESS_METRICS_INTERVAL_MS = 60_000;

let processMetricsStop: (() => void) | undefined;

/**
 * Exports the worker process's own memory and CPU beside the SDK metrics
 * (STW-604, STW-603).
 *
 * ## Metric names
 *
 * Grafana's OTLP gateway appends the unit, so these show as:
 *
 * - `steward_process_resident_memory_bytes`: gauge, resident set size.
 * - `steward_process_heap_used_bytes`: gauge, V8 `heapUsed` of the main isolate.
 * - `steward_process_cpu_milliseconds_total`: counter, label `mode` = `user` or `system`.
 *
 * Every series carries `worker_kind` = `hosted` or `local`, the same value as the
 * SDK's `worker` global tag. That tag lands on `target_info`, not on each series,
 * so the series carry their own.
 *
 * ## Why the SDK's meter
 *
 * `Runtime.metricMeter` rides the export the Runtime already has: no new package,
 * variable or endpoint. The Metric API is marked Experimental in the SDK; checked
 * against `@temporalio/worker` 1.20.3. A rename in a later SDK breaks this at
 * `tsc`, not at run time.
 *
 * ## What it does not cover
 *
 * `heap_used` is the main isolate's heap. Workflows run in the SDK's worker
 * thread, so the workflow cache is outside it (STW-602 measured that). Resident
 * memory is the whole process, and the figure that tracks the Railway bill.
 *
 * ## Behaviour
 *
 * - Samples once at start, then every 60 seconds (the export interval). A process
 *   that lives under a minute still leaves one reading.
 * - The timer is `unref`ed and is not the recycle timer in `worker-hosted.ts`.
 * - A throw from the process read, the meter or a gauge is caught and logged once
 *   at WARN. Later failures stay silent. A metric never hurts the worker.
 * - One sampler per process: a second call returns the first one's stop function.
 */
export function startProcessMetrics(
  meter: ProcessMeter,
  worker: WorkerKind,
  read: () => ProcessReading = readProcess,
  sink: Pick<Logger, 'warn'> = log,
): () => void {
  if (processMetricsStop) return processMetricsStop;

  const tagged = meter.withTags({ worker_kind: worker });
  const rss = tagged.createGauge('steward_process_resident_memory', 'int', 'bytes', 'Resident set size of the worker process');
  const heap = tagged.createGauge('steward_process_heap_used', 'int', 'bytes', 'V8 heap used by the main isolate (not the workflow worker thread)');
  const cpu = tagged.createCounter('steward_process_cpu', 'ms', 'CPU time used by the worker process');

  let prev: ProcessReading | undefined;
  let carry: ProcessSample['carry'] | undefined;
  let warned = false;

  const tick = () => {
    try {
      const now = read();
      const sample = sampleProcess(now, prev, carry);
      prev = now;
      carry = sample.carry;
      rss.set(sample.rssBytes);
      heap.set(sample.heapUsedBytes);
      cpu.add(sample.cpuUserMs, { mode: 'user' });
      cpu.add(sample.cpuSystemMs, { mode: 'system' });
    } catch (err) {
      if (warned) return;
      warned = true;
      sink.warn({ err }, 'process metrics sample failed; further failures are not logged');
    }
  };

  tick();
  const timer = setInterval(tick, PROCESS_METRICS_INTERVAL_MS);
  timer.unref();
  processMetricsStop = () => {
    clearInterval(timer);
    processMetricsStop = undefined;
  };
  return processMetricsStop;
}

/**
 * Installs the Runtime once for this process: SDK, workflow and activity logs go
 * to pino, Core logs are forwarded at WARN, and SDK metrics go to Grafana Cloud
 * when `sdkMetricsOptions` says so. The same condition starts the process
 * metrics sampler, once, here: the hosted entry point builds three workers on
 * this one Runtime and calls this function once.
 */
export function installTemporalRuntime(worker: WorkerKind, env: Record<string, string | undefined> = process.env): Runtime {
  const metrics = sdkMetricsOptions(env, worker);
  const runtime = Runtime.install({
    logger: temporalLogger(),
    telemetryOptions: {
      logging: {
        filter: { core: 'WARN', other: 'WARN' },
        forward: {},
      },
      ...(metrics ? { metrics } : {}),
    },
  });
  if (metrics) startProcessMetrics(runtime.metricMeter, worker);
  return runtime;
}
