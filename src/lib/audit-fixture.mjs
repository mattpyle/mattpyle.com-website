/**
 * A canned audit result, so the report half of /audit can be scanned, reflowed and held to an
 * aria golden without a store, a Temporal namespace or a visit to anybody's site.
 *
 * The same device `AGENT_TRAFFIC_FIXTURE` is for /activity, and it exists for the same reason:
 * a page whose only reachable state on a runner is "nothing to show" is a page whose real markup
 * ships never having been audited. The report is the larger and more interesting half of this
 * page — the counts grid, the fix rows, the evidence disclosures, the check tables — and none of
 * it renders without a run behind it.
 *
 * **Opt-in by `AUDIT_REPORT_FIXTURE=1`, never set in production.** It is read in exactly one
 * place, the GET branch of src/pages/audit.astro, and it short-circuits the pointer read only;
 * a POST still runs a real audit whatever this says, because a fixture that answered a POST
 * would make the page's whole reason for existing untestable.
 *
 * **The spread is chosen, not plausible.** Every status the page can print appears, both merged
 * N/A sources appear (`not-applicable` and `error`, which render as the same word), all three
 * severities appear among the failures so the fix ranking has something to rank, and the evidence
 * carries each of its four shapes: a fetched response with headers and an excerpt, a response with
 * no body, a note with no request behind it, and a long single-token excerpt that must scroll
 * inside its own region at 320px rather than push the document sideways.
 *
 * Titles are the real ones, imported from src/data/steward-audit-checks.mjs, so the fixture cannot
 * drift into describing checks the auditor does not run.
 */

import { STEWARD_FAST_CHECKS } from '../data/steward-audit-checks.mjs';

/** The origin the fixture reports on. Reserved by RFC 2606, so it is nobody's real site. */
export const FIXTURE_ORIGIN = 'https://example.com';

/**
 * What each check did in the fixture run.
 *
 * `pass` five, `fail` four across all three severities, `not-applicable` two and `error` two —
 * the last four all print as N/A, which is the merge worth having a fixture prove.
 */
const OUTCOMES = {
  'robots-txt': 'pass',
  'robots-ai-agents': 'fail',
  'content-signals': 'fail',
  sitemap: 'pass',
  'llms-txt': 'fail',
  'llms-txt-links': 'not-applicable',
  'llms-txt-list-items': 'not-applicable',
  'agents-md': 'fail',
  'well-known-mcp-server': 'pass',
  'a2a-agent-card': 'error',
  'markdown-negotiation-home': 'pass',
  'markdown-negotiation-content': 'error',
  'link-headers': 'pass',
};

const OBSERVED = {
  'robots-txt': '200, 3 user-agent group(s), 1 sitemap declaration(s)',
  'robots-ai-agents': 'a blanket "User-agent: * / Disallow: /" blocks every agent, user-triggered ones included',
  'content-signals': 'no Content-Signal directives in robots.txt and no Content-Signal response header',
  sitemap: '200, 42 URL(s), parses as a urlset',
  'llms-txt': '404 — the origin serves no llms.txt',
  'llms-txt-links': 'not run — there is no llms.txt to take links from',
  'llms-txt-list-items': 'not run — there is no llms.txt to read list items from',
  'agents-md': '200, but the response is text/html rather than markdown',
  'well-known-mcp-server': '200, application/json, names an endpoint at https://example.com/mcp',
  'a2a-agent-card': 'could not fetch: the connection was reset before any response arrived',
  'markdown-negotiation-home': '200 with Content-Type text/markdown and a markdown body',
  'markdown-negotiation-content': 'could not fetch: the connection was reset before any response arrived',
  'link-headers': 'the homepage Link header names an alternate of type text/markdown',
};

const FIXES = {
  'robots-ai-agents':
    'Name the user-triggered agents you want to admit and allow them explicitly, above the blanket ' +
    'rule. A person pointing an assistant at your site is a reader, not a crawler, and the two are ' +
    'different questions.',
  'content-signals':
    'Add Content-Signal directives to robots.txt saying what your content may be used for. Silence ' +
    'is read as consent by some clients and as refusal by others, which is the one answer that ' +
    'helps nobody.',
  'llms-txt':
    'Add an /llms.txt listing your main pages as markdown links. It is the file an assistant reads ' +
    'first when it wants to know what a site is for.',
  'agents-md':
    'Serve /agents.md as text/markdown. A brief that comes back as a rendered page is a brief an ' +
    'agent has to strip tags out of before it can read a word of it.',
};

const EVIDENCE = {
  'robots-ai-agents': [
    {
      url: 'https://example.com/robots.txt',
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      excerpt: 'User-agent: * Disallow: / Sitemap: https://example.com/sitemap.xml',
    },
  ],
  'content-signals': [
    { url: 'https://example.com/robots.txt', note: 'no Content-Signal directive on any group' },
  ],
  'llms-txt': [
    { url: 'https://example.com/llms.txt', status: 404, headers: { 'content-type': 'text/html' } },
  ],
  'agents-md': [
    {
      url: 'https://example.com/agents.md',
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // One long unbreakable token, on purpose: this is the value that decides whether the
        // evidence block scrolls inside its own region or pushes the document sideways at 320px.
        link: '<https://example.com/agents.md>;rel="alternate";type="text/markdown";title="agents-brief-machine-readable-alternate"',
      },
      excerpt: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agents</title>',
      note: 'redirected via https://example.com/agents',
    },
  ],
};

/**
 * The fixture document, stamped relative to `now`.
 *
 * Relative rather than fixed so the run line is always a plausible recent time, and so the aged
 * branch can be driven by asking for a run an hour ago. `finishedAt` decides both the run line and
 * whether the Run again button renders, which is the one thing about this fixture a test cares
 * about beyond its markup.
 *
 * `origin` is whatever the request asked about, so the fixture reports on the address in the URL
 * rather than always on `example.com`. The evidence URLs stay `example.com`'s: they are quoted
 * response data, and rewriting them per request would make the fixture claim it fetched something.
 *
 * @param {{ now?: Date, minutesAgo?: number, origin?: string }} options
 */
export function fixtureAudit({ now = new Date(), minutesAgo = 3, origin = FIXTURE_ORIGIN } = {}) {
  const finished = new Date(now.getTime() - minutesAgo * 60_000);
  const started = new Date(finished.getTime() - 2400);

  const checks = STEWARD_FAST_CHECKS.map((check) => {
    const status = OUTCOMES[check.id] ?? 'error';
    return {
      id: check.id,
      title: check.title,
      category: check.category,
      severity: check.severity,
      status,
      observed: OBSERVED[check.id] ?? 'no observation recorded',
      ...(status === 'fail' && FIXES[check.id] ? { fix: FIXES[check.id] } : {}),
      evidence: EVIDENCE[check.id] ?? [],
    };
  });

  return {
    schemaVersion: 2,
    tool: { name: 'steward-audit', version: '0.2.0', path: 'function' },
    target: { input: origin, origin },
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    requests: 15,
    categories: [],
    checks,
    notes: [
      'Run with --fast: the rendered-experience checks (Lighthouse, axe) were skipped, so that ' +
        'category is empty rather than clean.',
    ],
  };
}
