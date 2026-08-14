import {
  AUDIT_USER_AGENT,
  AUDIT_VERSION,
  BlockedTargetError,
  BudgetExhaustedError,
  SafeFetcher,
  type FetchPolicy,
  type SafeResponse,
} from './safe-fetch.js';
import { AI_AGENTS, isAllowed, parseRobots, type ParsedRobots } from './robots.js';
import type { DeepOptions } from './deep.js';
import {
  SCHEMA_VERSION,
  countByCategory,
  evidenceHeaders,
  excerpt,
  type AuditResult,
  type CheckCategory,
  type CheckEvidence,
  type CheckResult,
  type CheckStatus,
  type Severity,
} from './result.js';

/**
 * The fast tier's checks: what a stranger's site says about itself over plain
 * HTTP, in seconds, with no browser.
 *
 * **Behaviour over presence, wherever the two differ.** The prior art
 * (isitagentready.com) checks that a surface responds; this checks that it does
 * the thing it exists to do. A 200 from `/llms.txt` that is actually the site's
 * HTML 404 page is a fail here. A homepage that answers `Accept: text/markdown`
 * with HTML is a fail here. That gap is the whole reason to build this rather
 * than link to theirs (hosted-mcp-server card, "Prior art").
 *
 * The checks run in sequence, not in parallel: they share one time budget, some
 * depend on each other's findings (the sitemap picks the content page), and a
 * dozen concurrent requests at a stranger's origin is not how a well-behaved
 * auditor arrives.
 */

export const TOOL_NAME = 'steward audit-url';

/**
 * The version stamped on every report, which is the auditor's version and not a
 * second number. `AUDIT_VERSION` in safe-fetch.ts is the source; see its
 * docblock for why there is exactly one.
 */
export const TOOL_VERSION = AUDIT_VERSION;

/**
 * The product token the auditor identifies as, and obeys robots.txt under.
 *
 * It is the first token of `AUDIT_USER_AGENT` and has to stay that way: a site owner reads the
 * product token out of their access log and writes it into robots.txt, so a token that does not
 * match the User-Agent is a refusal that silently does nothing. A test in
 * tests/lib/agent-audit-safe-fetch.test.ts holds the two together.
 */
export const AUDIT_AGENT_TOKEN = 'steward-audit';

// ---------------------------------------------------------------------------
// Fetch plumbing shared by the checks
// ---------------------------------------------------------------------------

type GetOutcome =
  | { kind: 'ok'; res: SafeResponse }
  | { kind: 'robots'; url: string; detail: string }
  | { kind: 'error'; url: string; message: string; fatal: boolean };

class AuditContext {
  /** The audited origin's robots.txt. The checks that report on it read this. */
  robots: ParsedRobots | null = null;
  readonly notes: string[] = [];
  /** Set once the time budget or a fatal refusal ends the run early. */
  aborted: string | null = null;
  /**
   * robots.txt per origin, because llms.txt and a `Sitemap:` line may both point
   * at another host. Judging an off-origin path against the *audited* site's
   * robots.txt, which is what this did first, is wrong twice over: it applies
   * rules the other host never wrote, and it fetches that host having consulted
   * nothing it did write. Each origin is fetched at most once.
   */
  private readonly robotsByOrigin = new Map<string, ParsedRobots | null>();

  constructor(
    readonly origin: string,
    readonly fetcher: SafeFetcher,
  ) {}

  url(pathOrUrl: string): string {
    return new URL(pathOrUrl, this.origin).href;
  }

  /** Records the audited origin's robots.txt, parsed by `checkRobots`. */
  setRobots(robots: ParsedRobots | null): void {
    this.robots = robots;
    this.robotsByOrigin.set(this.origin, robots);
  }

  /**
   * The robots.txt governing `origin`, fetched if this is the first time it has
   * come up. `null` means "could not be read", which this treats as no
   * restrictions — see the note `checkRobots` pushes when that happens.
   */
  private async robotsFor(origin: string): Promise<ParsedRobots | null> {
    const cached = this.robotsByOrigin.get(origin);
    if (cached !== undefined) return cached;
    let parsed: ParsedRobots | null = null;
    try {
      const res = await this.fetcher.fetch(new URL('/robots.txt', origin).href);
      if (res.status === 200 && !(res.headers['content-type'] ?? '').toLowerCase().includes('text/html')) {
        parsed = parseRobots(res.body);
      }
    } catch {
      // Same posture as the audited origin's own unreadable robots.txt.
      parsed = null;
    }
    this.robotsByOrigin.set(origin, parsed);
    return parsed;
  }

  /**
   * Fetches a URL, obeying the robots.txt **of the host being fetched**.
   *
   * Never throws: a refusal, a timeout and a dead socket are all outcomes the
   * checks report as evidence. `fatal` marks the ones that mean no later fetch
   * will work either (the budget is spent), so the run can stop early instead of
   * grinding through a dozen identical failures.
   */
  /**
   * `null` when this auditor may fetch `url`, and the deciding rule when it may
   * not — the robots.txt of the host being asked for, not of the audited site.
   *
   * Public because the deep tier needs the same verdict about a page it is about
   * to hand to Chrome rather than fetch: robots.txt governs what the auditor
   * looks at, not which library does the looking.
   */
  async robotsDetail(url: string): Promise<string | null> {
    const target = new URL(url);
    const robots =
      target.origin === this.origin ? this.robots : await this.robotsFor(target.origin);
    if (!robots) return null;
    const verdict = isAllowed(robots, AUDIT_AGENT_TOKEN, `${target.pathname}${target.search}`);
    if (verdict.allowed) return null;
    const rule = verdict.rule;
    const whose = target.origin === this.origin ? 'robots.txt' : `${target.origin}/robots.txt`;
    return rule
      ? `${whose}: "Disallow: ${rule.path}" under User-agent: ${rule.agents.join(', ')}`
      : `${whose} disallows it`;
  }

  async get(pathOrUrl: string, headers?: Record<string, string>): Promise<GetOutcome> {
    const url = this.url(pathOrUrl);
    if (this.aborted) return { kind: 'error', url, message: this.aborted, fatal: true };

    const detail = await this.robotsDetail(url);
    if (detail) return { kind: 'robots', url, detail };

    try {
      return { kind: 'ok', res: await this.fetcher.fetch(url, { headers }) };
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        this.aborted = 'the audit ran out of its time budget';
        return { kind: 'error', url, message: this.aborted, fatal: true };
      }
      if (err instanceof BlockedTargetError) {
        return { kind: 'error', url, message: err.reason, fatal: false };
      }
      return {
        kind: 'error',
        url,
        message: err instanceof Error ? err.message : String(err),
        fatal: false,
      };
    }
  }
}

