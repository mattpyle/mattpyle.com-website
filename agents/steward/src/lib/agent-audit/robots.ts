/**
 * A robots.txt parser, used for two different jobs that happen to need the same
 * parse:
 *
 * 1. **Obedience.** The auditor honours the target's robots.txt for every URL
 *    it fetches after robots.txt itself. An agent-readiness auditor that
 *    ignores robots fails its own audit (hosted-mcp-server card, stage 0).
 * 2. **Reporting.** Whether the file parses at all, whether it declares a
 *    sitemap, and what it says to the named AI agents are three of the checks.
 *
 * Deliberately small. It implements the parts of the de-facto standard
 * (RFC 9309) that decide those two questions — grouped `User-agent` records,
 * `Allow`/`Disallow` with longest-match-wins, `Sitemap`, and Cloudflare's
 * `Content-Signal` extension — and nothing else. `Crawl-delay` is parsed into
 * the group but not obeyed: this audit makes about a dozen requests total, and
 * sleeping a declared 30 seconds between them would turn a fast tier into a
 * slow one.
 */

export interface RobotsGroup {
  /** Lowercased user-agent tokens this group applies to. */
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelay?: number;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** Raw values of any `Content-Signal:` lines (Cloudflare's extension). */
  contentSignals: string[];
  /** Lines that were neither blank, a comment, nor a `field: value` pair. */
  malformedLines: Array<{ line: number; text: string }>;
  /** Directives we recognise the shape of but do not act on, e.g. `Host`. */
  unknownFields: string[];
}

/** Parses robots.txt text. Never throws: an unparseable line is a finding. */
export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const contentSignals: string[] = [];
  const malformedLines: Array<{ line: number; text: string }> = [];
  const unknownFields = new Set<string>();

  let current: RobotsGroup | null = null;
  // A run of consecutive `User-agent` lines forms ONE group. Any other
  // directive ends the run, so the next `User-agent` starts a new group.
  let acceptingAgents = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const withoutComment = lines[i].replace(/#.*$/, '').trim();
    if (!withoutComment) continue;
    const colon = withoutComment.indexOf(':');
    if (colon === -1) {
      malformedLines.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
      continue;
    }
    const field = withoutComment.slice(0, colon).trim().toLowerCase();
    const value = withoutComment.slice(colon + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!current || !acceptingAgents) {
          current = { agents: [], rules: [] };
          groups.push(current);
          acceptingAgents = true;
        }
        current.agents.push(value.toLowerCase());
        break;
      }
      case 'allow':
      case 'disallow': {
        acceptingAgents = false;
        if (!current) {
          // Rules before any `User-agent` line apply to nobody. Recorded as
          // malformed because that is almost always a mistake by the author,
          // and silently dropping it would hide a site that thinks it is
          // blocking something.
          malformedLines.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
          break;
        }
        current.rules.push({ allow: field === 'allow', path: value });
        break;
      }
      case 'crawl-delay': {
        acceptingAgents = false;
        const n = Number(value);
        if (current && Number.isFinite(n)) current.crawlDelay = n;
        break;
      }
      case 'sitemap': {
        acceptingAgents = false;
        sitemaps.push(value);
        break;
      }
      case 'content-signal': {
        acceptingAgents = false;
        contentSignals.push(value);
        break;
      }
      default:
        acceptingAgents = false;
        unknownFields.add(field);
    }
  }

  return { groups, sitemaps, contentSignals, malformedLines, unknownFields: [...unknownFields] };
}

/**
 * The group that governs `agent`, by RFC 9309's rule: the most specific
 * matching record, falling back to `*`, and no merging between the two.
 *
 * "Most specific" is longest matching token, and matching is case-insensitive
 * substring — `Googlebot-News` is governed by a `Googlebot` record when no
 * `Googlebot-News` record exists.
 */
export function groupFor(robots: ParsedRobots, agent: string): RobotsGroup | null {
  const needle = agent.toLowerCase();
  let best: { group: RobotsGroup; length: number } | null = null;
  let wildcard: RobotsGroup | null = null;
  for (const group of robots.groups) {
    for (const token of group.agents) {
      if (token === '*') {
        wildcard ??= group;
        continue;
      }
      if (needle.includes(token) && (!best || token.length > best.length)) {
        best = { group, length: token.length };
      }
    }
  }
  return best?.group ?? wildcard;
}

/** Does a robots path pattern (with `*` and `$`) match this URL path? */
function patternMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false; // An empty Disallow means "allow everything".
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

export interface RobotsVerdict {
  allowed: boolean;
  /** The rule that decided it, for the evidence trail. Absent when nothing matched. */
  rule?: { allow: boolean; path: string; agents: string[] };
}

/**
 * May `agent` fetch `path`? Longest matching pattern wins; a tie goes to
 * `Allow`, and no matching rule means allowed.
 */
export function isAllowed(robots: ParsedRobots, agent: string, path: string): RobotsVerdict {
  const group = groupFor(robots, agent);
  if (!group) return { allowed: true };
  let winner: { allow: boolean; path: string } | null = null;
  for (const rule of group.rules) {
    if (!patternMatches(rule.path, path)) continue;
    if (
      !winner ||
      rule.path.length > winner.path.length ||
      (rule.path.length === winner.path.length && rule.allow && !winner.allow)
    ) {
      winner = rule;
    }
  }
  if (!winner) return { allowed: true };
  return { allowed: winner.allow, rule: { ...winner, agents: group.agents } };
}

/**
 * The AI agents the `robots-ai-agents` check reports on.
 *
 * Two kinds, and the check treats them differently: crawlers that build
 * training corpora or search indexes, and the user-triggered fetchers an agent
 * uses to read a page a human just asked about. Blocking the second kind is
 * what makes a site invisible to the agent standing in front of a user, which
 * is the thing this audit is about.
 */
export const AI_AGENTS: Array<{ token: string; kind: 'crawler' | 'user-triggered'; operator: string }> = [
  { token: 'GPTBot', kind: 'crawler', operator: 'OpenAI' },
  { token: 'OAI-SearchBot', kind: 'crawler', operator: 'OpenAI' },
  { token: 'ChatGPT-User', kind: 'user-triggered', operator: 'OpenAI' },
  { token: 'ClaudeBot', kind: 'crawler', operator: 'Anthropic' },
  { token: 'Claude-User', kind: 'user-triggered', operator: 'Anthropic' },
  { token: 'Claude-SearchBot', kind: 'crawler', operator: 'Anthropic' },
  { token: 'PerplexityBot', kind: 'crawler', operator: 'Perplexity' },
  { token: 'Perplexity-User', kind: 'user-triggered', operator: 'Perplexity' },
  { token: 'Google-Extended', kind: 'crawler', operator: 'Google' },
  { token: 'Applebot-Extended', kind: 'crawler', operator: 'Apple' },
  { token: 'meta-externalagent', kind: 'crawler', operator: 'Meta' },
  { token: 'Bytespider', kind: 'crawler', operator: 'ByteDance' },
];
