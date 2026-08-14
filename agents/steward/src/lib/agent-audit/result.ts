/**
 * The canonical result of an `audit-url` run — one JSON document that every
 * other rendering is derived from (hosted-mcp-server card, "Report format").
 * The markdown summary in `render.ts` and the HTML report in `render-html.ts`
 * each read this and nothing else; the MCP tool in a later stage will do the
 * same, and the audit-agent-readiness-skill card shares the schema.
 *
 * Because those consumers are not all in this repo, the shape is versioned and
 * treated as an interface rather than an internal type. `SCHEMA_VERSION` goes up
 * when a consumer that understood the old document would misread the new one:
 * a removed or re-typed field, or a `status` value that means something else.
 * Adding a check id, or an optional field, does not.
 */

/**
 * Bumped only for a change that breaks a reader of the previous version.
 *
 * v2 (deep tier): `CATEGORIES` gained `rendered-experience`, so the `categories`
 * array is four rows where it was three, and `check.category` can hold a value a
 * v1 reader has never seen. A reader that switched over the three it knew — to
 * label them, or to lay them out — misreads the new document rather than merely
 * missing a row, which is the line this constant exists to mark.
 */
export const SCHEMA_VERSION = 2;

/**
 * A check's verdict.
 *
 * - `pass` — the surface exists and behaves.
 * - `fail` — a finding. **Absence is a finding, not an error**: a site with no
 *   llms.txt gets a `fail` with a fix, not a crash and not an `error`.
 * - `not-applicable` — the check could not apply, and that is not the site's
 *   fault: robots.txt disallows the path, or a prerequisite surface (a sitemap
 *   to pick a content page from) is missing and already reported by its own
 *   check. Never counted against a site.
 * - `error` — the auditor could not reach a verdict: a transport failure, a
 *   refused target, the time budget. A statement about the run, not the site.
 */
export type CheckStatus = 'pass' | 'fail' | 'not-applicable' | 'error';

/**
 * Fixed set; the markdown summary counts passes per category.
 *
 * The first three are the fast tier: what the site says about itself over plain
 * HTTP. `rendered-experience` is the deep tier — what a browser actually gets —
 * and is kept separate because its checks cost a Chrome launch each and are the
 * ones a `--fast` run does not have.
 */
export const CATEGORIES = [
  'crawlability',
  'discovery',
  'content-access',
  'rendered-experience',
] as const;
export type CheckCategory = (typeof CATEGORIES)[number];

/** Ranks the fix list. Not a score, and never summed — see the card. */
export type Severity = 'high' | 'medium' | 'low';

/**
 * What was fetched and what it said. Every check carries its own evidence so a
 * reader can disagree with the verdict without re-running the audit — the same
 * rule the scorecard is built on.
 */
export interface CheckEvidence {
  /** The URL fetched, if the evidence came from a request. */
  url?: string;
  status?: number;
  /** Only the headers the check actually reasoned about. */
  headers?: Record<string, string>;
  /** A quoted excerpt of the response, truncated. Never the whole body. */
  excerpt?: string;
  /** A statement about the evidence when there is no response to quote. */
  note?: string;
}

/**
 * The one number a check is about, when it has one.
 *
 * Exists because the HTML report leads with the rendered-experience numbers, and
 * a renderer that had to recover `96` by regex out of an `observed` sentence
 * would be reading prose as data — the failure mode `render.ts`'s docblock names.
 * The number is in the document, so the headline is a lookup.
 *
 * Optional and additive: a check without a measurable number omits it, and a
 * consumer that has never heard of it reads the document exactly as before,
 * which is why this did not move `SCHEMA_VERSION`.
 */
export interface CheckMetric {
  /** Two or three words, for a headline tile: "Performance", "axe violations". */
  label: string;
  /** The number, already rounded to what should be displayed. */
  value: number;
  /**
   * What the number is. `score` is 0–100 and higher is better; `count` is a
   * tally of findings, where zero is the good end. A renderer needs the
   * direction before it can say anything about the number.
   */
  unit: 'score' | 'count';
  /**
   * How many pages the number covers, when it is an aggregate over a sample.
   *
   * The deep tier renders three pages of a site that may have three hundred, and
   * a headline number with no sample size beside it reads as a verdict on the
   * whole site (build-log entry 21, recommendation 3).
   */
  pages?: number;
}

