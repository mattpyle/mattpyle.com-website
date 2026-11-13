/**
 * Hold one conversation with a running audit-consultant worker, for a local proof.
 *
 *   npm run converse -w @mattpyle/consultant -- --id demo-1 "first message" "second message"
 *
 * Options:
 *   --id <workflowId>   the session; started unless --attach is given
 *   --attach            send to a session that is already running
 *   --answer <text>     what to answer when the agent asks a question (default www.mattpyle.com)
 *   --approve           approve a deep audit when asked; without it, every deep audit is declined
 *   --send-only         send the first message and exit without waiting (for a worker-kill test)
 *   --history <file>    write the session's event history as JSON when done
 *
 * Reads TEMPORAL_ADDRESS (default localhost:7300), TEMPORAL_NAMESPACE (default default) and
 * CONSULTANT_TASK_QUEUE (default audit-consultant). It needs no model key: the worker holds that.
 * With TEMPORAL_API_KEY set it connects over TLS with that key, which is how it reaches a Temporal
 * Cloud namespace; pass the key with `op run`, never on the command line.
 */
import fs from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/proto-utils';
import { DEFAULT_TASK_QUEUE } from '../src/config.js';
import { ConsultantSession, type StreamEvent } from './session.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUED = new Set(['--id', '--answer', '--history']);
const messages = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1] ?? ''));

const id = option('--id');
if (!id || messages.length === 0) {
  console.error('usage: converse --id <workflowId> [--attach] [--answer text] [--approve] "message" ...');
  process.exit(2);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts: unknown[]) => console.log(stamp(), ...parts);

const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const apiKey = process.env.TEMPORAL_API_KEY?.trim() || undefined;
const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7300',
  // A Cloud namespace takes an API key over TLS. The namespace header is redundant against a
  // namespace endpoint and needed against a regional one, as in the site's src/lib/mcp-temporal.mjs.
  ...(apiKey ? { tls: true, apiKey, metadata: { 'temporal-namespace': namespace } } : {}),
});
const client = new Client({ connection, namespace });
const taskQueue = process.env.CONSULTANT_TASK_QUEUE ?? DEFAULT_TASK_QUEUE;

const session = flag('--attach')
  ? new ConsultantSession(client.workflow.getHandle(id))
  : await ConsultantSession.start(client, taskQueue, id);
log(flag('--attach') ? `attached to ${id}` : `started ${id} on ${taskQueue}`);

const answer = option('--answer') ?? 'www.mattpyle.com';
const caller = {
  answer: (question: string) => {
    log(`AGENT ASKS: ${question}`);
    log(`CALLER ANSWERS: ${answer}`);
    return answer;
  },
  approve: (item: { tool_name: string; tool_input: Record<string, unknown> }) => {
    const ok = flag('--approve');
    log(`APPROVAL ASKED: ${item.tool_name} ${JSON.stringify(item.tool_input)} -> ${ok ? 'approved' : 'declined'}`);
    return ok;
  },
};

if (flag('--send-only')) {
  await session.handle.executeUpdate('send_agent_message', { args: [{ type: 'ask', payload: { text: messages[0] } }] });
  log(`USER: ${messages[0]} (sent; not waiting)`);
  await connection.close();
  process.exit(0);
}

function summarise(events: StreamEvent[]) {
  const tools = events
    .filter((e) => e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'tool_error')
    .map((e) => `${e.type}:${String(e.tool_name ?? '')}`);
  const usage = events
    .filter((e) => e.type === 'model_interaction_ended')
    .map((e) => e.usage as Record<string, number> | undefined)
    .filter((u): u is Record<string, number> => Boolean(u));
  return { tools, usage };
}

for (const text of messages) {
  log(`USER: ${text}`);
  const started = Date.now();
  const turn = await session.ask(text, caller, { pollMs: 500 });
  const { tools, usage } = summarise(turn.events);
  if (tools.length) log(`TOOLS: ${tools.join(' ')}`);
  for (const u of usage) log(`MODEL CALL USAGE: ${JSON.stringify(u)}`);
  log(`AGENT (${((Date.now() - started) / 1000).toFixed(1)} s): ${turn.reply}`);
}

const counts = await session.session();
log(`SESSION: ${JSON.stringify(counts)}`);
const historyPath = option('--history');
if (historyPath) {
  const history = await session.handle.fetchHistory();
  // The proto3 JSON form, the one `temporal workflow show -o json` writes and replay reads.
  fs.writeFileSync(historyPath, historyToJSON(history));
  log(`history written to ${historyPath}`);
}
await connection.close();
