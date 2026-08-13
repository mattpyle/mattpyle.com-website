import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkflowNotFoundError, type Client, type WorkflowHandle } from '@temporalio/client';
import { z } from 'zod';
import { auditWorkflowIdFor, QUEUE_LIGHT } from '../config.js';
import { normaliseTarget } from '../lib/agent-audit/checks.js';
import { renderMarkdownSummary } from '../lib/agent-audit/render.js';
import type { AuditResult } from '../lib/agent-audit/result.js';
import {
  auditSiteWorkflow,
  getAuditState,
  type AuditSiteState,
  type AuditTier,
} from '../workflows/audit-site.js';

/**
 * The MCP surface over `auditSiteWorkflow` (hosted-mcp-stage-1 card).
 *
 * One tool and three resources, and no read mirror of the site's own content —
 * that was dropped from the arc on 2026-08-11, because WebMCP and the site's
 * existing agent surfaces already serve it. The product here is the audit.
 *
 * **The shape this exists to prove.** `audit_site` starts a workflow and returns
 * a handle, in milliseconds; the caller polls a resource until the report is
 * there. A deep audit is minutes long, which is longer than any MCP client will
 * hold a tool call open, so the async shape is not a stylistic choice — it is the
 * only shape in which this tool can exist at all. It is also the Temporal story
 * in one artifact: the run survives a worker restart, and the handle keeps
 * answering.
 */

/** The tool's own budgets, matching `audit-url`'s per-tier defaults in cli.ts. */
const FAST_BUDGET_SECONDS = 120;
const DEEP_BUDGET_SECONDS = 420;

export const SERVER_NAME = 'steward-audit';
export const SERVER_VERSION = '0.1.0';

/** `steward://audit/<workflowId>/<view>` — the one URI shape this server serves. */
function uriFor(workflowId: string, view: 'status' | 'report' | 'summary'): string {
  return `steward://audit/${workflowId}/${view}`;
}

/**
 * What the status resource serves.
 *
 * Two notions of "how is it going" side by side, deliberately. `execution` is
 * Temporal's own answer — RUNNING, COMPLETED, FAILED, TIMED_OUT — and is the one
 * that can say the run died. `phase` is the workflow's account of itself and is
 * the one that says what it was doing. A poller needs `done` to stop and
 * `succeeded` to know what it stopped on; the rest is for a human reading over
 * its shoulder.
 */
interface AuditStatus {
  workflowId: string;
  url: string;
  tier: AuditTier;
  execution: string;
  phase: AuditSiteState['phase'] | 'unknown';
  note: string;
  /**
   * The run is over, whatever way it ended. **Terminal, not successful**: an
   * audit that fails is a designed outcome here (one attempt, no retry), so a
   * `done` that meant COMPLETED alone would leave every failed run's poller
   * looping until it gave up.
   */
  done: boolean;
  /** Whether the run that ended produced a report. Meaningless while `done` is false. */
  succeeded: boolean;
  startedAt?: string;
  finishedAt?: string;
  reportUri: string;
  summaryUri: string;
  /** Present only when the execution ended without a report. */
  error?: string;
}

/**
 * Why one audit ended without a report, in the words of whatever actually
 * stopped it.
 *
 * A closed execution's failure reaches the client as `WorkflowFailedError:
 * Workflow execution failed`, with the reason buried on `.cause` — the same
 * shape `describeCliError` in cli.ts walks for the operator at the terminal.
 * The innermost specific message is what distinguishes a heartbeat timeout from
 * a wedged Chrome from a refused target, which is the whole point of the
 * activity converting a `BlockedTargetError` into a non-retryable failure with
 * its own text.
 */
async function failureMessage(handle: WorkflowHandle, execution: string): Promise<string> {
  const GENERIC = ['Workflow execution failed', 'Activity task failed'];
  try {
    await handle.result();
  } catch (err) {
    let current: unknown = err;
    let best = '';
    for (let depth = 0; current instanceof Error && depth < 6; depth++) {
      if (current.message && !GENERIC.includes(current.message)) best = current.message;
      current = (current as Error).cause;
    }
    if (best) return best;
  }
  return `the audit ended ${execution}`;
}

