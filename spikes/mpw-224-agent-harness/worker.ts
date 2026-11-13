// Worker for the spike's audit consultant. Local dev server only.
//
//   TEMPORAL_ADDRESS   default localhost:7300 (the spike's own dev server, not Steward's)
//   ANTHROPIC_API_KEY  required for model calls; reaches this process only through `op run`
//   CLAUDE_MODEL_ID    default claude-sonnet-5-5

import { fileURLToPath } from "node:url";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { NativeConnection, Worker } from "@temporalio/worker";
import { AgentHarnessPlugin, toolActivity } from "@temporalio/agent-harness-worker";
import { StrandsPlugin } from "@temporalio/agent-harness-worker/ai-sdks/strands-agents";
import { harnessObserverFactory } from "@temporalio/agent-harness-worker/ai-sdks/strands-agents-harness";
import { MODEL, TASK_QUEUE, auditSite, type AuditResult } from "./agents.ts";

const MODEL_ID = process.env.CLAUDE_MODEL_ID ?? "claude-sonnet-5-5";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("error: ANTHROPIC_API_KEY is not set; run the worker under `op run`");
  process.exit(1);
}

/** Canned audit: a fixed, structured result per host. No network. */
async function cannedAudit({ host }: { host: string }): Promise<AuditResult> {
  console.log(`[audit_site] activity ran for host=${host}`);
  return {
    host,
    score: 71,
    checks: [
      { id: "llms-txt", status: "pass", detail: "/llms.txt present and well formed" },
      { id: "markdown-negotiation", status: "fail", detail: "Accept: text/markdown returns HTML" },
      { id: "a2a-card", status: "warn", detail: "agent card has no skills array" },
      { id: "robots-ai", status: "pass", detail: "robots.txt names AI crawlers explicitly" },
      { id: "mcp-discovery", status: "fail", detail: "/.well-known/mcp-server returns 404" },
    ],
  };
}

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7300",
});
const worker = await Worker.create({
  connection,
  namespace: "default",
  taskQueue: TASK_QUEUE,
  workflowsPath: fileURLToPath(new URL("./agents.ts", import.meta.url)),
  plugins: [
    new StrandsPlugin({
      models: { [MODEL]: () => new AnthropicModel({ modelId: MODEL_ID, maxTokens: 1024 }) },
      observerFactory: harnessObserverFactory,
    }),
    new AgentHarnessPlugin({ tools: [toolActivity(auditSite, cannedAudit)] }),
  ],
});
console.log(`worker up: queue=${TASK_QUEUE} model=${MODEL_ID} pid=${process.pid}`);
await worker.run();
await connection.close();