/**
 * Evidence from a response, quoting only the headers a check reasoned about.
 *
 * `label` names the request this line came from, for the checks that make more
 * than one. Without it, the two evidence lines of a failed negotiation check —
 * the plain request and the `Accept: text/markdown` one — are indistinguishable,
 * and when both return HTML they are identical text.
 */
function evidenceOf(
  res: SafeResponse,
  headerNames: string[] = ['content-type'],
  label?: string,
): CheckEvidence {
  const headers: Record<string, string> = {};
  for (const name of headerNames) {
    const value = res.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const ev: CheckEvidence = { url: res.url, status: res.status, headers: evidenceHeaders(headers) };
  if (res.body) ev.excerpt = excerpt(res.body);
  const notes = [
    label,
    res.redirects.length ? `redirected via ${res.redirects.join(' → ')}` : null,
  ].filter(Boolean);
  if (notes.length) ev.note = notes.join('; ');
  return ev;
}

function contentType(res: SafeResponse): string {
  return (res.headers['content-type'] ?? '').toLowerCase();
}

/**
 * Does this response look like an HTML page rather than the file that was
 * asked for?
 *
 * The single most common false pass in a presence-only audit: a framework that
 * answers every unmatched path with the app shell, status 200. A checker that
 * only looks at the status code reports llms.txt as present on a site that has
 * never heard of it.
 */
function looksLikeHtml(res: SafeResponse): boolean {
  if (contentType(res).includes('text/html')) return true;
  return /^\s*(<!doctype html|<html[\s>])/i.test(res.body);
}

// ---------------------------------------------------------------------------
// Check construction
// ---------------------------------------------------------------------------

interface CheckSpec {
  id: string;
  title: string;
  category: CheckCategory;
  severity: Severity;
}

function result(
  spec: CheckSpec,
  status: CheckStatus,
  observed: string,
  evidence: CheckEvidence[] = [],
  fix?: string,
): CheckResult {
  return { ...spec, status, observed, evidence, ...(fix ? { fix } : {}) };
}

/** Turns a failed `get` into the check result it implies, uniformly. */
function fromFailedGet(spec: CheckSpec, outcome: Exclude<GetOutcome, { kind: 'ok' }>): CheckResult {
  if (outcome.kind === 'robots') {
    return result(spec, 'not-applicable', `not fetched — ${outcome.detail}`, [
      { url: outcome.url, note: outcome.detail },
    ]);
  }
  return result(spec, 'error', `could not fetch: ${outcome.message}`, [
    { url: outcome.url, note: outcome.message },
  ]);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const ROBOTS: CheckSpec = {
  id: 'robots-txt',
  title: 'robots.txt exists and parses',
  category: 'crawlability',
  severity: 'medium',
};

async function checkRobots(ctx: AuditContext): Promise<CheckResult> {
  // The one fetch that is not gated on robots.txt, for the obvious reason.
  const outcome = await ctx.get('/robots.txt');
  if (outcome.kind !== 'ok') {
    ctx.notes.push(
      'robots.txt could not be read, so the audit fetched every path it wanted. ' +
        'A site that meant to restrict this auditor did not get the chance.',
    );
    return fromFailedGet(ROBOTS, outcome);
  }
  const res = outcome.res;
  const ev = [evidenceOf(res)];

  if (res.status === 404 || res.status === 410) {
    return result(
      ROBOTS,
      'fail',
      `${res.status} — the origin serves no robots.txt`,
      ev,
      'Add a robots.txt at the site root. Without one there is nowhere to declare your sitemap, ' +
        'and nowhere to say which AI agents may read the site — every agent has to guess, and they guess differently.',
    );
  }
  if (res.status !== 200) {
    return result(
      ROBOTS,
      'fail',
      `robots.txt returned ${res.status}`,
      ev,
      'Serve robots.txt with a 200 status. Crawlers treat a 5xx as "the whole site is off limits", ' +
        'so an erroring robots.txt is worse than a missing one.',
    );
  }
  if (looksLikeHtml(res)) {
    return result(
      ROBOTS,
      'fail',
      'robots.txt returns an HTML page, not a robots file',
      ev,
      'The path answers 200 with HTML, which usually means the site has no robots.txt and the ' +
        'framework is serving its catch-all page. Serve a real text/plain robots.txt at /robots.txt.',
    );
  }

  const parsed = parseRobots(res.body);
  ctx.setRobots(parsed);
  const ourVerdict = isAllowed(parsed, AUDIT_AGENT_TOKEN, '/');
  if (!ourVerdict.allowed) {
    ctx.notes.push(
      'robots.txt disallows this auditor at the site root; the checks below that needed a fetch ' +
        'are reported as not-applicable rather than failed.',
    );
  }

  if (parsed.malformedLines.length > 0) {
    return result(
      ROBOTS,
      'fail',
      `parses, but ${parsed.malformedLines.length} line(s) are not valid robots.txt directives`,
      [
        ...ev,
        {
          url: res.url,
          note: parsed.malformedLines.map((l) => `line ${l.line}: "${l.text}"`).join('; '),
        },
      ],
      'Every non-comment line must be "Field: value", and Allow/Disallow lines must come after a ' +
        'User-agent line. Crawlers skip lines they cannot parse, so a rule in a malformed line is a ' +
        'rule nobody is following.',
    );
  }

  return result(
    ROBOTS,
    'pass',
    `200, ${parsed.groups.length} user-agent group(s), ${parsed.sitemaps.length} sitemap declaration(s)`,
    ev,
  );
}

const AI_RULES: CheckSpec = {
  id: 'robots-ai-agents',
  title: 'robots.txt lets user-triggered AI agents read the site',
  category: 'crawlability',
  severity: 'high',
};

function checkAiAgents(ctx: AuditContext): CheckResult {
  const robots = ctx.robots;
  if (!robots) {
    return result(AI_RULES, 'not-applicable', 'no readable robots.txt, so nothing is blocked');
  }

  const blocked = AI_AGENTS.filter((agent) => !isAllowed(robots, agent.token, '/').allowed);
  const blockedUserTriggered = blocked.filter((a) => a.kind === 'user-triggered');
  const blockedCrawlers = blocked.filter((a) => a.kind === 'crawler');
  const ev: CheckEvidence[] = blocked.map((agent) => {
    const rule = isAllowed(robots, agent.token, '/').rule;
    return {
      note: `${agent.token} (${agent.operator}, ${agent.kind}) is blocked at / by ${
        rule ? `"Disallow: ${rule.path}" under User-agent: ${rule.agents.join(', ')}` : 'a rule'
      }`,
    };
  });

  if (blockedUserTriggered.length > 0) {
    return result(
      AI_RULES,
      'fail',
      `${blockedUserTriggered.map((a) => a.token).join(', ')} cannot fetch the site root`,
      ev,
      `Allow the user-triggered fetchers — ${blockedUserTriggered
        .map((a) => a.token)
        .join(', ')} — even if you block the training crawlers. These agents fetch a page only ` +
        'because a person just asked about it, one page at a time. Blocking them does not protect ' +
        'the site from training corpora; it means the assistant standing in front of your reader ' +
        'has to answer from memory instead of from your page.',
    );
  }

  const observed =
    blockedCrawlers.length > 0
      ? `user-triggered agents are allowed; ${blockedCrawlers.length} training/index crawler(s) are blocked (${blockedCrawlers
          .map((a) => a.token)
          .join(', ')})`
      : `all ${AI_AGENTS.length} named AI agents may fetch the site root`;
  return result(AI_RULES, 'pass', observed, ev);
}

const CONTENT_SIGNALS: CheckSpec = {
  id: 'content-signals',
  // Not "robots.txt declares …" any more: the signal is also read off the
  // response header, and a title that names one source misreports the other.
  title: 'Content Signals preferences are declared',
  category: 'crawlability',
  severity: 'low',
};

/**
 * Content Signals live in robots.txt by the policy's own definition, and also
 * arrive as a `Content-Signal` **response header** in the wild: Cloudflare sets
 * one on the markdown responses it generates, and retool.com answers with
 * `Content-Signal: ai-train=yes, search=yes, ai-input=yes` on every response
 * while its robots.txt says nothing. Reading robots.txt alone reported that site
 * as having expressed no preference, which is the opposite of what it did.
 *
 * So both places are read, and the two are not the same result. The signal is
 * expressed either way — that is what makes a header-only site a pass rather
 * than a finding — but only the robots.txt line is discoverable *before*
 * fetching anything, and a crawler deciding whether to fetch at all reads
 * robots.txt and stops there. Where the signal was found goes in the observed
 * line, because that is the part a reader has to act on.
 */
function checkContentSignals(ctx: AuditContext, homepage: SafeResponse | null): CheckResult {
  const robots = ctx.robots;
  const fromRobots = robots?.contentSignals ?? [];
  const header = homepage?.headers['content-signal'];
  const evidence: CheckEvidence[] = [
    ...fromRobots.map((value) => ({ url: ctx.url('/robots.txt'), note: `Content-Signal: ${value}` })),
    ...(header && homepage
      ? [
          {
            url: homepage.url,
            status: homepage.status,
            headers: evidenceHeaders({ 'content-signal': header }),
          },
        ]
      : []),
  ];

  if (fromRobots.length > 0) {
    return result(
      CONTENT_SIGNALS,
      'pass',
      `declares ${fromRobots.length} Content-Signal line(s) in robots.txt` +
        (header ? ', and repeats the signal as a response header' : ''),
      evidence,
    );
  }
  if (header) {
    return result(
      CONTENT_SIGNALS,
      'pass',
      'the signal is expressed as a Content-Signal response header, but not in robots.txt, so a ' +
        'crawler that reads robots.txt to decide whether to fetch at all never sees it',
      evidence,
    );
  }
  if (!robots) {
    return result(
      CONTENT_SIGNALS,
      'not-applicable',
      'no readable robots.txt, and no Content-Signal response header',
    );
  }
  return result(
    CONTENT_SIGNALS,
    'fail',
    'no Content-Signal directive in robots.txt, and no Content-Signal response header',
    [],
    'Optional, and new. A "Content-Signal:" line in robots.txt states separately whether your ' +
      'content may be used for search indexing, for AI input (answering a question with a ' +
      'citation), and for AI training. Without it, an agent that wants to respect your wishes ' +
      'only has Allow/Disallow, which cannot express "quote me, do not train on me".',
  );
}

const SITEMAP: CheckSpec = {
  id: 'sitemap',
  title: 'A sitemap is declared in robots.txt and fetchable',
  category: 'crawlability',
  severity: 'high',
};

interface SitemapOutcome {
  check: CheckResult;
  /** Page URLs the sitemap listed, for the content-page checks downstream. */
  urls: string[];
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/**
 * How many declared `Sitemap:` lines are actually fetched, the same way
 * `LLMS_LINK_SAMPLE` caps llms.txt links.
 *
 * robots.txt is a file the audited site controls, and nothing in the standard
 * limits how many sitemaps it may declare. Walking all of them turns one line
 * in a stranger's robots.txt into an unbounded number of requests from this
 * tool, which is the sort of thing a fast tier should not be talked into.
 */
const SITEMAP_CANDIDATE_LIMIT = 3;

async function checkSitemap(ctx: AuditContext): Promise<SitemapOutcome> {
  const declared = ctx.robots?.sitemaps ?? [];
  // Conventional locations, probed only when robots.txt declared nothing —
  // finding one here is still a finding, because an agent that has only
  // robots.txt to go on will never look.
  const all = declared.length > 0 ? declared : ['/sitemap-index.xml', '/sitemap.xml'];
  const candidates = all.slice(0, SITEMAP_CANDIDATE_LIMIT);
  const evidence: CheckEvidence[] = [];
  if (all.length > candidates.length) {
    // Said out loud rather than truncated silently: a check that stopped
    // looking has to report that it stopped looking, or a pass reads as
    // "all of them are fine".
    evidence.push({
      note: `robots.txt declares ${all.length} sitemaps; only the first ${candidates.length} were fetched`,
    });
  }
  // A check whose every candidate was refused by robots.txt has learned nothing
  // about the site, and must not report a finding against it.
  let blockedByRobots = 0;

  for (const candidate of candidates) {
    const outcome = await ctx.get(candidate);
    if (outcome.kind !== 'ok') {
      if (outcome.kind === 'robots') blockedByRobots++;
      evidence.push(
        outcome.kind === 'robots'
          ? { url: outcome.url, note: outcome.detail }
          : { url: outcome.url, note: outcome.message },
      );
      if (outcome.kind === 'error' && outcome.fatal) break;
      continue;
    }
    const res = outcome.res;
    evidence.push(evidenceOf(res));
    if (res.status !== 200) continue;
    if (!/<(urlset|sitemapindex)[\s>]/i.test(res.body)) continue;

    let urls = extractLocs(res.body);
    if (/<sitemapindex[\s>]/i.test(res.body) && urls.length > 0) {
      // An index names sitemaps, not pages. One hop deeper is enough to get a
      // page list to sample from; walking all of them is the deep tier's job.
      const sub = await ctx.get(urls[0]);
      if (sub.kind === 'ok' && sub.res.status === 200) {
        evidence.push(evidenceOf(sub.res));
        urls = extractLocs(sub.res.body);
      } else {
        return {
          check: result(
            SITEMAP,
            'fail',
            `the sitemap index at ${res.url} names ${urls.length} sitemap(s), but the first one could not be read`,
            evidence,
            'Every sitemap listed in a sitemap index has to be fetchable at the URL given. ' +
              'A crawler that follows the index and hits a dead entry indexes nothing.',
          ),
          urls: [],
        };
      }
    }

    if (urls.length === 0) {
      return {
        check: result(
          SITEMAP,
          'fail',
          `${res.url} is a valid sitemap but lists no URLs`,
          evidence,
          'The sitemap parses but is empty, so it tells a crawler nothing. Generate it from your ' +
            'published pages at build time rather than committing a placeholder.',
        ),
        urls: [],
      };
    }

    if (declared.length === 0) {
      return {
        check: result(
          SITEMAP,
          'fail',
          `a sitemap with ${urls.length} URLs exists at ${res.url}, but robots.txt does not declare it`,
          evidence,
          `Add "Sitemap: ${res.url}" to robots.txt. The file was only found here by guessing at ` +
            'conventional filenames; an agent reading robots.txt for the site map finds nothing.',
        ),
        urls,
      };
    }

    return {
      check: result(SITEMAP, 'pass', `declared in robots.txt, ${urls.length} URLs listed`, evidence),
      urls,
    };
  }

  if (blockedByRobots === candidates.length) {
    return {
      check: result(SITEMAP, 'not-applicable', 'every candidate sitemap URL is disallowed to this auditor', evidence),
      urls: [],
    };
  }

  return {
    check: result(
      SITEMAP,
      'fail',
      declared.length > 0
        ? `robots.txt declares ${declared.length} sitemap(s), none of which returned a valid sitemap`
        : 'no sitemap declared in robots.txt, and none at the conventional paths',
      evidence,
      'Publish an XML sitemap and declare it with a "Sitemap:" line in robots.txt. It is the only ' +
        'machine-readable list of what pages exist; without it a crawler discovers pages by ' +
        'following links, and anything not linked from the homepage may never be found.',
    ),
    urls: [],
  };
}

const LLMS_TXT: CheckSpec = {
  id: 'llms-txt',
  title: 'llms.txt exists and follows the spec',
  category: 'discovery',
  severity: 'medium',
};

/** A list item under a `##` heading that is not in the form the format asks for. */
export interface OffFormatListItem {
  /** The bullet, truncated. */
  text: string;
  /**
   * Markdown links found anywhere in the bullet. Empty means prose only: there
   * is nothing in the line for any parser to collect. Non-empty means the links
   * are there but the bullet does not lead with one, which is a different
   * problem with a different consequence — see `checkLlmsListItems`.
   */
  links: Array<{ title: string; url: string }>;
}

interface LlmsOutcome {
  check: CheckResult;
  links: Array<{ title: string; url: string }>;
  /** List items under a section heading that are not in the canonical form. */
  offFormatItems: OffFormatListItem[];
  /** False when there was no parseable llms.txt to form an opinion about. */
  parsed: boolean;
}

/** Every `[title](url)` in a line, wherever it sits. */
function markdownLinksIn(line: string): Array<{ title: string; url: string }> {
  return [...line.matchAll(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)].map((m) => ({
    title: m[1].trim(),
    url: m[2].trim(),
  }));
}

/**
 * Parses llms.txt per llmstxt.org: an H1 title, an optional blockquote summary,
 * free prose, then `##` sections of markdown links with optional `: notes`.
 */
export function parseLlmsTxt(text: string): {
  title: string | null;
  summary: string | null;
  sections: string[];
  links: Array<{ title: string; url: string }>;
  offFormatItems: OffFormatListItem[];
} {
  let title: string | null = null;
  let summary: string | null = null;
  const sections: string[] = [];
  const links: Array<{ title: string; url: string }> = [];
  const offFormatItems: OffFormatListItem[] = [];
  let inSection = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!title && line.startsWith('# ')) {
      title = line.slice(2).trim();
      continue;
    }
    if (title && !summary && line.startsWith('> ')) {
      summary = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      sections.push(line.slice(3).trim());
      inSection = true;
      continue;
    }
    if (inSection && /^[-*]\s/.test(line)) {
      const m = /^[-*]\s+\[([^\]]*)\]\(([^)]+)\)/.exec(line);
      if (m) links.push({ title: m[1].trim(), url: m[2].trim() });
      else offFormatItems.push({ text: line.slice(0, 120), links: markdownLinksIn(line) });
    }
  }
  return { title, summary, sections, links, offFormatItems };
}

