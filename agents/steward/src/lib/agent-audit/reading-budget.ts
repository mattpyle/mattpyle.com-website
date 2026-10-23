/**
 * The reading budget: how much of an agent's first read of a page is content.
 *
 * Peec AI's Deep Research study (docs.peec.ai/research/deep-research-reading-budget,
 * 2026-06) read an agent's session logs and found that a page open returns a capped
 * window of text, about 5,700 characters at the median and about 8,000 at most, and
 * that links eat it: real content was about 78% of the window on pages with under 20
 * links and about 33% on pages with 60 or more. A page is read in source order, so a
 * header full of links is read before the first sentence of the body, whatever the
 * screen shows.
 *
 * This module measures that one number for a page, twice: once over the HTML
 * rendered to text the way a markdown converter would read it, and once over the
 * page's markdown twin, the thing a client that sent `Accept: text/markdown` gets.
 * The two together say whether negotiating markdown buys an agent anything here.
 *
 * ## The rule, exactly
 *
 * The window is the first `READING_BUDGET_CHARS` characters of what the agent reads.
 * A page shorter than that is measured over its whole length, and the figure says so.
 * The share is the characters in the window that belong to the main content, as a
 * whole-number percentage of the characters measured.
 *
 * As text, the HTML is rendered like this:
 *
 * 1. `head`, `script`, `style`, `template`, `noscript`, `svg`, `iframe` and `title`
 *    elements are dropped with their contents, and so are comments.
 * 2. A link becomes `[text](href)` and an image `![alt](src)`, because that is what
 *    the converters agents fetch through produce and what the study says costs the
 *    characters. Every other tag is removed; block-level tags become a line break.
 * 3. Entities are decoded, runs of spaces collapse to one, blank lines are dropped.
 *
 * The main content is the first `main` element, or the first `article` when there
 * is no `main`. A page with neither has no content by this rule and scores 0: the
 * measurement cannot see where the body starts, and nor can an agent.
 *
 * As markdown, the window is the first 8,000 characters of the response as served,
 * with CRLF read as LF. The main content is everything after the YAML front matter
 * that is not a navigation list: a block whose every line is a list item holding one
 * markdown link and nothing else. A list whose items carry prose is content.
 *
 * ## No threshold
 *
 * The study gives bands, not a target, so nothing here passes or fails. The check
 * built on this reports the figure; what to do about it is the reader's decision.
 *
 * Pure: no I/O, no clock, and no dependency, so the serverless fast tier and the
 * nightly scorecard measure with the same code.
 */

/** The window the study observed: the most an agent saw of a page on first read. */
export const READING_BUDGET_CHARS = 8000;

export interface BudgetFigure {
  /** Content characters as a whole-number percentage of the characters measured. */
  share: number;
  /** Characters inside the measured window that belong to the main content. */
  content: number;
  /** Characters measured: the window, or the whole text when it is shorter. */
  measured: number;
  /** The whole length of what the agent would read. */
  total: number;
}

export interface TextBudget extends BudgetFigure {
  /** Which element was taken as the main content; `null` when the page has neither. */
  region: 'main' | 'article' | null;
  /** Where the main content starts in the rendered text; `null` without a region. */
  contentStart: number | null;
}

export interface MarkdownBudget extends BudgetFigure {
  /** Characters of YAML front matter at the top, counted against the window. */
  frontMatter: number;
  /** How many blocks were set aside as navigation lists. */
  navigationLists: number;
}

/**
 * The compact figure that travels: through a workflow history, into a run record
 * and onto a page. `markdown` is `null` when the page has no markdown twin to
 * measure, which the negotiation checks report on their own.
 */
