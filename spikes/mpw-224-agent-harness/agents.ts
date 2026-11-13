// Spike MPW-565: the audit consultant on @temporalio/agent-harness 0.5.0, driven by Claude through
// the Strands Agents integration.
//
// One handler, `ask`. Two tools:
//   * `audit_site`: an activity tool. Its body (worker.ts) returns a canned, structured audit
//     result, so the spike never touches the network apart from the model call.
//   * `ask_user`: a callback tool (no `execute`). The workflow parks until an outside process
//     answers it with the `provide_callback_result` Update. This is A2A's `input-required`.

import { z } from "zod";
import {
  TextMessage,
  TextReply,
  ToolApprovalPolicy,
  activityTool,
  defineAgent,
  handler,
  tool,
} from "@temporalio/agent-harness";
import {
  asStrandsTool,
  harnessStrandsAgent,
} from "@temporalio/agent-harness/ai-sdks/strands-agents-harness";

export const TASK_QUEUE = "mpw-224-consultant";
/** The name the worker's StrandsPlugin registers the Claude model under. */
export const MODEL = "claude";

const SYSTEM_PROMPT = `\
You are an audit consultant for websites that want to serve AI agents well.
Answer in brief, plain prose.

Your tools:
- \`audit_site\`: run an agent-readiness audit of one site and get a structured result.
  Call it only when the user has named a specific site. Never guess a host.
- \`ask_user\`: ask the user one question when you need something only they know,
  for example which site to audit. Then wait for the answer.

When you have an audit result, say which two findings matter most and why. Do not
editorialise about checks the result does not contain.`;

export const AuditResult = z.object({
  host: z.string(),
  score: z.number(),
  checks: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["pass", "warn", "fail"]),
      detail: z.string(),
    }),
  ),
});
export type AuditResult = z.infer<typeof AuditResult>;

export const auditSite = activityTool({
  name: "audit_site",
  description:
    'Run an agent-readiness audit of one website. `host` is a bare host name, e.g. "example.com".',
  inputSchema: z.object({ host: z.string() }),
  outputSchema: AuditResult,
  inherentlySafe: true,
});

export const askUser = tool({
  name: "ask_user",
  description: "Ask the user one question and return their answer.",
  inputSchema: z.object({ question: z.string() }),
  outputSchema: z.string(),
  inherentlySafe: true,
});

export const AuditConsultant = defineAgent({
  name: "AuditConsultant",
  approvalPolicyDefault: ToolApprovalPolicy.allowInherentlySafe(),
  handlers: {
    ask: handler({
      description: "Ask the audit consultant about a site's readiness for AI agents.",
      input: TextMessage,
      output: TextReply,
    }),
  },
  create: ({ runner }) => {
    // Strands keeps the conversation in the agent object, which lives as long as the workflow.
    const agent = harnessStrandsAgent(runner, {
      model: MODEL,
      activityOptions: { startToCloseTimeout: "2 minutes" },
      systemPrompt: SYSTEM_PROMPT,
      tools: [asStrandsTool(runner, auditSite), asStrandsTool(runner, askUser)],
      printer: false,
    });
    return {
      async ask({ text }) {
        const result = await agent.invoke(text);
        return {
          text: result.lastMessage.content
            .flatMap((block) => (block.type === "textBlock" ? [block.text] : []))
            .join(""),
        };
      },
    };
  },
});
