import assert from 'node:assert/strict';
import test from 'node:test';
import { Resvg } from '@resvg/resvg-js';
import { ACCENTS, loadBrandFonts } from '../scripts/lib/brand.mjs';
import { renderWritingCard } from '../scripts/generate-og-images.mjs';

test('OG cards render measured fonts as paths instead of platform fallback text', async () => {
  const svg = renderWritingCard({
    title: 'Hello, World! Or, this post is a lie.',
    date: '18 JUL 2026',
    eyebrow: 'Writing',
    accent: ACCENTS.writing,
    ...await loadBrandFonts(),
  });

  assert.doesNotMatch(svg, /<(?:text|image)\b/);
  assert.doesNotMatch(svg, /font-family|fontBuffers/);
  assert.deepEqual(
    [...svg.matchAll(/data-role="title-line" data-text="([^"]+)"/g)].map((match) => match[1]),
    ['Hello, World! Or, this post is a', 'lie.'],
  );

  const rendered = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  assert.equal(rendered.width, 1200);
  assert.equal(rendered.height, 630);
  assert.ok(rendered.asPng().length > 0);

  const pixels = rendered.pixels;
  const isBackground = (x, y) => {
    const offset = (y * rendered.width + x) * 4;
    return pixels[offset] === 242
      && pixels[offset + 1] === 243
      && pixels[offset + 2] === 247
      && pixels[offset + 3] === 255;
  };

  // The title zone keeps the intended 72px safe area at the right edge.
  for (let y = 150; y < 450; y += 1) {
    for (let x = 1128; x < 1200; x += 1) {
      assert.ok(isBackground(x, y), `unexpected title ink in right safe area at ${x},${y}`);
    }
  }

  // The old data-URI image also disappeared on Vercel; the vector mark must
  // leave visible ink in its expected bottom-left area.
  let markInk = 0;
  for (let y = 514; y < 558; y += 1) {
    for (let x = 72; x < 112; x += 1) {
      if (!isBackground(x, y)) markInk += 1;
    }
  }
  assert.ok(markInk > 0, 'expected the vector mark to render');
});

test('each collection paints its own semantic accent, and only that', async () => {
  const fonts = await loadBrandFonts();
  const card = (eyebrow, accent) => renderWritingCard({
    title: 'A card', date: '18 JUL 2026', eyebrow, accent, ...fonts,
  });

  const writing = card('Writing', ACCENTS.writing);
  const changelog = card('Changelog', ACCENTS.changelog);

  assert.notEqual(ACCENTS.writing, ACCENTS.changelog);
  assert.match(writing, new RegExp(ACCENTS.writing));
  assert.doesNotMatch(writing, new RegExp(ACCENTS.changelog));
  assert.match(changelog, new RegExp(ACCENTS.changelog));
  assert.doesNotMatch(changelog, new RegExp(ACCENTS.writing));

  // The card signs with the site's own wordmark, not the retired serif mark.
  assert.match(writing, /data-role="mark" data-text="mp\/"/);
});
