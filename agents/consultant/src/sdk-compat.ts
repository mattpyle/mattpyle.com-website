/**
 * A shim for one incompatibility between `@temporalio/agent-harness` 0.5.0 and the Temporal SDK
 * 1.25.0 this repository pins.
 *
 * The harness imports `@temporalio/common/lib/time.js` at runtime in two places, and as a type in
 * two more. From 1.25.0, `@temporalio/common` maps `./lib/*` to `./lib/*.js`, so that specifier
 * resolves to `lib/time.js.js` and fails to load. The same module is exported as
 * `@temporalio/common/time`. The type imports are erased at runtime; `skipLibCheck` hides them
 * from the typecheck.
 *
 * Two places resolve it, and both are redirected here, for that one exact specifier only:
 * 1. Node, for the worker process: `register()` installs a synchronous resolve hook. It must run
 *    before the harness loads, so the start and test scripts and the Dockerfile load this file
 *    with `--import`.
 * 2. Webpack, for the workflow bundle: `bundlerOptions` adds the same alias as an exact match.
 *
 * `SHIM_WRITTEN_FOR` is the harness version this was written against. `tests/sdk-compat.test.ts`
 * fails when the installed harness differs, so a harness upgrade has to decide whether this file
 * is still needed. Delete it when a harness release imports `@temporalio/common/time`.
 */
import { registerHooks } from 'node:module';
import type { WorkerOptions } from '@temporalio/worker';

type BundlerOptions = NonNullable<WorkerOptions['bundlerOptions']>;

export const SHIM_WRITTEN_FOR = '0.5.0';
export const BROKEN_SPECIFIER = '@temporalio/common/lib/time.js';
export const FIXED_SPECIFIER = '@temporalio/common/time';

/** The whole rewrite: the one broken specifier, and nothing else, by exact match. */
export function rewrite(specifier: string): string {
  return specifier === BROKEN_SPECIFIER ? FIXED_SPECIFIER : specifier;
}

let registered = false;

export function register(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, next) {
      return next(rewrite(specifier), context);
    },
  });
}

/** For `Worker.create({ bundlerOptions })`, `bundleWorkflowCode` and `Worker.runReplayHistory`. */
export const bundlerOptions: BundlerOptions = {
  webpackConfigHook: (config) => {
    const resolve = (config.resolve ??= {});
    if (Array.isArray(resolve.alias)) {
      resolve.alias = [...resolve.alias, { name: BROKEN_SPECIFIER, alias: FIXED_SPECIFIER, onlyModule: true }];
    } else {
      // A trailing `$` makes the alias an exact match.
      resolve.alias = { ...(resolve.alias ?? {}), [`${BROKEN_SPECIFIER}$`]: FIXED_SPECIFIER };
    }
    return config;
  },
};

register();
