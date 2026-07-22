import assert from 'node:assert/strict';
import test from 'node:test';
import { create as createFont } from 'fontkit';
import { Resvg } from '@resvg/resvg-js';
import {
  loadVariableFont,
  renderWritingCard,
} from '../scripts/generate-og-images.mjs';

async function cardFonts() {
  // wawoff2 reuses its WASM output buffer, so preserve the generator's
  // sequential loading order here too.
  const monoTtf = await loadVariableFont('fonts/jetbrains-mono-latin.woff2');
  const serifTtf = await loadVariableFont('fonts/source-serif-4-latin.woff2');
  const monoFont = createFont(monoTtf);
  const serifFont = createFont(serifTtf);

  return {
    monoRegular: monoFont.getVariation({ wght: 400 }),
    monoMedium: monoFont.getVariation({ wght: 500 }),
    serifSemibold: serifFont.getVariation({ wght: 600 }),
  };
}

test('OG cards render measured fonts as paths instead of platform fallback text', async () => {
  const svg = renderWritingCard({
    title: 'Hello, World! Or, this post is a lie.',
    date: '18 JUL 2026',
    eyebrow: 'Writing',
    ...await cardFonts(),
  });

  assert.doesNotMatch(svg, /<(?:text|image)\b/);
  assert.doesNotMatch(svg, /font-family|fontBuffers/);
  assert.deepEqual(
    [...svg.matchAll(/data-role="title-line" data-text="([^"]+)"/g)].map((match) => match[1]),
    ['Hello, World! Or, this post is', 'a lie.'],
  );

  const rendered = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  assert.equal(rendered.width, 1200);
  assert.equal(rendered.height, 630);
  assert.ok(rendered.asPng().length > 0);

  const pixels = rendered.pixels;
  const isBackground = (x, y) => {
    const offset = (y * rendered.width + x) * 4;
    return pixels[offset] === 250
      && pixels[offset + 1] === 247
      && pixels[offset + 2] === 240
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
  for (let y = 500; y < 580; y += 1) {
    for (let x = 72; x < 112; x += 1) {
      if (!isBackground(x, y)) markInk += 1;
    }
  }
  assert.ok(markInk > 0, 'expected the vector mark to render');
});