async function checkLlmsTxt(ctx: AuditContext): Promise<LlmsOutcome> {
  const outcome = await ctx.get('/llms.txt');
  const nothing = { links: [], offFormatItems: [], parsed: false };
  if (outcome.kind !== 'ok') return { check: fromFailedGet(LLMS_TXT, outcome), ...nothing };
  const res = outcome.res;
  const ev = [evidenceOf(res)];
  const missingFix =
    'Publish /llms.txt: an H1 with the site name, a one-line summary in a blockquote, then "##" ' +
    'sections of markdown links to the pages worth reading, each with a short note. It is the ' +
    'index an agent reads instead of crawling, and it is where you decide what represents you.';

  if (res.status !== 200) {
    return { check: result(LLMS_TXT, 'fail', `${res.status} — no llms.txt`, ev, missingFix), ...nothing };
  }
  if (looksLikeHtml(res)) {
    return {
      check: result(
        LLMS_TXT,
        'fail',
        'llms.txt returns an HTML page, so the file does not really exist',
        ev,
        `${missingFix} The path currently answers 200 with the site's HTML, which a checker that ` +
          'only looks at status codes would report as a pass.',
      ),
      ...nothing,
    };
  }

  const parsed = parseLlmsTxt(res.body);
  const problems: string[] = [];
  if (!parsed.title) problems.push('no H1 title line');
  if (parsed.links.length === 0) problems.push('no links in any section');
  // A non-link list item is its own low-severity check (`llms-txt-list-items`),
  // not a failure of this one. A file with an H1 and working links does the job
  // llms.txt exists for; a stray bullet is a thing to tidy, and folding the two
  // together would rank "one unlinked bullet" alongside "the file is HTML".
  if (problems.length > 0) {
    return {
      check: result(
        LLMS_TXT,
        'fail',
        `200, but ${problems.join('; ')}`,
        ev,
        'The file exists but does not follow the llms.txt format, so a parser reading it gets less ' +
          'than the text suggests. It needs "# Title" on the first line, and every list item under ' +
          'a "##" heading in the form "- [Name](https://…): note".',
      ),
      links: parsed.links,
      offFormatItems: parsed.offFormatItems,
      parsed: true,
    };
  }

  return {
    check: result(
      LLMS_TXT,
      'pass',
      `200, "${parsed.title}", ${parsed.sections.length} section(s), ${parsed.links.length} link(s)`,
      ev,
    ),
    links: parsed.links,
    offFormatItems: parsed.offFormatItems,
    parsed: true,
  };
}

