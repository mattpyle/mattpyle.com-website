import type { Finding, Verdict } from './report.js';

/**
 * Pure mapping from raw axe / Lighthouse output to findings and metrics.
 *
 * Split out from the activity so it can be tested against canned JSON without
 * running a build, a browser, or a server. The activity's own correctness is
 * verified live; this is the part with branching logic worth unit tests.
 */

/** Lighthouse score floors (spec §8.5 step 6). Below → `flag`, never `block`. */
export const FLOORS: Record<string, number> = {
  performance: 90,
  accessibility: 100,
  'best-practices': 100,
  seo: 100,
  // "Anything else < 100" per spec §8.5 step 6 — and this one is the reason the
  // site exists, so it is not left to chance.
  'agentic-browsing': 100,
};

// --- axe -------------------------------------------------------------------

export interface AxeNode {
  html?: string;
  target?: string[];
  failureSummary?: string;
}
export interface AxeViolation {
  id: string;
  impact?: string | null;
  help?: string;
  description?: string;
  helpUrl?: string;
  nodes?: AxeNode[];
}

/**
 * Drafts have no generated OG image — `generate-og-images.mjs` deliberately
 * excludes them, so a draft page's `og:image` points at a PNG that does not
 * exist yet. That is expected and documented (spec §8.5 caveat), not a defect in
 * the post, so any violation that is only about the missing OG image is dropped
 * rather than reported. Filtering it here keeps the "0 violations" bar honest:
 * the alternative is every draft audit failing on a known non-issue, which would
 * train the human to ignore the block.
 */
