/**
 * One local Temporal dev server and one worker per test file, with the scripted model and a stub
 * site. No model call and no site call: the only network use is the dev-server binary download on
 * a cold cache, which CI restores from the same cache entry as Steward's suites.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { AgentHarnessPlugin } from '@temporalio/agent-harness-worker';
import { StrandsPlugin } from '@temporalio/agent-harness-worker/ai-sdks/strands-agents';
import { harnessObserverFactory } from '@temporalio/agent-harness-worker/ai-sdks/strands-agents-harness';
import { createActivities, type ConsultantActivities } from '../../src/activities.js';
import { DEFAULT_CAPS, type Caps } from '../../src/caps.js';
import { MODEL } from '../../src/names.js';
import { bundlerOptions } from '../../src/sdk-compat.js';
import { workflowsPath } from '../../src/worker.js';
import { Script, ScriptedModel } from './scripted-model.js';
import { StubSite } from './reports.js';

/** Shared with Steward's `createLocalEnv`: the same binary, matched to `@temporalio/testing`. */
export const DEV_SERVER_DIR =
  process.env.CONSULTANT_DEV_SERVER_DIR ?? path.join(os.homedir(), '.cache', 'steward', 'temporal-dev-server');

export const TASK_QUEUE = 'consultant-test';

export interface Harness {
  env: TestWorkflowEnvironment;
  script: Script;
  site: StubSite;
  caps: Caps;
  /** Swap one activity for the next test; `reset()` restores them. */
  activities: ConsultantActivities;
  reset(caps?: Partial<Caps>): void;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  fs.mkdirSync(DEV_SERVER_DIR, { recursive: true });
  const env = await TestWorkflowEnvironment.createLocal({
    server: { executable: { type: 'cached-download', downloadDir: DEV_SERVER_DIR, ttl: '365 days' } },
  });
  const script = new Script();
  const harness = {
    env,
    script,
    site: new StubSite(),
    caps: { ...DEFAULT_CAPS },
  } as Harness;

  const build = () =>
    createActivities({ site: harness.site, caps: harness.caps, client: env.client, pollMs: 50 });
  harness.activities = build();
  // The worker sees these indirections, so a test can swap the site, caps or an activity.
  const indirect = Object.fromEntries(
    Object.keys(harness.activities).map((name) => [
      name,
      (...args: unknown[]) => (harness.activities as Record<string, (...a: unknown[]) => unknown>)[name]!(...args),
    ]),
  );
  harness.reset = (caps = {}) => {
    harness.site = new StubSite();
    harness.caps = { ...DEFAULT_CAPS, ...caps };
    harness.activities = build();
    script.set([]);
  };

  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace ?? 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath,
    bundlerOptions,
    activities: indirect,
    plugins: [
      new StrandsPlugin({ models: { [MODEL]: () => new ScriptedModel(script) }, observerFactory: harnessObserverFactory }),
      new AgentHarnessPlugin(),
    ],
  });
  const running = worker.run();
  harness.stop = async () => {
    worker.shutdown();
    await running;
    await env.teardown();
  };
  return harness;
}

/** Answers every question with `answer` and every approval with `approve`. */
export function caller(answer = 'example.com', approve = true) {
  return { answer: () => answer, approve: () => approve };
}

let counter = 0;
export function workflowId(name: string): string {
  counter += 1;
  return `consultant-test-${name}-${process.pid}-${counter}`;
}
