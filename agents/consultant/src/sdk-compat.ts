/**
 * A shim for one incompatibility between `@temporalio/agent-harness` 0.5.0 and the Temporal SDK
 * 1.25.0 this repository pins.
 *
 * The harness imports `@temporalio/common/lib/time.js` (four imports). From 1.25.0,
 * `@temporalio/common` maps `./lib/*` to `./lib/*.js`, so that specifier resolves to
 * `lib/time.js.js` and fails to load. The same module is exported as `@temporalio/common/time`.
 *
 * Two places resolve it, and both are redirected here:
 * 1. Node, for the worker process: `register()` installs a synchronous resolve hook. It must run
 *    before the harness loads, so the start and test scripts load this file with `--import`.
 * 2. Webpack, for the workflow bundle: `bundlerOptions` adds the same alias.
 *
 * Delete this file when a harness release imports `@temporalio/common/time`.
 */
import { registerHooks } from 'node:module';
import type { WorkerOptions } from '@temporalio/worker';

type BundlerOptions = NonNullable<WorkerOptions['bundlerOptions']>;

export const BROKEN_SPECIFIER = '@temporalio/common/lib/time.js';
export const FIXED_SPECIFIER = '@temporalio/common/time';

let registered = false;

export function register(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, next) {
      return next(specifier === BROKEN_SPECIFIER ? FIXED_SPECIFIER : specifier, context);
    },
  });
}

/** For `Worker.create({ bundlerOptions })` and `Worker.runReplayHistory`. */
export const bundlerOptions: BundlerOptions = {
  webpackConfigHook: (config) => {
    const resolve = (config.resolve ??= {});
    const alias = Array.isArray(resolve.alias) ? {} : (resolve.alias ?? {});
    // A trailing `$` makes the alias an exact match.
    resolve.alias = { ...alias, [`${BROKEN_SPECIFIER}$`]: FIXED_SPECIFIER };
    return config;
  },
};

register();