const LLMS_LINKS: CheckSpec = {
  id: 'llms-txt-links',
  title: 'The links in llms.txt resolve',
  category: 'discovery',
  severity: 'medium',
};

/** How many llms.txt links are actually fetched. Sampled, to stay a fast tier. */
const LLMS_LINK_SAMPLE = 3;

async function checkLlmsLinks(
  ctx: AuditContext,
  links: Array<{ title: string; url: string }>,
): Promise<CheckResult> {
  if (links.length === 0) {
    return result(LLMS_LINKS, 'not-applicable', 'no llms.txt links to follow');
  }
  const sample = links.slice(0, LLMS_LINK_SAMPLE);
  const evidence: CheckEvidence[] = [];
  const dead: string[] = [];
  let fetched = 0;
  let blockedByRobots = 0;

  for (const link of sample) {
    // An llms.txt link may point at another host, and `ctx.get` consults *that*
    // host's robots.txt for it rather than this site's.
    const outcome = await ctx.get(link.url);
    if (outcome.kind === 'robots') {
      blockedByRobots++;
      evidence.push({ url: outcome.url, note: outcome.detail });
      continue;
    }
    if (outcome.kind === 'error') {
      dead.push(`${link.url} (${outcome.message})`);
      evidence.push({ url: outcome.url, note: outcome.message });
      if (outcome.fatal) break;
      continue;
    }
    fetched++;
    evidence.push(evidenceOf(outcome.res));
    if (outcome.res.status !== 200) dead.push(`${link.url} (${outcome.res.status})`);
  }

  if (dead.length > 0) {
    return result(
      LLMS_LINKS,
      'fail',
      `${dead.length} of the first ${sample.length} llms.txt link(s) do not resolve: ${dead.join(', ')}`,
      evidence,
      'Every URL in llms.txt has to return 200. An agent that follows a dead link from your own ' +
        'index learns that the index is stale and falls back to crawling, which is what llms.txt ' +
        'was supposed to save it from. Generate the file from your published content at build time.',
    );
  }
  if (fetched === 0) {
    // Every sampled link was disallowed to this auditor by whichever host owns
    // it. Nothing was learned, so nothing is claimed: reporting a pass here
    // would say "the links resolve" about links that were never requested.
    return result(
      LLMS_LINKS,
      'not-applicable',
      `all ${blockedByRobots} sampled link(s) are disallowed to this auditor by robots.txt`,
      evidence,
    );
  }
  // "3 of 43 link(s) return 200" reads as forty broken links. Only three were
  // ever requested, and all three answered: the sentence has to say which number
  // is the sample and which is the file.
  return result(
    LLMS_LINKS,
    'pass',
    `all ${fetched} sampled link(s) return 200 (${links.length} link(s) in the file, ` +
      `${sample.length} sampled)` +
      (blockedByRobots > 0 ? `; ${blockedByRobots} of the sample was disallowed by robots.txt` : ''),
    evidence,
  );
}

