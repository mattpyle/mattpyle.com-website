import { DefaultLogger, Runtime, type LogEntry, type LogLevel } from '@temporalio/worker';
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

/**
 * Installs the Runtime once for this process: SDK, workflow and activity logs go
 * to pino, and Core logs are forwarded at WARN.
 */
export function installTemporalRuntime(): Runtime {
  return Runtime.install({
    logger: temporalLogger(),
    telemetryOptions: {
      logging: {
        filter: { core: 'WARN', other: 'WARN' },
        forward: {},
      },
    },
  });
}