export interface CheckResult {
  /** Stable across versions; consumers key on it. */
  id: string;
  /** Human-readable, present tense, states what a pass means. */
  title: string;
  category: CheckCategory;
  severity: Severity;
  status: CheckStatus;
  /** One line: what was actually observed. Present for every status. */
  observed: string;
  /**
   * What to do about it, written for a stranger who has never seen this tool
   * and does not know the standard by name. Present whenever `status` is `fail`.
   */
  fix?: string;
  /** The headline number, for the checks that measure one. See `CheckMetric`. */
  metric?: CheckMetric;
  evidence: CheckEvidence[];
}

export interface CategoryCount {
  category: CheckCategory;
  passed: number;
  /** Checks that returned a verdict about the site: `pass` + `fail`. */
  applicable: number;
  notApplicable: number;
  errors: number;
}

export interface AuditResult {
  schemaVersion: number;
  /**
   * What ran the audit, and the string it arrived under.
   *
   * `userAgent` is optional because a document written before it existed is
   * still a valid document (adding an optional field does not move
   * `SCHEMA_VERSION`); every report this code produces carries it. It is here so
   * that the report is a place a site owner can read the exact string to match
   * in their access log or refuse in robots.txt, which is the question a report
   * gets read for after the checks themselves.
   */
  tool: { name: string; version: string; userAgent?: string };
  target: {
    /** Exactly what the caller typed. */
    input: string;
    /** The origin everything was fetched relative to. */
    origin: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /**
   * HTTP requests the auditor made itself, redirect hops included.
   *
   * Not the whole cost of a deep run: a rendered page makes its own requests,
   * from inside Chrome, and nothing here sees them. `browserPages` is the rest
   * of that sentence.
   */
  requests: number;
  /** Pages rendered in a browser. Absent on a fast-only run. */
  browserPages?: number;
  /** Per-category pass counts. No composite score, by decision — see the card. */
  categories: CategoryCount[];
  checks: CheckResult[];
  /**
   * Run-level problems that are not about any one check: the time budget ran
   * out, robots.txt could not be read so obedience was assumed strict.
   */
  notes: string[];
}

/** Rolls the per-check verdicts up into the per-category counts. */
export function countByCategory(checks: CheckResult[]): CategoryCount[] {
  return CATEGORIES.map((category) => {
    const mine = checks.filter((c) => c.category === category);
    return {
      category,
      passed: mine.filter((c) => c.status === 'pass').length,
      applicable: mine.filter((c) => c.status === 'pass' || c.status === 'fail').length,
      notApplicable: mine.filter((c) => c.status === 'not-applicable').length,
      errors: mine.filter((c) => c.status === 'error').length,
    };
  });
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * The failed checks, worst first — the order the fix list is printed in.
 *
 * Severity, then the order the checks were declared in, which is roughly the
 * order they depend on each other: robots before sitemap before the pages the
 * sitemap named.
 */
export function rankedFixes(checks: CheckResult[]): CheckResult[] {
  const declared = new Map(checks.map((c, i) => [c.id, i]));
  return checks
    .filter((c) => c.status === 'fail')
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (declared.get(a.id) ?? 0) - (declared.get(b.id) ?? 0),
    );
}

/**
 * Removes C0 and C1 control characters, and DEL, from a string that came off
 * the network.
 *
 * Every string in this document is quoted back to somebody: into a terminal by
 * the CLI, into a markdown file, and later into an HTML report. A response body
 * or a header value is attacker-controlled text, and `ESC [` in it is enough to
 * repaint a terminal, hide a line, or make a failing check print as a passing
 * one. Collapsing whitespace does not help — `\x1b` is not whitespace.
 *
 * The tab/newline/carriage-return cases are removed here too rather than
 * preserved: this runs on text that is about to be flattened onto one line
 * anyway.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/**
 * Trims a response body down to a quotable excerpt: one line, bounded, control
 * characters removed, with the truncation visible rather than silent.
 */
export function excerpt(text: string, max = 240): string {
  const flat = stripControlChars(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** The bound on one header value in evidence. See `evidenceHeaders`. */
export const HEADER_EXCERPT_MAX = 200;

/**
 * Bounds every header value on its way into evidence, the same way a response
 * body is bounded.
 *
 * A header value is response text like any other, and nothing in HTTP limits how
 * long one may be. Real runs found it: stripe.com and temporal.io both answer
 * with a preload `Link` header of about six kilobytes, and quoting it verbatim
 * put the whole thing in the JSON and then in the markdown summary, where it
 * buried the finding it was evidence for. `excerpt` also strips the control
 * characters, which matters more here than in a body: a header value reaches the
 * terminal with less between it and the screen.
 */
export function evidenceHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = excerpt(value, HEADER_EXCERPT_MAX);
  }
  return out;
}
