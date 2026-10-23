import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeFigure,
  measureMarkdownBudget,
  measureReadingBudget,
  measureTextBudget,
  READING_BUDGET_CHARS,
  renderAgentText,
} from '../../src/lib/agent-audit/reading-budget.js';

/**
 * The reading budget against pages built here, never fetched: a page whose
 * header is most of what an agent reads, a page that is nothing but content, and
 * a page too short to fill the window. The exact rule is the module's docblock;
 * these pin the arithmetic and the rendering it depends on.
 */

/** A paragraph of `words` words, about six characters each. */
function prose(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i % 10}`).join(' ');
}

/** A navigation block of `n` links, the shape a mega-menu renders to. */
function navigation(n: number): string {
  return `<nav>${Array.from({ length: n }, (_, i) => `<a href="/section-${i}/page/">Section ${i}</a>`).join(' ')}</nav>`;
}

function page(body: string): string {
  return `<!doctype html><html><head><title>Ignored</title><style>main{color:red}</style><script>console.log('no')</script></head><body>${body}</body></html>`;
}

test('heavy chrome: a header of sixty links takes most of the window', () => {
  const html = page(`${navigation(60)}<main><h1>Title</h1><p>${prose(2000)}</p></main><footer>${navigation(10)}</footer>`);
  const text = measureTextBudget(html);

  assert.equal(text.region, 'main');
  assert.ok(text.total > READING_BUDGET_CHARS, 'the page is longer than the window');
  assert.equal(text.measured, READING_BUDGET_CHARS);
  // Sixty links of about 35 rendered characters each come before the first word
  // of content, so the content starts a long way into the window.
  assert.ok(text.contentStart !== null && text.contentStart > 1500, `content starts at ${text.contentStart}`);
  assert.ok(text.share < 80, `share ${text.share}`);
  assert.ok(text.share > 50, `share ${text.share}`);
  assert.equal(text.content, READING_BUDGET_CHARS - (text.contentStart ?? 0));
});

test('no chrome: a page that is only main content scores 100', () => {
  const html = page(`<main><h1>Title</h1><p>${prose(2000)}</p></main>`);
  const text = measureTextBudget(html);

  assert.equal(text.region, 'main');
  assert.equal(text.contentStart, 0);
  assert.equal(text.measured, READING_BUDGET_CHARS);
  assert.equal(text.share, 100);
});

test('a short page is measured over its whole length, and says so', () => {
  const html = page(`<header><a href="/">Home</a></header><main><p>${prose(40)}</p></main>`);
  const text = measureTextBudget(html);

  assert.ok(text.total < READING_BUDGET_CHARS);
  assert.equal(text.measured, text.total);
  assert.match(describeFigure(text), /of all \d+ characters \(the whole page, shorter than 8,000\)/);
  // The home link is `[Home](/)` plus a line break: eleven characters of chrome.
  assert.equal(text.content, text.total - 10);
});

test('describeFigure names the window on a page that filled it', () => {
  const html = page(`<main><p>${prose(3000)}</p></main>`);
  assert.equal(describeFigure(measureTextBudget(html)), '100% of the first 8,000 characters');
});

test('article is the main content when there is no main', () => {
  const html = page(`<div><a href="/a">A</a></div><article><p>${prose(50)}</p></article>`);
  const text = measureTextBudget(html);
  assert.equal(text.region, 'article');
  assert.ok(text.share > 90, `share ${text.share}`);
});

test('a page with neither main nor article has no content by the rule', () => {
  const html = page(`<div><p>${prose(50)}</p></div>`);
  const text = measureTextBudget(html);
  assert.equal(text.region, null);
  assert.equal(text.contentStart, null);
  assert.equal(text.share, 0);
  assert.ok(text.total > 0, 'the text is still rendered and counted');
});

test('rendering: links keep their URL, images their alt text, and the head is gone', () => {
  const html = page(
    `<nav><a href="/about/">About &amp; more</a><img src="/logo.png" alt="Logo"></nav>` +
      `<main><h1>Hi</h1><p>One&nbsp;two<br>three</p><!-- hidden --><svg><title>no</title></svg></main>`,
  );
  const rendered = renderAgentText(html);
  assert.equal(rendered.text, '[About & more](/about/) ![Logo](/logo.png)\nHi\nOne two\nthree');
  assert.equal(rendered.contentStart, '[About & more](/about/) ![Logo](/logo.png)\n'.length);
  assert.equal(rendered.contentLength, 'Hi\nOne two\nthree'.length);
});

test('rendering: a comment or script that only appears once its inner one is removed is still removed', () => {
  // `<!-<!---->-` loses its inner comment and the pieces spell `<!--`, so a
  // single pass leaves an opener behind. The strip repeats until nothing
  // changes, and an opener with no close runs to the end of the document.
  const nested = page(`<main><p>Before</p><!-<!---->-<p>Hidden</p>--><p>After</p></main>`);
  const text = renderAgentText(nested).text;
  assert.equal(text.includes('<!--'), false, text);
  assert.equal(text, 'Before\nAfter');

  const unclosed = renderAgentText(page(`<main><p>Shown</p><!-- never closed <p>Gone</p></main>`)).text;
  assert.equal(unclosed, 'Shown');

  // The inner pair goes first and the pieces spell a second script element,
  // which the next pass removes; the paragraph after it is ordinary content.
  const script = page(`<main><p>Shown</p><scr<script></script>ipt>var x = 1;</script><p>Also shown</p></main>`);
  const stripped = renderAgentText(script).text;
  assert.equal(stripped.includes('var x'), false, stripped);
  assert.equal(stripped, 'Shown\nAlso shown');

  const openScript = renderAgentText(page(`<main><p>Shown</p><script>var y = 2;<p>Gone</p></main>`)).text;
  assert.equal(openScript, 'Shown');
});

test('markdown: front matter and a list of bare links are chrome, prose is content', () => {
  const frontMatter = '---\ntitle: "A page"\ncanonical: https://example.com/a/\n---\n';
  const navList = '- [Home](/)\n- [Writing](/writing/)\n- [About](/about/)\n';
  const body = `# A page\n\n${prose(100)}\n\n- [A linked item](/x/): with a note that makes it content\n- plain prose item\n`;
  const markdown = `${frontMatter}\n${navList}\n${body}`;
  const md = measureMarkdownBudget(markdown);

  assert.equal(md.frontMatter, frontMatter.length);
  assert.equal(md.navigationLists, 1);
  assert.equal(md.measured, md.total);
  assert.equal(md.content, md.total - frontMatter.length - navList.length);
  assert.ok(md.share > 50 && md.share < 100, `share ${md.share}`);
});

