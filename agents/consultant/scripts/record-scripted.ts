/**
 * Record one session with the scripted model and the stub site, and write its history as a replay
 * fixture. No model call and no site call. The session uses every tool that needs no approval,
 * `site_facts` included, over three turns.
 *
 *   node --import tsx --import ./src/sdk-compat.ts scripts/record-scripted.ts tests/fixtures/histories/<name>.json
 */
import fs from 'node:fs';
import { historyToJSON } from '@temporalio/common/proto-utils';
import { ConsultantSession } from './session.js';
import { TASK_QUEUE, caller, startHarness } from '../tests/helpers/env.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: record-scripted.ts <output.json>');
  process.exit(2);
}

const h = await startHarness();
try {
  const session = await ConsultantSession.start(h.env.client, TASK_QUEUE, 'consultant-scripted-fixture');
  h.script.set([
    { tool: 'ask_user', input: { question: 'Which site should I audit?' } },
    { tool: 'audit_site', input: { url: 'example.com' } },
    { text: 'Publish llms.txt first.' },
  ]);
  await session.ask('Can you check my site?', caller('example.com'));
  h.script.set([{ tool: 'site_facts', input: { topic: 'writing' } }, { text: 'The newest post is about WebMCP.' }]);
  await session.ask('What has Matt written lately?', caller());
  h.script.set([{ text: 'Then add agents.md.' }]);
  await session.ask('What next?', caller());
  const history = await session.handle.fetchHistory();
  fs.writeFileSync(out, historyToJSON(history));
  console.log(`${history.events?.length ?? 0} events written to ${out}`);
} finally {
  await h.stop();
}
