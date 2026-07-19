import pino from 'pino';

const level = process.env.STEWARD_LOG_LEVEL ?? 'info';

/**
 * pino-pretty only when attached to a TTY. Under `node --test` and under the
 * Temporal test environment the transport worker keeps the process alive, so
 * plain JSON is the safer default there.
 */
export const log = pino(
  process.stdout.isTTY
    ? { level, transport: { target: 'pino-pretty', options: { colorize: true } } }
    : { level },
);

/** Times an activity body and logs start/end + duration (spec §8, general rules). */
export async function timed<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ result: T; startedAt: string; durationMs: number }> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  log.info({ activity: name }, 'activity start');
  try {
    const result = await fn();
    const durationMs = Date.now() - t0;
    log.info({ activity: name, durationMs }, 'activity end');
    return { result, startedAt, durationMs };
  } catch (err) {
    log.error({ activity: name, durationMs: Date.now() - t0, err }, 'activity failed');
    throw err;
  }
}
