/**
 * The consultant's activities. Worker code: the network lives here and nowhere in the workflow.
 *
 * Every site call goes through a `SiteClient`, which the worker builds on the public MCP endpoint
 * (src/site.ts) and the tests build on canned reports. What leaves an activity for the model is an
 * `AuditView` from `projectReport`, or a `Refusal` with an enum reason. No server or site text.
 *
 * The deep audit is two activities, because starting one spends a slot of a small daily limit:
 *
 * 1. `consultantStartDeepAudit` starts the run and records its id in a heartbeat before it returns.
 *    A retried attempt finds the id in its heartbeat details and returns it without starting a
 *    second run. Once the activity completes, the id is in the workflow's history, and replay never
 *    runs it again.
 * 2. `consultantAwaitDeepAudit` only reads, so a retry costs nothing but a poll. It heartbeats
 *    while it waits, so a dead worker is noticed within its heartbeat timeout.
 */
import { Context, heartbeat, sleep } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import type { Caps } from './caps.js';
import { normaliseOrigin, projectReport } from './project.js';
import { refused, type Refusal, type ToolResult } from './tools.js';

/** One call to the site's public endpoint. `data` is the tool's structured result. */
export type SiteCall = { ok: true; data: unknown } | { ok: false; reason: 'rate_limited' | 'error' };

export interface SiteClient {
  fastAudit(origin: string): Promise<SiteCall>;
  startDeepAudit(origin: string): Promise<SiteCall>;
  readDeepAudit(workflowId: string, view: 'status' | 'report'): Promise<SiteCall>;
}

export interface DeepAuditHandle {
  workflowId: string;
  origin: string;
}

/** The ids `deep_audit` returns are the server's own; anything else is treated as an error. */
const DEEP_WORKFLOW_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export interface ActivityDeps {
  site: SiteClient;
  caps: Caps;
  /** Signals the harness's `close` on a session. A workflow cannot signal itself. */
  client: Pick<Client, 'workflow'>;
  /** Milliseconds between deep-audit status reads. */
  pollMs?: number;
}

export function createActivities({ site, caps, client, pollMs = 10_000 }: ActivityDeps) {
  return {
    /** The worker's caps, read into the workflow once, so a caller cannot set them. */
    async consultantSettings(): Promise<Caps> {
      return caps;
    },

    async consultantFastAudit({ url }: { url: string }): Promise<ToolResult> {
      const origin = normaliseOrigin(url);
      if (!origin) return refused('invalid_url');
      const call = await site.fastAudit(origin);
      if (!call.ok) return refused(call.reason);
      return projectReport(call.data, 'fast', origin);
    },

    async consultantStartDeepAudit({ url }: { url: string }): Promise<DeepAuditHandle | Refusal> {
      const origin = normaliseOrigin(url);
      if (!origin) return refused('invalid_url');
      const prior = Context.current().info.heartbeatDetails as Partial<DeepAuditHandle> | undefined;
      if (typeof prior?.workflowId === 'string' && prior.origin === origin) {
        return { workflowId: prior.workflowId, origin };
      }
      const call = await site.startDeepAudit(origin);
      if (!call.ok) return refused(call.reason);
      const workflowId = (call.data as { workflowId?: unknown } | null)?.workflowId;
      if (typeof workflowId !== 'string' || !DEEP_WORKFLOW_ID.test(workflowId)) return refused('error');
      const handle = { workflowId, origin };
      heartbeat(handle);
      return handle;
    },

    async consultantAwaitDeepAudit({ workflowId, origin }: DeepAuditHandle): Promise<ToolResult> {
      for (;;) {
        heartbeat();
        const status = await site.readDeepAudit(workflowId, 'status');
        if (!status.ok) {
          if (status.reason === 'rate_limited') return refused('rate_limited');
          throw new Error('deep audit status read failed');
        }
        const s = status.data as { done?: unknown; succeeded?: unknown } | null;
        if (s?.done === true) {
          if (s.succeeded !== true) return refused('deep_audit_failed');
          const report = await site.readDeepAudit(workflowId, 'report');
          if (!report.ok) throw new Error('deep audit report read failed');
          return projectReport(report.data, 'deep', origin);
        }
        await sleep(pollMs);
      }
    },

    async consultantCloseSession({ workflowId }: { workflowId: string }): Promise<void> {
      await client.workflow.getHandle(workflowId).signal('close');
    },
  };
}

export type ConsultantActivities = ReturnType<typeof createActivities>;
