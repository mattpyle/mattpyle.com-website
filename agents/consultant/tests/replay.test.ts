/**
 * Recorded sessions replay against the current workflow code. A session can be open across a
 * deploy, so a change that alters the commands an open session replays must fail here first.
 *
 * Both fixtures are local proofs on 2026-11-12: a real Claude model through the public MCP
 * endpoint, two turns each. Turn 1 asks the caller which site (`ask_user`), audits it
 * (`audit_site`) and answers; turn 2 answers with no tool.
 *
 * - `proof-conversation.json` was recorded before two changes that issue no new command: the token
 *   count moved to the provider's total, and a turn that hits the output limit is caught and rolled
 *   back. It replays clean across both. Exported with `temporal workflow show -o json`.
 * - `proof-final.json` is the same path on the code as merged, written by `scripts/converse.ts`.
 *
 * Probe: a `sleep('1 second')` added at the top of the `ask` handler made this test fail with a
 * nondeterminism error; removing it made it pass again.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { Worker } from '@temporalio/worker';
import { AgentHarnessPlugin } from '@temporalio/agent-harness-worker';
import { StrandsPlugin } from '@temporalio/agent-harness-worker/ai-sdks/strands-agents';
import { bundlerOptions } from '../src/sdk-compat.js';
import { workflowsPath } from '../src/worker.js';

const FIXTURES = new URL('./fixtures/histories/', import.meta.url);

for (const name of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
  test(`${name} replays on the current workflow code`, async () => {
    const history = JSON.parse(fs.readFileSync(new URL(name, FIXTURES), 'utf8'));
    assert.ok(history.events.length > 50, 'the fixture is a whole session');
    await Worker.runReplayHistory(
      { workflowsPath, bundlerOptions, plugins: [new StrandsPlugin(), new AgentHarnessPlugin()] },
      history,
      name.replace(/\.json$/, ''),
    );
  });
}