export interface ReadingBudget {
  text: { share: number; measured: number };
  markdown: { share: number; measured: number } | null;
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

const DROPPED_ELEMENTS = ['head', 'script', 'style', 'template', 'noscript', 'svg', 'iframe', 'title'];

const BLOCK_TAGS =
  'address|article|aside|blockquote|body|br|caption|dd|details|dialog|div|dl|dt|fieldset|' +
  'figcaption|figure|footer|form|h[1-6]|header|hr|html|legend|li|main|nav|ol|option|p|pre|' +
  'section|summary|table|tbody|td|tfoot|th|thead|tr|ul';

const BLOCK_TAG_PATTERN = new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');

/**
 * HTML 4's Latin-1 entities, in code-point order from U+00A0: the set a page's own
 * text uses (`&nbsp;`, `&deg;`, `&eacute;`), decoded so each costs one character
 * as it would in a converter's output rather than six. The typographic handful
 * below it covers what prose adds. Anything else stays as written.
 */
const LATIN1_ENTITIES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn ' +
  'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave ' +
  'Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN ' +
  'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute ' +
  'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
  'yacute thorn yuml';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  rarr: '→',
  larr: '←',
  trade: '™',
  ...Object.fromEntries(LATIN1_ENTITIES.split(' ').map((name, i) => [name, String.fromCodePoint(0xa0 + i)])),
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}


