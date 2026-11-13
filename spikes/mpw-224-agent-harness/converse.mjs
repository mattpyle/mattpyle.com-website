// Drive one conversation with the audit consultant through a PLAIN Temporal client, by raw names.
// No harness package is imported: this is what an A2A adapter on the site would have to do.
//
//   node converse.mjs <client-module-dir> <workflow-id> [--start] [--turns N] [--answer TEXT]
//
// <client-module-dir> is the node_modules folder whose @temporalio/client and @temporalio/proto are
// used, so the same script runs on the spike's 1.24.0 client and on the root tree's 1.20.3 client.
//
// Raw names, all from @temporalio/agent-harness 0.5.0 agent-protocol/agent-interface.ts:
//   Update  send_agent_message      {type, payload}       -> {turn_number, turn_id, message_id, disposition, accepted_offset}
//   Query   agent_status                                   -> {turn_active, pending_turns, pending_callbacks, ...}
//   Update  provide_callback_result {tool_id, result, error} -> {tool_id, accepted}
//   Update  __temporal_workflow_stream_poll {topics, from_offset} -> {items, next_offset, more_ready}

import { createRequire } from "node:module";
import path from "node:path";

const [, , modDir, workflowId, ...rest] = process.argv;
const flag = (name) => rest.includes(name);
const opt = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
};
const require = createRequire(path.resolve(modDir, "x.js"));
const { Client, Connection } = require("@temporalio/client");
const { defaultPayloadConverter } = require("@temporalio/common");
const { temporal } = require("@temporalio/proto");
const clientVersion = require("@temporalio/client/package.json").version;

const TASK_QUEUE = "mpw-224-consultant";
const TURNS = [
  "In one paragraph: what does an llms.txt file do for an AI agent?",
  "Can you check my site and tell me what matters?",
  "Of those, which one should I fix first, and what is the smallest change that fixes it?",
  "Thanks. Is the A2A card warning worth fixing this week, yes or no, and why?",
];
const CALLBACK_ANSWER = opt("--answer", "www.mattpyle.com");

const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7300" });
const client = new Client({ connection, namespace: "default" });
const handle = client.workflow.getHandle(workflowId);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log(`plain @temporalio/client ${clientVersion}, workflow ${workflowId}`);

if (flag("--start")) {
  // Workflow input is the AgentConfig; {} takes every default.
  await client.workflow.start("AuditConsultant", { workflowId, taskQueue: TASK_QUEUE, args: [{}] });
  log("started AuditConsultant");
}

/** Read the stream from `offset` once (non-blocking: the Update returns what is there, or waits). */
async function poll(offset) {
  const res = await handle.executeUpdate("__temporal_workflow_stream_poll", {
    args: [{ topics: [], from_offset: offset }],
  });
  const items = res.items.map((w) => {
    const payload = temporal.api.common.v1.Payload.decode(Buffer.from(w.data, "base64"));
    return { offset: w.offset, topic: w.topic, data: defaultPayloadConverter.fromPayload(payload) };
  });
  return { items, next: res.next_offset };
}

let streamOffset = 0;
const usage = { calls: 0, input: 0, output: 0 };
const turnsToRun = Number(opt("--turns", String(TURNS.length)));
const firstTurn = Number(opt("--from-turn", "1"));
for (let t = firstTurn; t < firstTurn + turnsToRun && t <= TURNS.length; t++) {
  const text = TURNS[t - 1];
  let reply;
  if (flag("--resume")) {
    // Re-attach to a turn already in flight (after a worker kill): send nothing, read where it is.
    const s = await handle.query("agent_status");
    reply = { turn_number: s.current_turn, accepted_offset: Number(opt("--offset", "0")) };
    log(`RESUME: agent_status says turn ${s.current_turn}, turn_active=${s.turn_active}, pending_callbacks=${s.pending_callbacks.length}`);
  } else {
    log(`USER (turn ${t}): ${text}`);
    reply = await handle.executeUpdate("send_agent_message", {
      args: [{ type: "ask", payload: { text } }],
    });
    log("send_agent_message ->", JSON.stringify(reply));
    if (flag("--send-only")) process.exit(0);
  }
  streamOffset = Math.max(streamOffset, reply.accepted_offset ?? 0);

  // Wait for the turn to end, answering any callback the model raises.
  for (;;) {
    const status = await handle.query("agent_status");
    if (status.pending_callbacks.length > 0) {
      const cb = status.pending_callbacks[0];
      log(`INPUT-REQUIRED: agent_status shows pending callback ${cb.tool_name}`, JSON.stringify(cb.tool_input));
      if (flag("--stop-at-callback")) {
        log("stopping with the callback parked (--stop-at-callback)");
        process.exit(0);
      }
      const ack = await handle.executeUpdate("provide_callback_result", {
        args: [{ tool_id: cb.tool_id, result: CALLBACK_ANSWER, error: null }],
      });
      log(`provide_callback_result("${CALLBACK_ANSWER}") ->`, JSON.stringify(ack));
      continue;
    }
    if (!status.turn_active && status.pending_turns.length === 0 && status.current_turn >= reply.turn_number) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // The reply text is not on the Update result or the status Query: read it off the stream.
  const { items, next } = await poll(streamOffset);
  streamOffset = next;
  const types = items.map((i) => i.data?.event?.type ?? i.topic);
  log("stream event types this turn:", JSON.stringify(types));
  const end = items.find((i) => i.data?.event?.type === "message_handler_end" || i.data?.event?.output);
  const toolCalls = items
    .filter((i) => /tool/.test(i.data?.event?.type ?? ""))
    .map((i) => `${i.data.event.type}:${i.data.event.tool_name ?? i.data.event.name ?? ""}`);
  if (toolCalls.length) log("tool events:", JSON.stringify(toolCalls));
  for (const i of items) {
    const u = i.data?.event?.type === "model_interaction_ended" ? i.data.event.usage : null;
    if (u) {
      usage.calls++;
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
    }
  }
  log("usage so far:", JSON.stringify(usage));
  if (flag("--dump")) console.log(JSON.stringify(items, null, 1));
  log(`AGENT (turn ${t}):`, end?.data?.event?.output?.text ?? JSON.stringify(end?.data?.event ?? "(no end event found)"));
}
await connection.close();