test('markdown: a long document is cut at the window, chrome counted only inside it', () => {
  const navList = Array.from({ length: 40 }, (_, i) => `- [Link ${i}](/l/${i}/)`).join('\n') + '\n';
  const markdown = `---\ntitle: x\n---\n\n${navList}\n${prose(3000)}\n`;
  const md = measureMarkdownBudget(markdown);
  assert.equal(md.measured, READING_BUDGET_CHARS);
  assert.ok(md.total > READING_BUDGET_CHARS);
  const chrome = '---\ntitle: x\n---\n'.length + navList.length;
  assert.equal(md.content, READING_BUDGET_CHARS - chrome);
});

test('markdown: CRLF reads as LF and a BOM is ignored', () => {
  const md = measureMarkdownBudget('﻿---\r\ntitle: x\r\n---\r\n\r\nHello there.\r\n');
  assert.equal(md.frontMatter, '---\ntitle: x\n---\n'.length);
  assert.equal(md.content, 'Hello there.\n'.length + 1);
});

test('the compact figure carries both shares, and null for a missing twin', () => {
  const html = page(`<main><p>${prose(50)}</p></main>`);
  const both = measureReadingBudget({ html, markdown: `---\nt: 1\n---\n\n${prose(50)}\n` });
  assert.equal(both.budget.text.share, 100);
  assert.ok(both.budget.markdown && both.budget.markdown.share < 100);

  const textOnly = measureReadingBudget({ html, markdown: null });
  assert.equal(textOnly.markdown, null);
  assert.equal(textOnly.budget.markdown, null);
});