const LLMS_LIST_ITEMS: CheckSpec = {
  id: 'llms-txt-list-items',
  title: 'Every llms.txt list item leads with a markdown link',
  category: 'discovery',
  severity: 'low',
};

/**
 * Separate from `llms-txt` on purpose. The format says a section's list items
 * lead with a link to somewhere with more detail, and this check is about the
 * ones that do not. It is not the same kind of problem as a file that is
 * missing, is HTML, or has no links at all — which is why it does not fail the
 * check those share.
 *
 * Two different problems live under "not in the form", and the first draft of
 * this check reported both as "invisible to a parser", which was wrong about the
 * second. A bullet with **no link at all** really is invisible: there is nothing
 * in the line to collect. A bullet that **contains links but does not lead with
 * one** — stripe.com's llms.txt has one, with two links inside a prose sentence
 * — is off-format rather than invisible, and how much of it survives depends
 * entirely on how strict the reader is. The check says which of the two it
 * found, and the fix copy only claims invisibility about the first.
 */
function checkLlmsListItems(llms: LlmsOutcome): CheckResult {
  if (!llms.parsed) return result(LLMS_LIST_ITEMS, 'not-applicable', 'no llms.txt to read');
  if (llms.offFormatItems.length === 0) {
    return result(LLMS_LIST_ITEMS, 'pass', `all ${llms.links.length} list item(s) lead with a markdown link`);
  }

  const proseOnly = llms.offFormatItems.filter((item) => item.links.length === 0);
  const linksNotLeading = llms.offFormatItems.filter((item) => item.links.length > 0);
  const observed = [
    proseOnly.length > 0 ? `${proseOnly.length} list item(s) contain no link at all` : null,
    linksNotLeading.length > 0
      ? `${linksNotLeading.length} list item(s) carry ${linksNotLeading.reduce(
          (n, item) => n + item.links.length,
          0,
        )} link(s) but do not lead with one`
      : null,
  ]
    .filter(Boolean)
    .join('; ');

  const fix = [
    'Put a link at the front of every bullet under a "##" heading, in the form ' +
      '"- [Name](https://…): note", which is the shape the format specifies.',
    proseOnly.length > 0
      ? 'A bullet with no link in it has nothing for a client to collect, so it is invisible to the ' +
        'reader the file was written for. If the thing has no URL of its own, either link to the ' +
        "page that describes it or move the line into the section's intro prose."
      : null,
    linksNotLeading.length > 0
      ? 'A bullet whose links sit inside a sentence is not invisible — a lenient reader will still ' +
        'find them — but which link is the item, and which is an aside, is left to the reader to ' +
        'guess, and a strict reader that takes the leading link as the item finds none.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return result(
    LLMS_LIST_ITEMS,
    'fail',
    observed,
    llms.offFormatItems.map((item) => ({
      note:
        item.links.length === 0
          ? `no link: ${item.text}`
          : `${item.links.length} link(s), none leading: ${item.text}`,
    })),
    fix,
  );
}

const AGENTS_MD: CheckSpec = {
  id: 'agents-md',
  title: 'agents.md exists and is markdown',
  category: 'discovery',
  severity: 'medium',
};

