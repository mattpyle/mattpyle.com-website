import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatGptUrl, claudeUrl } from '../src/lib/article-actions.mjs';
import { SITE_ORIGIN } from '../src/data/site-origin.mjs';

// The four affordances — view markdown, copy markdown, ask ChatGPT, ask Claude —
// used to ship twice on this page: once in the legacy ArticleActions section and
// once in the post rail. The legacy tree is deleted, so the rail is the only copy
// and this contract now reads it there.
const slug = 'accessibility-and-ai';
const canonicalUrl = `${SITE_ORIGIN}/writing/${slug}/`;
const markdownUrl = `/writing/${slug}.md`;
const articlePath = new URL(`../dist/client/writing/${slug}/index.html`, import.meta.url);
const html = readFileSync(articlePath, 'utf8');
const htmlAttribute = (value) => value.replaceAll('&', '&amp;');

const railSection = html.match(/<aside[^>]*aria-labelledby="post-rail-title"[^>]*>[\s\S]*?<\/aside>/);
assert.ok(railSection, 'expected rendered post rail');
const railHtml = railSection[0];

assert.match(railHtml, /<h2[^>]*id="post-rail-title"[^>]*>About this post<\/h2>/);
assert.match(railHtml, new RegExp(`href="${markdownUrl.replace('.', '\\.')}"[^>]*>`));

for (const label of ['view markdown', 'copy markdown', 'ask chatgpt', 'ask claude']) {
  assert.ok(railHtml.includes(label), `expected rendered rail action label: ${label}`);
}

assert.ok(railHtml.includes(`href="${htmlAttribute(chatGptUrl(canonicalUrl))}"`), 'expected ChatGPT handoff URL');
assert.ok(railHtml.includes(`href="${htmlAttribute(claudeUrl(canonicalUrl))}"`), 'expected Claude handoff URL');
assert.equal((railHtml.match(/target="_blank"/g) ?? []).length, 2, 'expected exactly two new-tab links');
assert.equal((railHtml.match(/rel="noopener noreferrer"/g) ?? []).length, 2, 'expected safe rel on both new-tab links');
assert.match(railHtml, /<button[^>]*class="rail-action"[^>]*disabled[^>]*data-rail-copy/);
assert.match(railHtml, /id="rail-copy-status"[^>]*role="status"[^>]*aria-live="polite"/);

// The rail is shown in BOTH appearances now, so nothing may hide it from one of
// them. `.modern-skin` on this element would blank all four actions in retro.
assert.ok(!/<aside[^>]*class="[^"]*modern-skin/.test(railHtml), 'the rail must not carry .modern-skin');

console.log('validate-article-actions: rendered rail action contract is valid.');