/** JSON with a trailing newline, the way every other artifact this project writes is shaped. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Reads one execution's state.
 *
 * `describe()` and the query answer different questions and both are asked: a
 * workflow that failed still describes itself, and a query against it may throw.
 * The query is therefore best-effort — its absence is reported as
 * `phase: 'unknown'` rather than turned into a failed resource read, because the
 * caller's real question ("is it done, and did it work") is already answered by
 * `describe()` alone.
 */
async function readState(
  client: Client,
  workflowId: string,
): Promise<{ status: AuditStatus; result?: AuditResult; handle: WorkflowHandle }> {
  const handle = client.workflow.getHandle(workflowId);
  let description;
  try {
    description = await handle.describe();
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      throw new Error(
        `No audit with workflow ID "${workflowId}". Start one with the audit_site tool; ` +
          'an ID is only valid for as long as Temporal keeps that run\'s history.',
      );
    }
    throw err;
  }

  let state: AuditSiteState | undefined;
  let queryError: string | undefined;
  try {
    state = await handle.query(getAuditState);
  } catch (err) {
    queryError = err instanceof Error ? err.message : String(err);
  }

  const execution = description.status.name;
  const done = execution !== 'RUNNING';
  const succeeded = execution === 'COMPLETED';
  const status: AuditStatus = {
    workflowId,
    url: state?.url ?? 'unknown',
    tier: state?.tier ?? 'fast',
    execution,
    phase: state?.phase ?? 'unknown',
    note: state?.note ?? queryError ?? 'no state — the run may have ended before it reported any',
    done,
    succeeded,
    startedAt: description.startTime?.toISOString(),
    finishedAt: description.closeTime?.toISOString(),
    reportUri: uriFor(workflowId, 'report'),
    summaryUri: uriFor(workflowId, 'summary'),
  };
  if (done && !succeeded) {
    status.error = await failureMessage(handle, execution);
  }
  return { status, result: state?.result, handle };
}

/**
 * The report, or a refusal that says which.
 *
 * A run that is still going gets an error rather than a placeholder document: an
 * agent handed a 200 and a "not ready" object will summarise it as the audit's
 * findings, and an empty finding list reads as a clean site.
 */
async function readReport(client: Client, workflowId: string): Promise<AuditResult> {
  const { status, result } = await readState(client, workflowId);
  if (result) return result;
  if (status.execution === 'RUNNING') {
    throw new Error(
      `Audit ${workflowId} is still running (${status.note}). Read ${status.reportUri} again in a few seconds.`,
    );
  }
  throw new Error(`Audit ${workflowId} produced no report: ${status.error ?? status.execution}.`);
}

/**
 * Builds the server. Takes a `Client` rather than making one, so the CLI owns the
 * connection's lifetime and a test can hand in its own.
 */
