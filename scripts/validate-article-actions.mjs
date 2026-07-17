import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatGptUrl, claudeUrl } from '../src/lib/article-actions.mjs';

const slug = 'i-turned-on-a-screen-reader';
const canonicalUrl = `https://www.mattpyle.com/writing/${slug}/`;
const markdownUrl = `/writing/${slug}.md`;
const articlePath = new URL(`../dist/client/writing/${slug}/index.html`, import.meta.url);
const html = readFileSync(articlePath, 'utf8');
const htmlAttribute = (value) => value.replaceAll('&', '&amp;');

const actionsSection = html.match(/<section[^>]*aria-labelledby="article-actions-title"[^>]*>[\s\S]*?<\/section>/);
assert.ok(actionsSection, 'expected rendered article actions section');
const actionsHtml = actionsSection[0];

assert.match(actionsHtml, /<h2[^>]*id="article-actions-title"[^>]*>Use this article<\/h2>/);
assert.match(actionsHtml, new RegExp(`href="${markdownUrl.replace('.', '\\.')}"[^>]*>`));

for (const label of ['View markdown', 'Copy markdown', 'Ask ChatGPT', 'Ask Claude']) {
  assert.ok(actionsHtml.includes(label), `expected rendered article action label: ${label}`);
}

assert.ok(actionsHtml.includes(`href="${htmlAttribute(chatGptUrl(canonicalUrl))}"`), 'expected ChatGPT handoff URL');
assert.ok(actionsHtml.includes(`href="${htmlAttribute(claudeUrl(canonicalUrl))}"`), 'expected Claude handoff URL');
assert.equal((actionsHtml.match(/target="_blank"/g) ?? []).length, 2, 'expected exactly two new-tab links');
assert.equal((actionsHtml.match(/rel="noreferrer noopener"/g) ?? []).length, 2, 'expected safe rel on both new-tab links');
assert.match(actionsHtml, /<button[^>]*class="article-action"[^>]*disabled[^>]*data-copy-markdown/);
assert.match(actionsHtml, /id="article-actions-status"[^>]*role="status"[^>]*aria-live="polite"/);

console.log('validate-article-actions: rendered action contract is valid.');
