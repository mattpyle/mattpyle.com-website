// Build-time HTML -> Markdown conversion for pages without a curated `.md` sibling.
//
// The extraction is deliberately generic: take the `main` landmark, drop the things that
// are not content anywhere on the site, convert. When converted output picks up noise, the
// fix belongs in a rule here, not in a per-page exception — a whitelist is exactly what
// this feature exists to avoid.

import domino from '@mixmark-io/domino';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Not content in any appearance: behaviour, presentation, and the noscript twin of
// something already in the DOM.
const NON_CONTENT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// Interactive controls are affordances, not content: markdown has nothing to click, so a
// stranded "Run tool" or a filter row reading "ALL LIVE IN PROGRESS ARCHIVED" is pure noise
// to a reader who only has the text. Their surrounding prose stays.
const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DIALOG']);

// Retro-only furniture (the marquee, the under-construction badge, the guest book, the web
// ring) sits in the DOM on every render and is hidden by CSS in modern. `.retro-furniture`
// is the single class that marks all of it, so one rule covers every piece, present and
// future. Decorative and hidden nodes go the same way.
function isDroppable(element) {
  if (NON_CONTENT_TAGS.has(element.tagName)) return true;
  if (CONTROL_TAGS.has(element.tagName)) return true;
  if (element.classList?.contains('retro-furniture')) return true;
  if (element.hasAttribute('hidden')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  return false;
}

/**
 * Inner HTML of the `main` landmark. Only one `main` is legal per document and
 * Layout.astro emits exactly one, so the greedy match cannot straddle two.
 * @param {string} html
 * @returns {string | null}
 */
export function extractMain(html) {
  const match = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  return match ? match[1] : null;
}

/**
 * Title and metadata a converted page carries in frontmatter. Read from the document head,
 * which every page fills via Layout.astro, rather than guessed from the content.
 * @param {string} html
 */
export function extractMetadata(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1];
  const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i)?.[1];
  return {
    title: title ? decodeEntities(title) : undefined,
    description: description ? decodeEntities(description) : undefined,
    canonical,
  };
}

/** @param {string} value */
function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

// domino's HTMLCollection/NodeList are array-likes, not iterables, and both walks below
// mutate the tree as they go — so snapshot to a real array first, always.
const asArray = (collection) => Array.prototype.slice.call(collection);

// Astro emits markup with no whitespace between sibling elements, and this site leans on
// spans that CSS lays out as blocks (the changelog log-list rows are the worst case: date,
// type pill and title are three adjacent spans). Converted naively those concatenate into
// "02 AUG 2026featureA guest book an agent can sign". Separating adjacent element siblings
// with a space is the CSS-agnostic fix — turndown collapses it away wherever the elements
// really were blocks. Code is exempt: whitespace there is content.
function separateAdjacentElements(node) {
  if (node.tagName === 'PRE' || node.tagName === 'CODE') return;

  for (const child of asArray(node.children)) separateAdjacentElements(child);

  let previous = null;
  for (const child of asArray(node.childNodes)) {
    if (child.nodeType === 3 /* text */) {
      if (child.data.trim() !== '') previous = child;
      else previous = null;
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue;
    if (previous && previous.nodeType === 1) {
      node.insertBefore(node.ownerDocument.createTextNode(' '), child);
    }
    previous = child;
  }
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGURE', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'UL',
]);

// Card-shaped links — the changelog rows, the build cards — are a single `<a>` wrapped
// around a heading and paragraphs. Markdown has no such construct: turndown emits the label
// across several lines and no parser reads it back as a link, so the destination is lost.
// The fix is to push the anchor down onto the heading, which is the shape the writing index
// already uses and the one that round-trips. Links with only inline content are untouched.
function hoistBlockLinks(root) {
  for (const anchor of asArray(root.getElementsByTagName('a'))) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    if (!asArray(anchor.getElementsByTagName('*')).some((el) => BLOCK_TAGS.has(el.tagName))) continue;

    const heading = asArray(anchor.querySelectorAll('h1, h2, h3, h4, h5, h6'))[0];
    if (!heading) continue;

    const document = anchor.ownerDocument;
    const inner = document.createElement('a');
    inner.setAttribute('href', href);
    while (heading.firstChild) inner.appendChild(heading.firstChild);
    heading.appendChild(inner);

    // Unwrap the outer anchor: its remaining children become siblings where they stood.
    const parent = anchor.parentNode;
    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
    parent.removeChild(anchor);
  }
}

function prune(node) {
  for (const child of asArray(node.children)) {
    if (isDroppable(child)) child.remove();
    else prune(child);
  }
}

function createService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
    emDelimiter: '_',
  });
  service.use(gfm);
  return service;
}

const service = createService();

/**
 * Convert one built page to its markdown representation. Returns null when the page has no
 * `main` landmark or nothing survives extraction, which is the caller's signal that the
 * page is not convertible.
 * @param {string} html
 * @returns {string | null}
 */
export function pageToMarkdown(html) {
  const main = extractMain(html);
  if (main === null) return null;

  const document = domino.createDocument(`<div id="main-content">${main}</div>`, true);
  const root = document.getElementById('main-content');
  prune(root);
  hoistBlockLinks(root);
  separateAdjacentElements(root);

  const body = service.turndown(root).trim();
  if (!body) return null;

  const { title, description, canonical } = extractMetadata(html);
  const frontmatter = ['---'];
  if (title) frontmatter.push(`title: ${JSON.stringify(title)}`);
  if (description) frontmatter.push(`description: ${JSON.stringify(description)}`);
  if (canonical) {
    frontmatter.push(`canonical: ${canonical}`);
    frontmatter.push(`source: ${canonical}`);
  }
  frontmatter.push('---');

  return `${frontmatter.join('\n')}\n\n${body}\n`;
}
