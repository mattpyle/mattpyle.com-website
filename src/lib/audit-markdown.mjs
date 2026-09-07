/**
 * What /audit.md says, in each of the shapes it has.
 *
 * The route (src/pages/audit.md.ts) is the transport: it parses the address, reads the pointer,
 * reads the run back off the namespace and hands Steward's own renderer over. This file is the
 * part worth testing, and it is testable because none of it touches a network, a store or a clock
 * it was not given — the same split src/lib/audit-report.mjs takes for the HTML page.
 *
 * It also has to be a separate file rather than functions inside the route, for the reason
 * src/lib/audit-report.mjs states about itself: the route imports Steward's `agent-audit/fast`
 * entry, which is TypeScript source that only the Vite build transpiles, so anything in it is out
 * of reach of the bare `node --test` suite.
 *
 * NOTHING HERE WRITES A SENTENCE ABOUT A RUN. The report shape is `renderMarkdownSummary`, passed
 * in — the canonical markdown rendering of an audit, the same one the CLI and `/mcp` hand back.
 * The page's own words are src/data/audit-copy.mjs and the check catalogue is
 * src/data/steward-audit-checks.mjs, which are the two modules the HTML renders from, so the two
 * representations of this URL cannot come to say different things about the same page.
 */

import {
  FORM,
  MARKDOWN_NO_REPORT,
  PAGE_DESCRIPTION,
  PAGE_SEO_TITLE,
  PAGE_STATEMENT,
  PAGE_TITLE,
  SECTIONS,
} from '../data/audit-copy.mjs';
import { STEWARD_FAST_CHECKS } from '../data/steward-audit-checks.mjs';
import { SITE_ORIGIN } from '../data/site-origin.mjs';
import { GROUPS, secondsLeftInHour } from './audit-report.mjs';

/** The canonical URL both representations of this page point back at. */
export const CANONICAL = `${SITE_ORIGIN}/audit/`;

/**
 * How long the edge may hold a shape that carries no report.
 *
 * An hour, matching the HTML route's empty branch: the page's words and the check catalogue are
 * both compiled-in data, so two requests inside an hour cannot differ, and a deployment is the
 * only thing that changes either.
 */
export const EMPTY_MAX_AGE = 3600;

/** A pipe inside a cell would end it early. The same guard /activity's twin uses, same order. */
function cell(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

/**
 * The page with no report: what it is, what one costs, and every check it makes.
 *
 * The form has no markdown equivalent and none is invented. What replaces it is the one line here
 * the HTML has no counterpart for — where to ask for a report, and where to run a new one — because
 * a browser has the field instead and a reader of this file has only the URL.
 */
export function emptyPageMarkdown() {
  const groups = GROUPS.map((group) => {
    const checks = STEWARD_FAST_CHECKS.filter((check) => check.category === group.id);
    return [
      `### ${group.label}`,
      group.summary,
      table(
        ['Check', 'What it asks', 'Weight'],
        checks.map((check) => [check.title, check.plain, check.severity]),
      ),
    ].join('\n\n');
  });

  return [
    `# ${PAGE_TITLE}`,
    PAGE_STATEMENT,
    `**${FORM.label}.** ${FORM.note} ${FORM.noteLink}: ${SITE_ORIGIN}/steward/`,
    `A report for an address that has already been audited is at ${SITE_ORIGIN}/audit.md?url=<address>. ` +
      `Running a new audit is a form post, so it happens at ${CANONICAL} in a browser, or through ` +
      'the MCP and A2A surfaces this site publishes.',
    `## ${SECTIONS.checks}`,
    ...groups,
  ].join('\n\n');
}

/**
 * The body and its cache lifetime, for whatever this request turned out to be.
 *
 * **Four of the five shapes are the same document.** No address, an address that cannot be
 * audited, an address with nothing stored for it, and an address whose stored run reached no
 * verdict about the site all answer with the empty page — the last three with one line naming the
 * address, because a markdown reader has no field to read it back out of. That collapsing is the
 * HTML route's posture carried across: "there is no report to show" is the one thing this page can
 * say about a missing pointer, a dead store or an aged-out namespace without inventing a fact
 * about retention (Matt, 2026-09-05, decision 9).
 *
 * @param {{
 *   asked: string | null,
 *   origin?: string,
 *   audit?: any,
 *   failed?: boolean,
 *   renderSummary?: (audit: any) => string,
 *   now?: Date,
 * }} input
 *   `origin` is the parsed address, absent when it could not be parsed; `audit` is the run, absent
 *   for every kind of nothing; `failed` says the run reached no verdict about the site.
 * @returns {{ markdown: string, maxAge: number }}
 */
export function auditMarkdownBody({ asked, origin, audit, failed = false, renderSummary, now = new Date() }) {
  if (!asked) return { markdown: emptyPageMarkdown(), maxAge: EMPTY_MAX_AGE };

  if (!audit || failed) {
    return {
      markdown: `${emptyPageMarkdown()}\n\n${MARKDOWN_NO_REPORT(origin || asked)}`,
      maxAge: EMPTY_MAX_AGE,
    };
  }

  // The report is immutable for the rest of its hour — the hour is the deduplication bucket the
  // activity ID uses — which is exactly how long the edge may hold it. Same arithmetic as the HTML.
  return { markdown: renderSummary(audit), maxAge: secondsLeftInHour(now) };
}

/** The frontmatter, describing this page exactly as the HTML's `<title>` and meta description do. */
export function auditMarkdownFrontmatter(renderedAt) {
  return [
    '---',
    `title: "${PAGE_SEO_TITLE}"`,
    `description: "${PAGE_DESCRIPTION}"`,
    `canonical: ${CANONICAL}`,
    `source: ${CANONICAL}`,
    `rendered: ${renderedAt.toISOString()}`,
    '---',
  ].join('\n');
}

/** The whole response body: frontmatter, then whichever shape this request is. */
export function auditMarkdownDocument(input) {
  const { markdown, maxAge } = auditMarkdownBody(input);
  return { body: `${auditMarkdownFrontmatter(input.now ?? new Date())}\n\n${markdown}\n`, maxAge };
}
