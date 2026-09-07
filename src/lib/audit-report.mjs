/**
 * The /audit page's arithmetic: everything the page shows that is derived from a run, and
 * nothing that touches a network, a store or a clock it was not handed.
 *
 * The route (src/pages/audit.astro) is the transport and the component is the markup; this file
 * is the part worth testing, and it is testable because a run result is a plain JSON document
 * (`AuditResult` in the Steward workspace's `agent-audit/fast` entry). Same split as
 * src/lib/a2a-responder.mjs and src/lib/mcp-rate-limit.mjs: the interesting half never needs a
 * deploy to exercise.
 *
 * THREE STATUS WORDS, NOT FOUR. The document distinguishes `not-applicable` (the check could not
 * apply) from `error` (the auditor reached no verdict), and the page merges them into one N/A —
 * Matt, 2026-09-05. The distinction survives in the JSON, which is where a reader who cares about
 * it is reading; on the page it is one column and one word, because a visitor who has just pasted
 * an address is being told what their site does, and "not judged" is a statement about the run.
 *
 * COUNTS FOLLOW STEWARD'S OWN REPORT. `Checked` is the *applicable* count — the checks that
 * returned a verdict about the site — exactly as `render-html.ts`'s counts table uses it, so
 * Failed is Checked minus Passed and the two reports cannot disagree about what a column means.
 * The headline count is over every check the run made, which is the number a person means by
 * "how many checks are there".
 *
 * NOTHING HERE INVENTS A SENTENCE. Every string a check contributes — its title, its observed
 * line, its fix, its evidence — comes off the document. The page's own words come from
 * docs/projects/audit-page/content-inventory.md and live in the component beside the markup that
 * renders them.
 */

/** The three fast-tier categories, in report order, with the labels the inventory fixes. */
export const GROUPS = [
  { id: 'crawlability', label: 'Crawlability', summary: 'What the site says an agent may do.' },
  { id: 'discovery', label: 'Discovery', summary: 'What an agent can find without being told where to look.' },
  { id: 'content-access', label: 'Content access', summary: 'Whether the content comes back in a form a model can read.' },
];

/** Ranks the fix list. The document's own order, restated here so this file needs no import. */
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The status word the page prints, for any status a document can carry.
 *
 * A `Record<string, …>` with a fallback for the reason `render-html.ts` gives: the result document
 * is an interface a newer auditor can write, and a status this page has never seen must render as
 * "N/A" rather than as the word `undefined`. N/A is the honest fallback here because every status
 * that is not a verdict about the site is one.
 *
 * @param {string} status
 * @returns {'Pass' | 'Fail' | 'N/A'}
 */
export function statusWord(status) {
  if (status === 'pass') return 'Pass';
  if (status === 'fail') return 'Fail';
  return 'N/A';
}

/** The class modifier that reinforces the word with a fill. Colour is never the only sign. */
export function statusKind(status) {
  if (status === 'pass') return 'pass';
  if (status === 'fail') return 'fail';
  return 'na';
}

/**
 * `DD MMM YYYY`, in UTC.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat`, which is what `formatVerifiedLabel` in
 * src/data/sitemap-lastmod.mjs uses: the ICU data a serverless runtime ships is not this repo's
 * to depend on for a string a test pins character for character.
 *
 * @param {Date} at
 */