async function checkAgentsMd(ctx: AuditContext): Promise<CheckResult> {
  const outcome = await ctx.get('/agents.md');
  if (outcome.kind !== 'ok') return fromFailedGet(AGENTS_MD, outcome);
  const res = outcome.res;
  const ev = [evidenceOf(res)];
  const fix =
    'Publish /agents.md: a short brief addressed to an AI agent visiting the site — what this site ' +
    'is, which URLs matter, what machine-readable formats exist, and what you would like an agent ' +
    'to do or not do. llms.txt is an index; agents.md is the instructions that go with it.';

  if (res.status !== 200) return result(AGENTS_MD, 'fail', `${res.status} — no agents.md`, ev, fix);
  if (looksLikeHtml(res)) {
    return result(
      AGENTS_MD,
      'fail',
      'agents.md returns an HTML page, so the file does not really exist',
      ev,
      `${fix} The path currently answers 200 with HTML, which a presence-only checker reports as a pass.`,
    );
  }
  if (res.body.trim().length < 40) {
    return result(AGENTS_MD, 'fail', `200, but the body is ${res.body.trim().length} characters`, ev, fix);
  }
  return result(
    AGENTS_MD,
    'pass',
    `200 ${contentType(res) || 'no content-type'}, ${res.body.trim().split(/\s+/).length} words`,
    ev,
  );
}

const MCP_WELL_KNOWN: CheckSpec = {
  id: 'well-known-mcp-server',
  title: 'An MCP server is discoverable at /.well-known/mcp-server',
  category: 'discovery',
  severity: 'low',
};

async function checkWellKnownMcp(ctx: AuditContext): Promise<CheckResult> {
  const outcome = await ctx.get('/.well-known/mcp-server');
  if (outcome.kind !== 'ok') return fromFailedGet(MCP_WELL_KNOWN, outcome);
  const res = outcome.res;
  const ev = [evidenceOf(res)];
  const fix =
    'Optional, and an IETF draft rather than a finished standard. If the site has an MCP server, ' +
    'a JSON document at /.well-known/mcp-server naming its endpoint is how an agent finds it ' +
    'without being told the URL. If there is no MCP server, this is nothing to fix.';

  if (res.status !== 200) {
    return result(MCP_WELL_KNOWN, 'fail', `${res.status} — no MCP server discovery document`, ev, fix);
  }
  try {
    JSON.parse(res.body);
  } catch {
    return result(
      MCP_WELL_KNOWN,
      'fail',
      '200, but the body is not valid JSON',
      ev,
      'The discovery document has to be JSON naming the MCP endpoint. Anything else cannot be read by the agent looking for it.',
    );
  }
  return result(MCP_WELL_KNOWN, 'pass', '200 and valid JSON', ev);
}

const A2A_CARD: CheckSpec = {
  id: 'a2a-agent-card',
  title: 'An A2A agent card is published',
  category: 'discovery',
  severity: 'low',
};

async function checkAgentCard(ctx: AuditContext): Promise<CheckResult> {
  const paths = ['/.well-known/agent-card.json', '/.well-known/agent.json'];
  const evidence: CheckEvidence[] = [];
  let blockedByRobots = 0;
  for (const path of paths) {
    const outcome = await ctx.get(path);
    if (outcome.kind !== 'ok') {
      if (outcome.kind === 'error' && outcome.fatal) return fromFailedGet(A2A_CARD, outcome);
      if (outcome.kind === 'robots') blockedByRobots++;
      evidence.push(
        outcome.kind === 'robots'
          ? { url: outcome.url, note: outcome.detail }
          : { url: outcome.url, note: outcome.message },
      );
      continue;
    }
    evidence.push(evidenceOf(outcome.res));
    if (outcome.res.status !== 200 || looksLikeHtml(outcome.res)) continue;
    try {
      const card = JSON.parse(outcome.res.body) as {
        name?: unknown;
        url?: unknown;
        supportedInterfaces?: Array<{ url?: unknown }>;
      };
      // A2A moved the endpoint: pre-1.0 cards carry a top-level `url`, and 1.0
      // cards carry `supportedInterfaces`, an array of transport/URL pairs.
      // Accepting only the older shape reported this site's own valid card as
      // broken, which is how the second form got found.
      const endpoint =
        typeof card.url === 'string'
          ? card.url
          : card.supportedInterfaces?.find((i) => typeof i?.url === 'string')?.url;
      if (typeof card.name !== 'string' || typeof endpoint !== 'string') {
        return result(
          A2A_CARD,
          'fail',
          `${path} is JSON but does not name the agent and an endpoint`,
          evidence,
          'An A2A agent card must carry a "name" and the URL the agent is reachable at — either a ' +
            'top-level "url", or a "supportedInterfaces" entry with one. Without both, a client that ' +
            'finds the card cannot call the agent.',
        );
      }
      return result(A2A_CARD, 'pass', `${path} names "${card.name}" at ${endpoint}`, evidence);
    } catch {
      return result(
        A2A_CARD,
        'fail',
        `${path} returned 200 but is not valid JSON`,
        evidence,
        'The agent card has to be a JSON document. Anything else is not readable by an A2A client.',
      );
    }
  }
  if (blockedByRobots === paths.length) {
    return result(A2A_CARD, 'not-applicable', 'both well-known paths are disallowed to this auditor', evidence);
  }
  return result(
    A2A_CARD,
    'fail',
    'no agent card at either well-known path',
    evidence,
    'Optional, and only relevant if this site fronts an agent other agents should call. An A2A ' +
      'agent card at /.well-known/agent-card.json declares that agent, its skills, and its endpoint.',
  );
}

const NEGOTIATION_HOME: CheckSpec = {
  id: 'markdown-negotiation-home',
  title: 'The homepage serves markdown when asked for it',
  category: 'content-access',
  severity: 'high',
};

const NEGOTIATION_CONTENT: CheckSpec = {
  id: 'markdown-negotiation-content',
  title: 'A content page serves markdown when asked for it',
  category: 'content-access',
  severity: 'high',
};

/** Strips tags and decodes the handful of entities that show up in a title. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' })[e] ?? ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** The page's own claim about what it is: `<title>`, falling back to the first `<h1>`. */
export function pageIdentity(html: string): string | null {
  const title = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html);
  const fromTitle = title ? textOf(title[1]) : '';
  if (fromTitle) return fromTitle;
  const h1 = /<h1[^>]*>([\s\S]{0,400}?)<\/h1>/i.exec(html);
  const fromH1 = h1 ? textOf(h1[1]) : '';
  return fromH1 || null;
}

/**
 * Does the markdown response look like markdown, and like *the same page*?
 *
 * The second half is the behaviour verification the presence-only checkers skip.
 * A site can answer `Accept: text/markdown` with a 200 and a content-type that
 * says markdown while returning the homepage, a stub, or an error page. The
 * comparison is deliberately weak — the longest identifying phrase from the HTML
 * has to appear in the markdown — because a strong one (matching bodies) would
 * fail every site that legitimately renders markdown and HTML from different
 * templates.
 */
