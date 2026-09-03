import assert from 'node:assert/strict';
import test from 'node:test';
import { satteri } from '@astrojs/markdown-satteri';
import { rewriteVideoTags, videoEmbedHtml, videoEmbedMdastPlugin } from '../src/lib/video-embed.mjs';

/**
 * The `<Video />` tag Keystatic writes, and the element three surfaces render
 * from it. The match is the interesting part: everything the helper leaves
 * untouched is a line that would otherwise be half-rewritten into broken HTML.
 */

const TAG =
  '<Video src="/video/chatgpt-site-tools.mp4" poster="/video/chatgpt-site-tools-poster.jpg" width={1574} height={820} />';
const ELEMENT =
  '<video controls muted playsinline preload="metadata" width="1574" height="820"' +
  ' poster="/video/chatgpt-site-tools-poster.jpg">' +
  '<source src="/video/chatgpt-site-tools.mp4" type="video/mp4"></video>';

test('the serialised tag becomes the video element', () => {
  assert.equal(videoEmbedHtml(TAG), ELEMENT);
});

// The serialiser writes text fields quoted and integer fields braced. Either
// spelling parses, so a hand-typed tag works as well as a Keystatic-written one.
test('both attribute forms parse, in any order', () => {
  assert.equal(
    videoEmbedHtml('<Video height="820" width="1574" poster="/p.jpg" src="/v.mp4" />'),
    '<video controls muted playsinline preload="metadata" width="1574" height="820"' +
      ' poster="/p.jpg"><source src="/v.mp4" type="video/mp4"></video>'
  );
  assert.equal(
    videoEmbedHtml('<Video src={/v.mp4} poster={/p.jpg} width={16} height={9} />'),
    '<video controls muted playsinline preload="metadata" width="16" height="9"' +
      ' poster="/p.jpg"><source src="/v.mp4" type="video/mp4"></video>'
  );
});

test('attribute values are escaped for HTML', () => {
  const html = videoEmbedHtml('<Video src="/a&b.mp4" poster="/p<x>.jpg" width={1} height={1} />');
  assert.match(html, /src="\/a&amp;b\.mp4"/);
  assert.match(html, /poster="\/p&lt;x&gt;\.jpg"/);
  assert.ok(!html.includes('/a&b.mp4'));
});

test('a quote in a value cannot break out of the attribute', () => {
  // The tag regex refuses an unescaped quote inside a quoted value, so the line
  // is left alone rather than emitted with a broken attribute.
  assert.equal(videoEmbedHtml('<Video src="/a" onerror="x()" .mp4" poster="/p.jpg" width={1} height={1} />'), null);
});

for (const [label, line] of [
  ['a multi-line tag', '<Video src="/v.mp4"\n poster="/p.jpg" width={1} height={1} />'],
  ['a lowercase video element', '<video src="/v.mp4" poster="/p.jpg" width="1" height="1"></video>'],
  ['another component', '<Image src="/v.png" poster="/p.jpg" width={1} height={1} />'],
  ['a tag that is not self-closing', '<Video src="/v.mp4" poster="/p.jpg" width={1} height={1}>'],
  ['a missing attribute', '<Video src="/v.mp4" poster="/p.jpg" width={1} />'],
  ['an extra attribute', '<Video src="/v.mp4" poster="/p.jpg" width={1} height={1} loop={true} />'],
  ['a repeated attribute', '<Video src="/v.mp4" src="/w.mp4" poster="/p.jpg" width={1} height={1} />'],
  ['an empty poster, which is how fields.text serialises a blank', '<Video src="/v.mp4" poster={} width={1} height={1} />'],
  ['a non-integer dimension', '<Video src="/v.mp4" poster="/p.jpg" width={15.5} height={820} />'],
  ['a zero dimension', '<Video src="/v.mp4" poster="/p.jpg" width={0} height={820} />'],
  ['prose either side of the tag', 'See <Video src="/v.mp4" poster="/p.jpg" width={1} height={1} /> above.'],
]) {
  test(`${label} is left untouched`, () => {
    assert.equal(videoEmbedHtml(line), null);
    assert.equal(rewriteVideoTags(line), line);
  });
}

test('a body rewrites its tags and nothing else', () => {
  const body = ['Intro.', '', TAG, '', 'Outro with a `<Video />` mention.'].join('\n');
  assert.equal(
    rewriteVideoTags(body),
    ['Intro.', '', ELEMENT, '', 'Outro with a `<Video />` mention.'].join('\n')
  );
});

test('a body with no tag is returned unchanged', () => {
  const body = '# Title\n\nJust prose.\n';
  assert.equal(rewriteVideoTags(body), body);
});

// The wiring, not just the helper: the same plugin astro.config.mjs installs,
// run through the same Sätteri processor the site builds with. This is what
// proves a post carrying the tag renders the element in a page.
test('the site markdown pipeline renders the element', async () => {
  const renderer = await satteri({ mdastPlugins: [videoEmbedMdastPlugin] }).createRenderer({
    syntaxHighlight: false,
  });
  const { code } = await renderer.render(`Before.\n\n${TAG}\n\nAfter.\n`);

  assert.ok(code.includes(ELEMENT), code);
  assert.ok(!code.includes('<Video'), 'no JSX tag may survive into the page');
  // Block level, so the element is not wrapped in a paragraph.
  assert.match(code, /<\/p>\s*<video /);
});