export function formatDate(at) {
  const day = String(at.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** `HH:MM`, in UTC. The report's times are machine facts, so they are stamped in UTC. */
export function formatTime(at) {
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * How long the run took, in seconds, to one decimal place.
 *
 * One decimal because the number is a courtesy to the site being audited — "2.4 seconds" says
 * this cost you almost nothing — and a second decimal would read as a measurement somebody should
 * act on.
 */
export function formatSeconds(ms) {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

/**
 * Is this report from an hour other than the current one?
 *
 * The hour is the deduplication bucket the standalone activity ID uses
 * (`fastAuditActivityIdFor`), so a report run inside the current hour is the report a fresh run
 * would return: offering "Run again" there would spend a caller's rate-limit slot to be handed
 * back the same document. Outside it, a new run is a real new run.
 *
 * Compared on the UTC hour string rather than on elapsed minutes, for the same reason the ID is
 * bucketed rather than aged: two runs in the same bucket are the same run as far as the auditor
 * is concerned, whether they are one minute or fifty-nine apart.
 *
 * @param {Date} ranAt
 * @param {Date} now
 */
export function isAged(ranAt, now) {
  return utcHour(ranAt) !== utcHour(now);
}

/** The UTC hour bucket a moment falls in: `2026-09-05T13`. The activity ID's own granularity. */
export function utcHour(at) {
  return at.toISOString().slice(0, 13);
}

/**
 * When the edge may stop serving a rendered report, as seconds from `now`.
 *
 * The report is immutable for the rest of its hour — a second GET in the same hour reads the same
 * pointer and the same result — and at the top of the next hour it gains a Run again button. So
 * the cache lifetime is exactly the time left in the hour, which is the same arithmetic the rate
 * limiter's fixed windows use and for the same reason: the bucket is in the value, so the TTL is
 * derivable from the clock alone.
 *
 * Floored at one second: a request landing in the last fractions of an hour must not be handed a
 * zero or a negative max-age.
 *
 * @param {Date} now
 */
export function secondsLeftInHour(now) {
  const nextHour = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1,
  );
  return Math.max(1, Math.ceil((nextHour - now.getTime()) / 1000));
}

/**
 * Why a run produced no verdict about the site, or `null` when it produced one.
 *
 * **Read off the finished document, not off a thrown error, because a fast audit almost never
 * throws.** `runFastAudit` throws only for a target it cannot parse or a scheme it will not fetch;
 * a refused robots.txt, a DNS failure, an address the guard blocks and a spent time budget all
 * come back as a complete document whose checks each carry an `error` status. That document reads
 * as a report — thirteen rows, a passed count of zero — and rendering it would tell a visitor
 * their site failed every check when in fact nothing was checked.
 *
 * **The predicate is "did anything come back from the origin", and it is read off the evidence
 * rather than off the statuses.** "Did any check reach a verdict" is the obvious predicate and it
 * is wrong: measured against `https://nonexistent.invalid` on 2026-09-06, a name that does not
 * resolve still produces two `fail` verdicts, because "no sitemap is declared" and "there is no
 * agent card" are decided from the absence of a robots.txt rather than from a request. A report
 * saying a site has no sitemap is a report about a site nothing ever reached.
 *
 * What no unreachable run can produce is an HTTP status: every evidence entry of that run carries
 * a `url` and a note and nothing else. One response anywhere in the document means the origin
 * answered something, and from there a partial report with its own notes is a better answer than
 * an error page — which is why a budget that ran out halfway renders a report rather than the
 * timeout state, and only a budget that ran out before anything came back is the timeout state.
 *
 * **A site that refuses this auditor in robots.txt is the refused state, and it is the one case
 * decided from a note.** That run does reach the origin — it reads robots.txt, which is the one
 * fetch not gated on robots.txt — and then reports every remaining check as not-applicable. There
 * is a real report there, and it would render under a headline of "1 of 13 checks passed", which
 * says a site failed twelve checks when it in fact declined to be checked at all. The note is
 * `checkRobots`'s own words, so this reads the auditor's finding rather than re-deriving it.
 *
 * | Marker | State | Why |
 * |---|---|---|
 * | `budgetExhausted` | `timeout` | The budget, reported by `AuditContext` |
 * | `privateAddress` | `bad-address` | The address guard refused a private or reserved address |
 * | `embeddedCredentials`, `unsupportedScheme` | `bad-address` | The guard's other refusals |
 * | anything else, including `DNS lookup failed` | `refused` | The site did not answer |
 *
 * A name that does not resolve is deliberately `refused` rather than `bad-address`: from the
 * visitor's side "example.invalid does not exist" and "example.com is down" are the same event,
 * and the inventory's refused copy — "The site refused the audit or could not be reached" — covers
 * both. `bad-address` is reserved for what the visitor typed being unauditable, which is the only
 * case where the fix is to type something else.
 *
 * **THE MARKERS ARE PASSED IN, NOT WRITTEN HERE.** Every fragment above is a sentence Steward
 * composes, and until 2026-09-06 this function matched hand-copied literals of them: nothing held
 * the two sides together, so rewording an error message in `checks.ts` or `safe-fetch.ts` would
 * have turned a refused private address into a "the site did not answer" page with no test going
 * red. They are exported as `RUN_FAILURE_MARKERS` and `BLOCKED_REASON_MARKERS` from the
 * `agent-audit/fast` entry now, and the caller hands them over.
 *
 * They are a parameter rather than an import for one reason: this module is imported by
 * `tests/audit-page.test.mjs` under bare `node --test`, and the entry is TypeScript source that
 * only the Vite build transpiles. An import here would take the whole suite with it. The routes
 * that call this already import that entry, so the values reach the real call sites unchanged, and
 * the test reads them out of the Steward source rather than restating them.
 *
 * @param {{ checks?: Array<{ status: string, observed?: string, evidence?: Array<{ status?: number }> }>,
 *           notes?: string[] }} audit
 * @param {{ budgetExhausted: string, robotsDisallowsAuditor: string, privateAddress: string,
 *           embeddedCredentials: string, unsupportedScheme: string }} markers
 *        `{ ...RUN_FAILURE_MARKERS, ...BLOCKED_REASON_MARKERS }` from `@mattpyle/steward/agent-audit/fast`
 * @returns {'timeout' | 'bad-address' | 'refused' | null}
 */
export function classifyRunFailure(audit, markers) {
  const checks = audit?.checks ?? [];
  const notes = audit?.notes ?? [];

  if (notes.some((note) => note.includes(markers.robotsDisallowsAuditor))) {
    return 'refused';
  }

  const answered = checks.some((check) =>
    (check.evidence ?? []).some((entry) => typeof entry.status === 'number'),
  );
  if (answered) return null;

  const observed = checks.map((check) => check.observed ?? '').join(' | ');
  if (observed.includes(markers.budgetExhausted)) return 'timeout';
  if (
    observed.includes(markers.privateAddress) ||
    observed.includes(markers.embeddedCredentials) ||
    observed.includes(markers.unsupportedScheme)
  ) {
    return 'bad-address';
  }
  return 'refused';
}

/**
 * The whole report, shaped for the template.
 *
 * One pass over the document rather than a helper per section, so every number on the page comes
 * from one tally: the headline count, the per-group columns and the fix list cannot disagree
 * about how many checks failed, which is the failure a second literal always eventually produces.
 *
 * @param {any} audit the canonical `AuditResult`
 * @param {Date} now
 */
export function reportView(audit, now) {
  const checks = audit.checks ?? [];
  const finishedAt = new Date(audit.finishedAt);

  const groups = GROUPS.map((group) => {
    const mine = checks.filter((check) => check.category === group.id);
    const passed = mine.filter((check) => check.status === 'pass').length;
    const checked = mine.filter((check) => check.status === 'pass' || check.status === 'fail').length;
    return {
      ...group,
      checks: mine.map(rowView),
      counts: {
        checked,
        passed,
        failed: checked - passed,
        na: mine.length - checked,
      },
    };
  }).filter((group) => group.checks.length > 0);

  const fixes = checks
    .filter((check) => check.status === 'fail')
    .map((check, index) => ({ check, index }))
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.check.severity] ?? 3) - (SEVERITY_ORDER[b.check.severity] ?? 3) ||
        a.index - b.index,
    )
    .map(({ check }) => ({
      ...rowView(check),
      group: GROUPS.find((group) => group.id === check.category)?.label ?? check.category,
      fix: check.fix ?? '',
      evidence: (check.evidence ?? []).map(evidenceView),
    }));

  return {
    origin: audit.target?.origin ?? '',
    ranDate: formatDate(finishedAt),
    ranTime: formatTime(finishedAt),
    requests: audit.requests ?? 0,
    seconds: formatSeconds(audit.durationMs ?? 0),
    passed: checks.filter((check) => check.status === 'pass').length,
    total: checks.length,
    aged: isAged(finishedAt, now),
    groups,
    fixes,
    checks: checks.map(rowView),
    notes: audit.notes ?? [],
    toolName: audit.tool?.name ?? 'steward-audit',
    toolVersion: audit.tool?.version ?? '',
    generatedDate: formatDate(finishedAt),
    generatedTime: formatTime(finishedAt),
  };
}

/** One check, as the row and the fix entry both read it. */
function rowView(check) {
  return {
    id: check.id,
    title: check.title,
    observed: check.observed ?? '',
    severity: check.severity ?? 'low',
    status: statusWord(check.status),
    kind: statusKind(check.status),
  };
}

/**
 * One evidence entry, flattened to what the disclosure prints.
 *
 * Headers arrive as an object and leave as a list of `name: value` lines, because the template
 * renders them as text in a scroll region rather than as a table: one evidence entry can carry a
 * single header, and a table of one row is furniture around a fact.
 */
function evidenceView(entry) {
  return {
    url: entry.url ?? '',
    status: entry.status === undefined ? '' : String(entry.status),
    headers: Object.entries(entry.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    excerpt: entry.excerpt ?? '',
    note: entry.note ?? '',
  };
}