export function createAuditMcpServer(client: Client): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Audits any website for agent-readiness: robots.txt, sitemap, llms.txt, agents.md, ' +
        'markdown content negotiation, the well-known discovery documents, and — on the deep ' +
        'tier — Lighthouse and axe over pages rendered in a real browser. audit_site returns a ' +
        'workflow ID immediately; the audit itself takes seconds (fast) to minutes (deep). Read ' +
        'the status resource until done is true: succeeded then says whether there is a report to ' +
        'read, and error says why if there is not. It obeys the ' +
        "target's robots.txt and identifies itself as steward-audit-url.",
    },
  );

  server.registerTool(
    'audit_site',
    {
      title: 'Audit a site for agent-readiness',
      description:
        'Starts an agent-readiness audit of one site and returns its workflow ID straight away — ' +
        'it does not wait for the result. Poll steward://audit/<workflowId>/status until done is ' +
        'true (done means the run ended, and succeeded says whether it ended with a report), then ' +
        'read steward://audit/<workflowId>/report for the canonical JSON, or ' +
        '/summary for a markdown digest of the same document. The deep tier renders up to three ' +
        'pages in a browser and takes minutes; pass fast: true for the HTTP checks alone, which ' +
        'take seconds.',
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe('The site to audit: https://example.com, or just example.com. Any path is ignored — the unit audited is a site.'),
        fast: z
          .boolean()
          .optional()
          .describe('Skip the browser: HTTP checks only, seconds rather than minutes. Defaults to false.'),
      },
      outputSchema: {
        workflowId: z.string(),
        origin: z.string(),
        tier: z.enum(['fast', 'deep']),
        statusUri: z.string(),
        reportUri: z.string(),
        summaryUri: z.string(),
        expectedDuration: z.string(),
      },
      annotations: {
        // It starts a durable run against a third party's origin. Not a read of
        // this server's own state, and not idempotent: two calls are two audits.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, fast }) => {
      let origin: string;
      try {
        ({ origin } = normaliseTarget(url));
      } catch {
        throw new Error(`"${url}" is not a URL. Try https://example.com, or just example.com.`);
      }
      if (!/^https?:$/.test(new URL(origin).protocol)) {
        throw new Error(`Only http and https targets are audited; "${url}" is neither.`);
      }

      const tier: AuditTier = fast === true ? 'fast' : 'deep';
      const workflowId = auditWorkflowIdFor(origin, tier, randomUUID().slice(0, 8));

      // Started on the light queue, whichever tier this is: the task queue in
      // `start` routes the *workflow* task, and the workflow's own stubs route
      // each activity. The deep tier's Chrome work still lands on the heavy
      // queue, decided inside the workflow where history records it.
      await client.workflow.start(auditSiteWorkflow, {
        workflowId,
        taskQueue: QUEUE_LIGHT,
        args: [
          {
            url,
            tier,
            budgetSeconds: tier === 'fast' ? FAST_BUDGET_SECONDS : DEEP_BUDGET_SECONDS,
          },
        ],
      });

      const structuredContent = {
        workflowId,
        origin,
        tier,
        statusUri: uriFor(workflowId, 'status'),
        reportUri: uriFor(workflowId, 'report'),
        summaryUri: uriFor(workflowId, 'summary'),
        expectedDuration: tier === 'fast' ? 'seconds' : 'a few minutes',
      };
      return {
        structuredContent,
        content: [
          {
            type: 'text' as const,
            text:
              `Auditing ${origin} (${tier} tier). This is running now and is not finished.\n` +
              `Workflow ID: ${workflowId}\n` +
              `Read ${structuredContent.statusUri} until "done" is true (expect ${structuredContent.expectedDuration}), ` +
              `then read ${structuredContent.reportUri} if "succeeded" is true; if it is false, "error" says why.`,
          },
        ],
      };
    },
  );

  // `list: undefined` on all three: the tool hands back the exact URIs, so a
  // listing would be a second way to learn something the caller was just told.
  // Enumerating every audit this desktop has ever run is also not a thing to
  // serve down a tunnel — they are reports about third parties.
  const template = (view: 'status' | 'report' | 'summary') =>
    new ResourceTemplate(`steward://audit/{workflowId}/${view}`, { list: undefined });

  server.registerResource(
    'audit-status',
    template('status'),
    {
      title: 'Audit status',
      description:
        'Whether one audit has finished, and what it is doing if not. Poll this until "done" is ' +
        'true — that means the run ended, either way — then read "succeeded" to learn whether ' +
        'there is a report, and "error" for why there is not.',
      mimeType: 'application/json',
    },
    async (uri, { workflowId }) => {
      const { status } = await readState(client, String(workflowId));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: json(status) }] };
    },
  );

  server.registerResource(
    'audit-report',
    template('report'),
    {
      title: 'Audit report (canonical JSON)',
      description:
        'The finished audit: every check with its verdict, evidence, and fix. The same document ' +
        '`steward audit-url --json` writes. Errors while the audit is still running.',
      mimeType: 'application/json',
    },
    async (uri, { workflowId }) => {
      const result = await readReport(client, String(workflowId));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: json(result) }] };
    },
  );

  server.registerResource(
    'audit-summary',
    template('summary'),
    {
      title: 'Audit summary (markdown)',
      description:
        'The same finished audit as a markdown digest: per-category counts and the ranked fix ' +
        'list. Derived from the report, never measured separately.',
      mimeType: 'text/markdown',
    },
    async (uri, { workflowId }) => {
      // A pure function of the document the report resource serves — the same
      // rule `audit-url` writes its three artifacts under. The two renderings
      // cannot disagree, because there is only one measurement.
      const result = await readReport(client, String(workflowId));
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `${renderMarkdownSummary(result)}\n` }],
      };
    },
  );

  return server;
}