export function isExpectedDraftNonFinding(v: AxeViolation): boolean {
  const ogRules = new Set(['image-alt', 'meta-viewport']);
  if (!ogRules.has(v.id)) return false;
  const nodes = v.nodes ?? [];
  if (nodes.length === 0) return false;
  return nodes.every((n) => /og[:-]?image|\/og\/writing\//i.test(n.html ?? ''));
}

export function axeFindings(violations: AxeViolation[], file: string, url: string): Finding[] {
  return violations.filter((v) => !isExpectedDraftNonFinding(v)).map((v, i) => {
    const nodes = v.nodes ?? [];
    const targets = nodes
      .slice(0, 3)
      .map((n) => (n.target ?? []).join(' '))
      .filter(Boolean);
    return {
      id: `build_audit.axe.${v.id}.${i}`,
      pass: 'build_audit' as const,
      // The site holds a 0-violation record and drafts are held to it (spec §8.5
      // step 5). Impact level does not soften this — a violation blocks.
      severity: 'block' as Verdict,
      message: `axe: ${v.help ?? v.id}${v.impact ? ` (${v.impact})` : ''} — ${nodes.length} element${nodes.length === 1 ? '' : 's'}`,
      file,
      excerpt: nodes[0]?.html?.slice(0, 300),
      evidence: [
        `rule: ${v.id}`,
        `url: ${url}`,
        targets.length ? `selectors: ${targets.join(' | ')}` : '',
        v.helpUrl ? `docs: ${v.helpUrl}` : '',
        nodes[0]?.failureSummary ? `why: ${nodes[0].failureSummary}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });
}

// --- Lighthouse ------------------------------------------------------------

export interface LighthouseLike {
  categories?: Record<
    string,
    { title?: string; score?: number | null; auditRefs?: Array<{ id: string; weight?: number }> }
  >;
  audits?: Record<string, { score?: number | null; title?: string; scoreDisplayMode?: string }>;
}

export interface AuditMetrics {
  url: string;
  scores: Record<string, number>;
  failedAudits?: string[];
}

export function lighthouseMetrics(lhr: LighthouseLike, url: string): Omit<AuditMetrics, 'axeViolations' | 'axeFiltered'> {
  const scores: Record<string, number> = {};
  for (const [key, cat] of Object.entries(lhr.categories ?? {})) {
    if (typeof cat.score === 'number') scores[key] = Math.round(cat.score * 100);
  }

  const audits = lhr.audits ?? {};

  // Which audits actually failed. A bare "seo scored 66" is not debuggable six
  // months later; the audit ids are what turn a score into a diagnosis.
  const failedAudits = Object.entries(audits)
    .filter(([, a]) => a?.score === 0)
    .map(([id]) => id)
    .sort();

  return { url, scores, failedAudits };
}

// --- Agentic Browsing checks -------------------------------------------------

/**
 * One Agentic Browsing check, as actually reported for a page.
 *
 * `applicable` mirrors Lighthouse's own `scoreDisplayMode`/`score === null`
 * convention: a check that did not run for this page (e.g. WebMCP schema
 * validity where the page registers no tools) is `applicable: false`, never a
 * silent pass or fail. `passed` is only meaningful when `applicable` is true.
 */
export interface AgenticCheck {
  id: string;
  title: string;
  applicable: boolean;
  passed: boolean;
}

/**
 * The real, scored Agentic Browsing checks for one page — replaces the old
 * `AGENTIC_AUDITS` guess, which named ids (`agentic-cls`,
 * `agentic-content-visibility`, ...) that this pinned Lighthouse version has
 * never actually returned. The real ids and shape were captured from a live
 * run against production (`lhr.categories['agentic-browsing'].auditRefs`):
 * `agent-accessibility-tree`, `webmcp-schema-validity`,
 * `cumulative-layout-shift`, and `llms-txt`, each `weight: 1` with
 * `scoreDisplayMode: 'binary'` or `'numeric'`.
 *
 * The category also lists `webmcp-form-coverage` and `webmcp-registered-tools`
 * — both permanently `weight: 0` in the category definition, and
 * `scoreDisplayMode: 'informative'`/`'notApplicable'` rather than a pass/fail
 * grade (the latter lists the registered tools; it is not a check anyone can
 * fail). Filtering to `weight > 0` is what keeps those two out of the checks
 * set — they are real Lighthouse output, just not gradeable ones.
 */
export function agenticChecks(lhr: LighthouseLike): AgenticCheck[] {
  const refs = lhr.categories?.['agentic-browsing']?.auditRefs ?? [];
  const audits = lhr.audits ?? {};
  return refs
    .filter((ref) => (ref.weight ?? 0) > 0)
    .map((ref) => {
      const audit = audits[ref.id];
      const score = audit?.score;
      const applicable = typeof score === 'number';
      return {
        id: ref.id,
        title: audit?.title ?? ref.id,
        applicable,
        passed: applicable && score === 1,
      };
    });
}

/**
 * The second expected draft non-finding, found live on the first real audit.
 *
 * Draft pages render `<meta name="robots" content="noindex">` — correctly; an
 * unpublished post must not be indexed. Lighthouse's SEO category treats
 * "blocked from indexing" as a near-total failure, which scored this draft **66**
 * against a floor of 100. That number says nothing about the post: every draft
 * will score it, every time, for a reason the site intends.
 *
 * So a below-floor SEO score is suppressed when `is-crawlable` is the audit that
 * failed. The score is still recorded in `metrics` — it is not hidden, just not
 * dressed up as a finding the author is expected to act on. Same reasoning as
 * the OG-image filter: a check that always fires trains the human to ignore it.
 */
export function isExpectedDraftSeoPenalty(lhr: LighthouseLike): boolean {
  return lhr.audits?.['is-crawlable']?.score === 0;
}

/** Category scores below their floor become `flag` findings — never `block`. */
export function lighthouseFindings(
  scores: Record<string, number>,
  file: string,
  url: string,
  opts: { suppressSeo?: boolean } = {},
): Finding[] {
  const out: Finding[] = [];
  for (const [key, floor] of Object.entries(FLOORS)) {
    const score = scores[key];
    if (typeof score !== 'number' || score >= floor) continue;
    if (key === 'seo' && opts.suppressSeo) continue;
    out.push({
      id: `build_audit.lighthouse.${key}`,
      pass: 'build_audit',
      // Lab variance is real; Lighthouse informs, it does not gate (spec §8.5).
      severity: 'flag',
      message: `Lighthouse ${key} scored ${score}, below the site floor of ${floor}.`,
      file,
      evidence: `url: ${url}\nscore: ${score}\nfloor: ${floor}`,
    });
  }
  return out;
}

export function overallVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'block')) return 'block';
  if (findings.some((f) => f.severity === 'flag')) return 'flag';
  return 'pass';
}