/** The value of one attribute on a tag, unquoted and entity-decoded, or `null`. */
function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/** Tags gone, entities decoded, whitespace collapsed to single spaces: one line of text. */
function inlineText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drops the elements an agent never reads, contents included, plus comments. */
function dropUnreadElements(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const name of DROPPED_ELEMENTS) {
    out = out.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}\\s*>`, 'gi'), '');
  }
  return out;
}

/**
 * One HTML fragment, already stripped of unread elements, rendered to text.
 *
 * Links and images are rewritten first, so their text and URL survive the tag
 * strip; block tags become line breaks; everything else goes. Regular expressions
 * rather than a parser, on purpose: this runs inside the serverless fast tier, where
 * a DOM library is weight the import graph must not carry, and a count of characters
 * does not need a tree.
 */
function renderFragment(fragment: string): string {
  const linked = fragment
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => {
      const href = attribute(`<a${attrs}`, 'href');
      const text = inlineText(inner);
      return href === null ? ` ${text} ` : ` [${text}](${href}) `;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attribute(tag, 'alt') ?? '';
      const src = attribute(tag, 'src');
      return src === null ? ` ${alt} ` : ` ![${alt}](${src}) `;
    });
  const broken = linked.replace(BLOCK_TAG_PATTERN, '\n').replace(/<[^>]*>/g, ' ');
  return decodeEntities(broken)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Finds the main content's element in the (already stripped) HTML: the first
 * `main`, else the first `article`. Returns the offsets of its inner HTML.
 */
function locateMainContent(
  html: string,
): { region: 'main' | 'article'; innerStart: number; innerEnd: number } | null {
  for (const region of ['main', 'article'] as const) {
    const open = new RegExp(`<${region}\\b[^>]*>`, 'i').exec(html);
    if (!open) continue;
    const innerStart = open.index + open[0].length;
    const close = new RegExp(`</${region}\\s*>`, 'i').exec(html.slice(innerStart));
    const innerEnd = close ? innerStart + close.index : html.length;
    return { region, innerStart, innerEnd };
  }
  return null;
}

/**
 * The HTML as an agent reads it, with the main content's position marked.
 *
 * Rendered in three parts, before, inside and after the main element, and joined
 * with line breaks, so the content's start is the length of what precedes it.
 */
export function renderAgentText(html: string): {
  text: string;
  region: 'main' | 'article' | null;
  contentStart: number | null;
  contentLength: number;
} {
  const stripped = dropUnreadElements(html);
  const located = locateMainContent(stripped);
  if (!located) {
    return { text: renderFragment(stripped), region: null, contentStart: null, contentLength: 0 };
  }
  const before = renderFragment(stripped.slice(0, located.innerStart));
  const inside = renderFragment(stripped.slice(located.innerStart, located.innerEnd));
  const after = renderFragment(stripped.slice(located.innerEnd));
  const text = [before, inside, after].filter((part) => part.length > 0).join('\n');
  const contentStart = before.length > 0 ? before.length + 1 : 0;
  return { text, region: located.region, contentStart, contentLength: inside.length };
}

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

function figure(total: number, content: number): BudgetFigure {
  const measured = Math.min(total, READING_BUDGET_CHARS);
  const clamped = Math.max(0, Math.min(content, measured));
  return {
    share: measured === 0 ? 0 : Math.round((100 * clamped) / measured),
    content: clamped,
    measured,
    total,
  };
}

/** The content share of the first 8,000 characters of a page read as text. */
export function measureTextBudget(html: string): TextBudget {
  const rendered = renderAgentText(html);
  const total = rendered.text.length;
  const measured = Math.min(total, READING_BUDGET_CHARS);
  let content = 0;
  if (rendered.contentStart !== null) {
    const end = Math.min(measured, rendered.contentStart + rendered.contentLength);
    content = Math.max(0, end - rendered.contentStart);
  }
  return { ...figure(total, content), region: rendered.region, contentStart: rendered.contentStart };
}

/** A list item that is one markdown link and nothing else. */
const LINK_ONLY_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]*\]\([^)]*\)\s*$/;

/** Half-open character ranges of what is not content. */
type Range = [start: number, end: number];

function overlap(ranges: Range[], windowEnd: number): number {
  let sum = 0;
  for (const [start, end] of ranges) {
    const clippedEnd = Math.min(end, windowEnd);
    if (clippedEnd > start) sum += clippedEnd - start;
  }
  return sum;
}

/** The content share of the first 8,000 characters of a page's markdown twin. */
export function measureMarkdownBudget(markdown: string): MarkdownBudget {
  const text = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const total = text.length;
  const chrome: Range[] = [];

  const frontMatter = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
  const frontMatterLength = frontMatter ? frontMatter[0].length : 0;
  if (frontMatterLength > 0) chrome.push([0, frontMatterLength]);

  // Blocks are runs of non-blank lines. Each is classified whole, with its
  // position tracked in the original text so the window can be cut across it.
  let navigationLists = 0;
  let blockStart: number | null = null;
  let blockLines: string[] = [];
  let offset = frontMatterLength;
  const closeBlock = (end: number) => {
    if (blockStart !== null && blockLines.every((line) => LINK_ONLY_ITEM.test(line))) {
      navigationLists += 1;
      chrome.push([blockStart, end]);
    }
    blockStart = null;
    blockLines = [];
  };
  for (const line of text.slice(frontMatterLength).split('\n')) {
    const lineEnd = offset + line.length;
    if (line.trim().length === 0) {
      closeBlock(offset);
    } else {
      if (blockStart === null) blockStart = offset;
      blockLines.push(line);
    }
    offset = lineEnd + 1;
  }
  closeBlock(total);

  const measured = Math.min(total, READING_BUDGET_CHARS);
  const content = measured - overlap(chrome, measured);
  return { ...figure(total, content), frontMatter: frontMatterLength, navigationLists };
}

/** Both figures for one page, in the compact shape that travels. */
export function measureReadingBudget(page: { html: string; markdown: string | null }): {
  text: TextBudget;
  markdown: MarkdownBudget | null;
  budget: ReadingBudget;
} {
  const text = measureTextBudget(page.html);
  const markdown = page.markdown === null ? null : measureMarkdownBudget(page.markdown);
  return {
    text,
    markdown,
    budget: {
      text: { share: text.share, measured: text.measured },
      markdown: markdown === null ? null : { share: markdown.share, measured: markdown.measured },
    },
  };
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

const digits = new Intl.NumberFormat('en-US');

/**
 * One figure as a sentence fragment: "61% of the first 8,000 characters", or, for
 * a page the window did not fill, "94% of all 3,120 characters (the whole page,
 * shorter than 8,000)". The reader is told which of the two they are looking at,
 * because 100% of a short page and 100% of a long one are different claims.
 */
export function describeFigure(fig: BudgetFigure): string {
  if (fig.total > READING_BUDGET_CHARS) {
    return `${fig.share}% of the first ${digits.format(READING_BUDGET_CHARS)} characters`;
  }
  return `${fig.share}% of all ${digits.format(fig.total)} characters (the whole page, shorter than ${digits.format(READING_BUDGET_CHARS)})`;
}
