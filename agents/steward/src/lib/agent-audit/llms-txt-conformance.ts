/**
 * Does a document conform to llmstxt.org, as revised in v2 (modified 2026-08-10)?
 *
 * Distinct from the `llms-txt` check in `checks.ts`, and deliberately stricter. That check grades
 * somebody else's site over HTTP and is written to be fair to a site that made a reasonable
 * attempt: a file with an H1 and working links passes it, and a stray off-format bullet is a
 * separate low-severity finding rather than a failure. This function grades a file its author
 * controls completely and has no reason to get wrong — mattpyle.com's, which is generated from
 * content by `src/pages/llms.txt.ts` and could regress format without breaking the site's build.
 * Every deviation from the spec's Format section is a violation here.
 *
 * Both read the same file with the same parser. `parseLlmsTxt` is imported rather than
 * reimplemented so the two can never disagree about what a section or a list item is.
 *
 * **What v2 changed, and what it did not.** A BOM is now explicitly optional rather than an error,
 * which is why `stripBom` runs before the parse instead of a leading `﻿` being reported: this
 * function must not fail a file for carrying one. The file may also live at any path, with
 * most-specific-wins, and discovery is now recommended through the `alternate`/`describedby` link
 * relations — neither of which is a property of the document, so neither is checked here (the
 * site's `<link>` elements are covered by its own test suite). The Format section itself is
 * unchanged from v1: an H1 title, which is the only required element; an optional blockquote
 * summary; optional prose in non-heading sections; then `##` sections whose list items lead with
 * `[name](url)` and may carry `: notes` after it.
 *
 * The H1 is the spec's only hard requirement, so it is the only `required: true` rule. The rest
 * are the recommendations the file is expected to keep, and the caller decides what to do with a
 * violation; `scripts/validate-llms-txt.mjs` in the site repo treats all of them as failures,
 * because the site's file has satisfied all of them since it was written and any change is a
 * regression rather than a judgement call.
 */

import { parseLlmsTxt } from './checks.js';

/** One way a document departs from the spec. */
export interface LlmsTxtViolation {
  /** Stable id, so a caller can suppress or report one specific rule. */
  rule: string;
  /** What is wrong, in one sentence, naming what was found. */
  detail: string;
  /** True for the H1, which the spec requires. Everything else it recommends. */
  required: boolean;
}

export interface LlmsTxtConformance {
  ok: boolean;
  violations: LlmsTxtViolation[];
  /** The parse the rules were applied to, so a caller can report what it did see. */
  parsed: ReturnType<typeof parseLlmsTxt>;
}

/**
 * Drop a leading byte order mark.
 *
 * v2 says a BOM is optional, so a file that has one is conforming and must parse identically to
 * one that does not. Left in place, `﻿# Title` does not start with `# ` and the whole
 * document reads as having no H1 — the single worst failure this function can report, from the one
 * thing the spec revision went out of its way to permit.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function checkLlmsTxtConformance(text: string): LlmsTxtConformance {
  const body = stripBom(text);
  const parsed = parseLlmsTxt(body);
  const violations: LlmsTxtViolation[] = [];

  const add = (rule: string, detail: string, required = false) =>
    violations.push({ rule, detail, required });

  if (!parsed.title) {
    add('h1', 'no H1 title line — the spec requires one, in the form "# Site name"', true);
  }

  // The H1 has to be the *first* content, not merely present: a parser that reads the title off
  // line one — which the format invites — gets the wrong answer from a file that opens with prose
  // and puts its heading further down, even though `parseLlmsTxt` finds it either way.
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  if (parsed.title && firstLine !== `# ${parsed.title}`) {
    add('h1-first', `the first non-empty line is "${firstLine?.slice(0, 60)}", not the H1`);
  }

  if (!parsed.summary) {
    add('summary', 'no blockquote summary under the H1 (a "> …" line)');
  }

  if (parsed.sections.length === 0) {
    add('sections', 'no "##" file-list sections');
  }

  if (parsed.links.length === 0) {
    add('links', 'no list items lead with a markdown link, so there is nothing to collect');
  }

  for (const item of parsed.offFormatItems) {
    add(
      'list-item-format',
      `list item does not lead with a markdown link: "${item.text.slice(0, 80)}"`,
    );
  }

  return { ok: violations.length === 0, violations, parsed };
}
