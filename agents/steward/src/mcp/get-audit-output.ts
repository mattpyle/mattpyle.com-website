import { z } from 'zod';

/**
 * `get_audit`'s output schema on the local server: one object covering all three views.
 *
 * The mirror of the declaration on the public endpoint (`src/lib/mcp-audit-server.mjs` in the site
 * repo), and the two are separate on purpose — a prerendered site page may not import this
 * workspace, and the two servers do not serve the same status document anyway. This one carries
 * `reportUri` and `summaryUri`, because this server registers resources and the hosted one does
 * not, and it has no `queued` half, because queue position is a property of the one hosted worker.
 *
 * Three decisions, all of which apply on both sides:
 *
 * **One flat object rather than a union.** The MCP SDK publishes an `outputSchema` only when it
 * normalises to an object schema; a `z.union` is dropped from `tools/list` and then fails
 * validation on every call. So every field is optional and each one names the view it belongs to.
 *
 * **The status and report views are not wrapped.** Their `structuredContent` is the parse of the
 * text block beside it and nothing else — one document, two renderings, unable to disagree.
 * The summary view had no structured half at all, so it takes the envelope
 * `{ view: "summary", markdown }`: additive for existing callers, and somewhere for the markdown to
 * live now that the SDK requires `structuredContent` on every result of a tool that declares a
 * schema.
 *
 * **Nested objects are loose.** The canonical shapes are `deep-contract.ts` and `result.ts`; this
 * is a declaration of them, and a strict copy would turn a successful read into an output
 * validation error the day the two drift. A caller seeing an unannounced field is a far better
 * failure than a caller getting nothing.
 */
export const GET_AUDIT_OUTPUT_SHAPE = z.looseObject({
  // ---- the summary view, the only one with a shape of its own ----
  view: z
    .literal('summary')
    .optional()
    .describe('Present on the summary view only. The status and report views are the documents.'),
  markdown: z
    .string()
    .optional()
    .describe('summary view: the report as markdown, the same text as the text content.'),

  // ---- the status view ----
  workflowId: z.string().optional().describe('status view: the ID this audit was started under.'),
  url: z.string().optional().describe('status view: exactly what the caller asked to audit.'),
  tier: z.string().optional().describe('status view: fast or deep.'),
  execution: z
    .string()
    .optional()
    .describe("status view: Temporal's own answer — RUNNING, COMPLETED, FAILED, TIMED_OUT."),
  phase: z.string().optional().describe("status view: the workflow's account of itself."),
  note: z.string().optional().describe('status view: one line saying what is happening right now.'),
  done: z
    .boolean()
    .optional()
    .describe(
      'status view: the run ended, either way. Terminal, not successful — poll until this is true.',
    ),
  succeeded: z
    .boolean()
    .optional()
    .describe('status view: whether the ended run produced a report. Meaningless while done is false.'),
  reportUri: z.string().optional().describe('status view: steward://audit/<workflowId>/report.'),
  summaryUri: z.string().optional().describe('status view: steward://audit/<workflowId>/summary.'),
  progress: z
    .looseObject({
      phase: z.string().describe('fetching, rendering, assembling, complete or failed.'),
      steps: z
        .array(
          z.looseObject({
            id: z.string(),
            kind: z.string(),
            label: z.string(),
            state: z.string(),
          }),
        )
        .describe('The durable work: the fetch pass, each rendered page, assembly.'),
      checks: z
        .array(z.looseObject({ id: z.string(), title: z.string(), status: z.string() }))
        .describe("The audit's own verdicts, filling in as they are decided."),
    })
    .optional()
    .describe(
      'status view: an OBJECT with phase, steps and checks — not a list. Absent when the run ' +
        'could not be queried.',
    ),
  error: z
    .string()
    .optional()
    .describe('status view: why a finished run has no report. Absent otherwise.'),

  // ---- the report view ----
  schemaVersion: z.number().optional().describe('report view: the audit document schema version.'),
  tool: z
    .looseObject({ name: z.string(), version: z.string() })
    .optional()
    .describe('report view: what ran the audit.'),
  target: z
    .looseObject({ input: z.string(), origin: z.string() })
    .optional()
    .describe('report view: what was audited.'),
  durationMs: z.number().optional().describe('report view: how long the audit took.'),
  requests: z
    .number()
    .optional()
    .describe('report view: how many HTTP requests the audit made at the target.'),
  browserPages: z.number().optional().describe('report view: pages rendered in a real browser.'),
  categories: z
    .array(z.looseObject({ category: z.string() }))
    .optional()
    .describe('report view: per-category pass/fail counts. There is deliberately no composite score.'),
  decisionClasses: z
    .looseObject({})
    .optional()
    .describe('report view: how many findings carry each decision class.'),
  checks: z
    .array(
      z.looseObject({
        id: z.string(),
        title: z.string(),
        category: z.string(),
        severity: z.string(),
        status: z.string().describe('pass, fail, not-applicable or error.'),
        observed: z.string(),
      }),
    )
    .optional()
    .describe('report view: every check, with its verdict, its evidence, and a fix where it failed.'),
  notes: z
    .array(z.string())
    .optional()
    .describe('report view: what the audit could not do, in its own words.'),

  // ---- shared by the status and report views, and the same field in both ----
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  integrity: z
    .looseObject({ status: z.string().describe('clean or degraded.'), reason: z.string().optional() })
    .optional()
    .describe('Whether the run produced a whole document.'),
});