function sameContent(htmlIdentity: string | null, markdown: string): boolean | null {
  if (!htmlIdentity) return null;
  // Titles are routinely suffixed with a site name in HTML but not in markdown,
  // so compare against the longest segment rather than the whole string.
  const segment = htmlIdentity
    .split(/\s+[|·—–-]\s+/)
    .sort((a, b) => b.length - a.length)[0]
    ?.trim();
  if (!segment || segment.length < 8) return null;
  return markdown.toLowerCase().includes(segment.toLowerCase());
}

interface NegotiationOutcome {
  check: CheckResult;
  /** The HTML response, kept so the Link-header check needs no second fetch. */
  html: SafeResponse | null;
}

/**
 * The headers the negotiation checks quote.
 *
 * `vary` is the one the check reasons about; the caching headers after it are
 * recorded because the `Vary: Accept` finding is conditional on them. Whether a
 * missing `Vary` actually poisons anything depends on whether a shared cache
 * stores the response, and this audit cannot see the caches between it and the
 * origin. What it can do is write down what the response said about being
 * cached, so the reader can settle the question the finding leaves open.
 * `age` and the vendor `*-cache*` headers are the ones that prove a cache *did*
 * store it, rather than merely that it was allowed to.
 */
const NEGOTIATION_HEADERS = [
  'content-type',
  'vary',
  'cache-control',
  'cdn-cache-control',
  'surrogate-control',
  'age',
  'cache-status',
  'x-cache',
  'cf-cache-status',
  'x-vercel-cache',
  'x-nextjs-cache',
];

async function checkNegotiation(
  spec: CheckSpec,
  ctx: AuditContext,
  pageUrl: string,
): Promise<NegotiationOutcome> {
  const htmlOutcome = await ctx.get(pageUrl, { accept: 'text/html' });
  if (htmlOutcome.kind !== 'ok') return { check: fromFailedGet(spec, htmlOutcome), html: null };
  const html = htmlOutcome.res;
  const htmlEv = evidenceOf(html, NEGOTIATION_HEADERS, 'the plain request, Accept: text/html');
  const fix =
    'Serve the same page as markdown when the request says "Accept: text/markdown", and set ' +
    '"Vary: Accept" on both responses. An agent reading HTML spends most of its context on ' +
    'navigation and markup; markdown is the same content without the furniture. The usual ' +
    'implementation is an edge rule that rewrites the request to a .md sibling generated at build time.';

  if (html.status !== 200) {
    return {
      check: result(spec, 'error', `the page itself returned ${html.status}`, [htmlEv]),
      html,
    };
  }

  const mdOutcome = await ctx.get(pageUrl, { accept: 'text/markdown' });
  if (mdOutcome.kind !== 'ok') return { check: fromFailedGet(spec, mdOutcome), html };
  const md = mdOutcome.res;
  const mdEv = evidenceOf(md, NEGOTIATION_HEADERS, 'the markdown request, Accept: text/markdown');
  const evidence = [htmlEv, mdEv];

  if (md.status !== 200) {
    return {
      check: result(spec, 'fail', `Accept: text/markdown returned ${md.status}`, evidence, fix),
      html,
    };
  }
  if (looksLikeHtml(md)) {
    return {
      check: result(
        spec,
        'fail',
        'Accept: text/markdown is ignored — the response is the same HTML',
        evidence,
        fix,
      ),
      html,
    };
  }

  const vary = (html.headers['vary'] ?? '').toLowerCase();
  const varyOk = /\baccept\b/.test(vary);
  const identity = pageIdentity(html.body);
  const matches = sameContent(identity, md.body);

  if (matches === false) {
    return {
      check: result(
        spec,
        'fail',
        `markdown was served, but it does not contain the page's own title ("${identity}") — it may be a different page`,
        evidence,
        'The markdown variant has to be the same content as the HTML page. Serving the homepage, a ' +
          'stub, or a stale copy under Accept: text/markdown is worse than not negotiating at all: ' +
          'an agent has no way to tell it got the wrong page.',
      ),
      html,
    };
  }
  if (!varyOk) {
    return {
      check: result(
        spec,
        'fail',
        `markdown was served, but the HTML response's Vary header is "${vary || '(absent)'}", so a ` +
          'shared cache that stores this response has no way to know the two variants exist',
        evidence,
        'Add "Vary: Accept" to both responses. Whether this is biting right now depends on whether ' +
          'a shared cache (a CDN, a proxy) actually stores the response, which this audit cannot ' +
          "see from outside — the response's own cache-control, age and CDN cache-status headers " +
          'are in the evidence above, and they are what settles it. Where one does store it, the ' +
          'cache keeps whichever variant it saw first and serves it to everyone: a browser can get ' +
          'markdown and an agent can get HTML, intermittently, which is the hardest kind of bug to ' +
          'be told about. Setting the header costs nothing and closes the case either way.',
      ),
      html,
    };
  }

  return {
    check: result(
      spec,
      'pass',
      `Accept: text/markdown returns ${contentType(md) || 'markdown'}${
        matches === null ? '' : ', containing the page title'
      }, and the HTML response sets Vary: ${html.headers['vary']}`,
      evidence,
    ),
    html,
  };
}

const LINK_HEADERS: CheckSpec = {
  id: 'link-headers',
  title: 'The homepage advertises its alternates in a Link header',
  category: 'content-access',
  severity: 'low',
};

function checkLinkHeaders(homepage: SafeResponse | null): CheckResult {
  if (!homepage) return result(LINK_HEADERS, 'not-applicable', 'the homepage could not be fetched');
  const link = homepage.headers['link'];
  const fix =
    'Optional. An RFC 8288 "Link:" header with rel="alternate" and type="text/markdown" tells an ' +
    'agent the markdown variant exists without it having to guess and send a second request. ' +
    'Content negotiation works without it; this saves a round trip and makes the variant discoverable.';
  if (!link) {
    return result(LINK_HEADERS, 'fail', 'no Link header on the homepage', [
      { url: homepage.url, status: homepage.status, headers: {} },
    ], fix);
  }
  const ev = [{ url: homepage.url, status: homepage.status, headers: evidenceHeaders({ link }) }];
  if (!/rel\s*=\s*"?alternate"?/i.test(link)) {
    return result(
      LINK_HEADERS,
      'fail',
      `a Link header is present but declares no rel="alternate": ${excerpt(link, 120)}`,
      ev,
      fix,
    );
  }
  return result(LINK_HEADERS, 'pass', `Link header declares an alternate: ${excerpt(link, 120)}`, ev);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The pages the deep tier may render: the homepage, then the site's own content
 * pages in the order its sitemap lists them.
 *
 * Homepage first because it is the one page every site has and the one an agent
 * arrives at; the rest come from the sitemap for the same reason the negotiation
 * check does — an arbitrary site has no path this tool may assume exists. Only
 * this origin, only distinct URLs, and no query strings, which are usually the
 * same page in a different order. The cap is `deep.ts`'s to apply and to report:
 * this returns everything eligible so the count can be said out loud.
 */
export function samplePages(origin: string, sitemapUrls: string[]): string[] {
  const pages = [`${origin}/`];
  const seen = new Set(pages);
  for (const raw of sitemapUrls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.origin !== origin || url.search) continue;
    if (url.pathname.replace(/\/+$/, '') === '') continue;
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    pages.push(href);
  }
  return pages;
}

