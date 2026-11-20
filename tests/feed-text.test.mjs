import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import rss from '@astrojs/rss';
import { XMLParser } from 'fast-xml-parser';
import { escapeHtml } from '../src/lib/feed-text.mjs';

const PROBE = 'Tom & Jerry <b>bold</b> "q" &amp; <slug>';

/** What a feed reader does with a description once the XML is parsed: one pass of HTML entity decoding. */
function decodeHtml(html) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"' };
  return html.replace(/&(amp|lt|gt|quot);/g, (_, name) => named[name]);
}

async function feedXml(description) {
  const response = await rss({
    title: 'Feed',
    description: 'A feed.',
    site: 'https://www.example.com/writing/',
    items: [{ title: 'Item', description, link: '/writing/item/', pubDate: new Date(0) }],
  });
  return response.text();
}

function itemDescription(xml) {
  const parsed = new XMLParser({ trimValues: false }).parse(xml);
  return parsed.rss.channel.item.description;
}

test('escapeHtml escapes the three characters HTML reads as markup, and leaves a quote alone', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('/writing/<slug>.md'), '/writing/&lt;slug&gt;.md');
  assert.equal(escapeHtml('say "hi"'), 'say "hi"');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('a served description carries two layers: HTML inside XML', async () => {
  const xml = await feedXml(escapeHtml('<slug> & more'));
  assert.match(xml, /<description>&amp;lt;slug&amp;gt; &amp;amp; more<\/description>/);
});

for (const text of ['a & b', 'a < b', 'a > b', 'say "hi"', 'an existing &amp; entity', PROBE]) {
  test(`a description round-trips through XML and then HTML: ${text}`, async () => {
    const xml = await feedXml(escapeHtml(text));
    assert.equal(decodeHtml(itemDescription(xml)), text);
  });
}

test('without the escape, a reader sees markup where the author wrote text', async () => {
  const html = itemDescription(await feedXml(PROBE));
  assert.equal(html, PROBE);
  assert.notEqual(decodeHtml(html), PROBE);
});

test('a second escape is a third layer, and does not round-trip', async () => {
  const xml = await feedXml(escapeHtml(escapeHtml('a & b')));
  assert.match(xml, /a &amp;amp;amp; b/);
  assert.notEqual(decodeHtml(itemDescription(xml)), 'a & b');
});

// The routes import astro:content, so node cannot load them. Their source is checked instead.
for (const [route, importPath] of [
  ['src/pages/rss.xml.ts', '../lib/feed-text.mjs'],
  ['src/pages/changelog/rss.xml.ts', '../../lib/feed-text.mjs'],
]) {
  test(`${route} escapes each item description once, with the shared helper`, () => {
    const source = readFileSync(new URL(`../${route}`, import.meta.url), 'utf8');
    assert.ok(source.includes(`import { escapeHtml } from '${importPath}';`));
    assert.equal(source.match(/escapeHtml\(/g).length, 1);
    assert.match(source, /^\s+description: escapeHtml\(\w+\.data\.\w+\),$/m);
    assert.doesNotMatch(source, /function escapeHtml/);
  });
}
