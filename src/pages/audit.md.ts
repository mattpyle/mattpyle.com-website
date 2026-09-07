import type { APIRoute } from 'astro';
import {
  BLOCKED_REASON_MARKERS,
  RUN_FAILURE_MARKERS,
  normaliseTarget,
  renderMarkdownSummary,
} from '@mattpyle/steward/agent-audit/fast';
import { originFor } from '../lib/mcp-audit-server.mjs';
import { readPointer } from '../lib/audit-pointer.mjs';
import { classifyRunFailure } from '../lib/audit-report.mjs';
import { CANONICAL, auditMarkdownDocument } from '../lib/audit-markdown.mjs';
import { fixtureAudit } from '../lib/audit-fixture.mjs';
import { getClient, withDeadline } from '../lib/mcp-temporal.mjs';

/**
 * The Markdown representation of /audit.
 *
 * A curated sibling, for the reason /activity has one and for one more of its own. /audit renders
 * on demand — it reads a pointer out of the store at request time — so there is no built HTML file
 * for scripts/emit-markdown-siblings.mjs to convert, and a curated route is the only way it can
 * have a sibling at all. And the report shape is a document Steward already knows how to write:
 * `renderMarkdownSummary` is the canonical markdown rendering of a run, the same one the CLI and
 * `/mcp` hand back, so a converted sibling would be a second, worse markdown report about the same
 * run.
 *
 * **THE QUERY STRING IS THE REPORT, so it rides along.** `/audit.md?url=<origin>` answers the
 * remembered run for that origin, and the middleware's proxy fetch keeps the query when it derives
 * this URL from `/audit/?url=<origin>`. That is also why `/audit.md` is NOT in `ON_DEMAND_PATHS`:
 * that list exists to strip a query string before it becomes part of a CDN cache key, and
 * stripping this one would answer every report request with the empty page.
 *
 * **EVERY SHAPE ANSWERS 200, INCLUDING THE ONE THE HTML PAGE ANSWERS 400 FOR.** The middleware
 * treats a non-2xx sibling as a miss and falls back to serving HTML (the `upstream.ok` check in
 * middleware.ts), so a 400 here would not reach a client as a 400 — it would quietly turn a
 * negotiated markdown request into an HTML response, which is the one outcome an agent asking for
 * markdown must not get by accident. The status code belongs to the HTML route, which is the
 * representation that owns it; this one says what happened in the body.
 *
 * **A GET NEVER VISITS THE TARGET**, exactly as on the HTML route and for the same reason: these
 * URLs get shared, and following one must cost the audited site nothing. This route cannot run an
 * audit at all — there is no POST here, and both forms post to `/audit/`.
 *
 * It imports the same `agent-audit/fast` entry the page does and adds no new exports entry; what
 * it takes from it is the renderer, the address parser and the failure markers. What the response
 * actually says is src/lib/audit-markdown.mjs, which is where the shapes are tested.
 */
export const prerender = false;

/** How long a read of a finished activity's result may take before the route gives up on it. */
const RESULT_DEADLINE_MS = 5_000;

/** The prose fragments `classifyRunFailure` matches a finished run on. See audit-report.mjs. */
const FAILURE_MARKERS = { ...RUN_FAILURE_MARKERS, ...BLOCKED_REASON_MARKERS };

/**
 * The finished result of a standalone activity, or `null`.
 *
 * The same read src/pages/audit.astro makes, with the same posture: every failure is a null, and
 * "there is no report to show" is the one thing this route can say about any of them without
 * inventing a fact about retention.
 */
async function readActivityResult(activityId: string) {
  try {
    const client = await getClient();
    return await withDeadline(
      client.activity.getHandle(activityId).result(),
      RESULT_DEADLINE_MS,
      'the audit worker'
    );
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ url }) => {
  const now = new Date();
  const asked = url.searchParams.get('url');

  let origin = '';
  if (asked) {
    try {
      origin = originFor(asked, normaliseTarget);
    } catch {
      // An address that cannot be audited has no report and never will have one. Naming it back is
      // the whole answer here; the HTML route answers the same request with a 400 and a callout.
      origin = '';
    }
  }

  // The fixture is the accessibility suite's and local preview's, gated exactly as the HTML
  // route's is: `!process.env.VERCEL` makes "never a deployment's" structural rather than a
  // promise about who sets which variable. It is read here too so both representations of one URL
  // agree in every environment — a served build showing a report at /audit/?url= and none at
  // /audit.md?url= would be a site whose own markdown negotiation contradicts it.
  const audit = !origin
    ? null
    : process.env.AUDIT_REPORT_FIXTURE === '1' && !process.env.VERCEL
      ? fixtureAudit({ now, origin })
      : await (async () => {
          const pointer = await readPointer({ origin });
          if (!pointer) return null;
          return pointer.report ?? (await readActivityResult(pointer.activityId!));
        })();

  const { body, maxAge } = auditMarkdownDocument({
    asked,
    origin,
    audit,
    // A run that reached no verdict about the site is not a report, and rendering it as one would
    // hand a model thirteen failures against a site nothing ever connected to.
    failed: Boolean(audit) && classifyRunFailure(audit, FAILURE_MARKERS) !== null,
    renderSummary: renderMarkdownSummary,
    now,
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: `<${CANONICAL}>; rel="canonical"`,
      'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=60`,
      Vary: 'Accept',
    },
  });
};