/**
 * Normalises what a human typed into the origin everything is fetched relative
 * to. A bare hostname gets https, and any path is dropped: the unit audited is
 * a site, not a page.
 */
export function normaliseTarget(input: string): { origin: string; url: URL } {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(withScheme);
  return { origin: url.origin, url };
}

export interface RunAuditOptions {
  /** Overridden by tests to point at a mock origin and relax the address guard. */
  policy?: Partial<FetchPolicy>;
  /** Injected so a test can produce a byte-stable result document. */
  now?: () => Date;
  /**
   * The deep tier: Chrome, Lighthouse and axe over a sample of the site's pages.
   * `false` is `--fast`. Omitted means on, with its own defaults.
   */
  deep?: false | DeepOptions;
  /**
   * How the deep tier is loaded. Required whenever `deep` is not `false`, and
   * that is deliberate: this file has **no value reference to `deep.js` at all**,
   * only the type-only import above, so nothing that reads this module's import
   * graph can reach Chrome, Lighthouse or axe.
   *
   * It used to be a plain `await import('./deep.js')` right where the deep tier
   * runs, which is correct for Node — the specifier is only resolved when the
   * branch is taken — and wrong for a bundler, which follows a dynamic import
   * statically and pulls the whole browser stack into the chunk. That is what
   * made the fast tier unshippable to a serverless function: see
   * `tests/steward-fast-audit-packaging.test.mjs` in the site repo, which walks
   * this graph and fails if any of those three names appears in it.
   *
   * Every caller that wants the deep tier passes `() => import('./deep.js')` and
   * pays for it in its own import graph, where the cost is visible.
   */
  loadDeep?: () => Promise<{ runDeepChecks: typeof import('./deep.js').runDeepChecks }>;
}

/**
 * Runs the fast tier only — no browser, no Chrome, seconds rather than minutes.
 *
 * Kept as its own export because "this verb makes no browser launch" is a
 * property callers rely on, and a boolean buried in an options object is a
 * weaker way to say it.
 */
export function runFastAudit(
  input: string,
  opts: Omit<RunAuditOptions, 'deep' | 'loadDeep'> = {},
): Promise<AuditResult> {
  return runAudit(input, { ...opts, deep: false });
}

/**
 * Runs both tiers against one site and returns the canonical result.
 *
 * Throws only for a target that cannot be audited at all — an unparseable URL,
 * or an address the guard refuses. Everything a site does or fails to do comes
 * back as a check, and so does everything the auditor could not do about it.
 */
export async function runAudit(input: string, opts: RunAuditOptions = {}): Promise<AuditResult> {
  const now = opts.now ?? (() => new Date());
  const { origin } = normaliseTarget(input);
  const started = now();
  const fetcher = new SafeFetcher(opts.policy, started.getTime());
  const ctx = new AuditContext(origin, fetcher);

  const checks: CheckResult[] = [];
  checks.push(await checkRobots(ctx));
  checks.push(checkAiAgents(ctx));
  // Content Signals is decided last and reported here, because the signal may
  // arrive as a response header and the homepage is not fetched until the
  // negotiation check below. The slot is reserved at the position the check
  // belongs in for a reader: with the other things robots.txt says.
  const contentSignalsSlot = checks.length;

  const sitemap = await checkSitemap(ctx);
  checks.push(sitemap.check);

  const llms = await checkLlmsTxt(ctx);
  checks.push(llms.check);
  checks.push(await checkLlmsLinks(ctx, llms.links));
  checks.push(checkLlmsListItems(llms));
  checks.push(await checkAgentsMd(ctx));
  checks.push(await checkWellKnownMcp(ctx));
  checks.push(await checkAgentCard(ctx));

  const home = await checkNegotiation(NEGOTIATION_HOME, ctx, `${origin}/`);
  checks.push(home.check);

  // The content page comes from the sitemap rather than from a guess: an
  // arbitrary site has no path this tool can assume exists, and the sitemap is
  // the site's own statement about which pages do.
  const contentUrl = sitemap.urls.find((u) => {
    try {
      const parsed = new URL(u);
      return parsed.origin === origin && parsed.pathname.replace(/\/+$/, '') !== '';
    } catch {
      return false;
    }
  });
  checks.push(
    contentUrl
      ? (await checkNegotiation(NEGOTIATION_CONTENT, ctx, contentUrl)).check
      : result(
          NEGOTIATION_CONTENT,
          'not-applicable',
          'no content page to test — the sitemap named none, and this audit does not guess URLs',
        ),
  );

  // Both read the homepage response the negotiation check already fetched,
  // rather than spending another request on the same URL.
  checks.push(checkLinkHeaders(home.html));
  checks.splice(contentSignalsSlot, 0, checkContentSignals(ctx, home.html));

  let browserPages: number | undefined;
  if (opts.deep === false) {
    ctx.notes.push(
      'Run with --fast: the rendered-experience checks (Lighthouse, axe) were skipped, so that ' +
        'category is empty rather than clean.',
    );
  } else {
    if (!opts.loadDeep) {
      throw new Error(
        'the deep tier was requested without a loadDeep option; pass ' +
          "loadDeep: () => import('./deep.js'), or call runFastAudit",
      );
    }
    const { runDeepChecks } = await opts.loadDeep();
    const deep = await runDeepChecks(
      {
        candidates: samplePages(origin, sitemap.urls),
        remainingMs: () => fetcher.remainingMs(),
        policy: fetcher.policy,
        robotsDetail: (url) => ctx.robotsDetail(url),
      },
      opts.deep ?? {},
    );
    checks.push(...deep.checks);
    ctx.notes.push(...deep.notes);
    browserPages = deep.renderedPages;
  }

  const finished = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION, userAgent: AUDIT_USER_AGENT },
    target: { input, origin },
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    requests: fetcher.requests,
    ...(browserPages === undefined ? {} : { browserPages }),
    categories: countByCategory(checks),
    checks,
    notes: ctx.notes,
  };
}
