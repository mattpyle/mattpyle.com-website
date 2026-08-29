/**
 * The committed brand surfaces: the favicon set and the two site-wide OG
 * fallback cards.
 *
 * Unlike `generate-og-images.mjs` this is NOT a build hook. Everything it writes
 * is a tracked file in `public/`, so it runs by hand (`npm run brand:assets`)
 * when the mark or the palette changes, and the result is reviewed and committed
 * like any other asset. Wiring it into `prebuild` would have every build rewrite
 * tracked binaries on every machine that runs one.
 *
 * The mark is `mp/`, the site's own wordmark, set in IBM Plex Mono on a rounded
 * ink plate — the same chip the OG cards sign with. `favicon.svg` carries it as
 * glyph paths, not `<text>`, so it renders identically in a browser that has
 * never seen IBM Plex Mono, and it is the source every raster below is rendered
 * from.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { COLORS, MARK_TEXT, loadBrandFonts, renderMark } from './lib/brand.mjs';
import { CANVAS_WIDTH, rasterise, renderFallbackCard } from './generate-og-images.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const publicDir = join(root, 'public');

/** The icon is drawn once at 128 and scaled, so every size is the same artwork. */
const ICON_BOX = 128;

/**
 * A full-bleed plate with the wordmark centred on it. Full-bleed rather than
 * inset: a favicon is rendered into a 16px box that already has padding around
 * it, and an inset plate spends a third of the artwork on margin.
 *
 * `padding: 0` lets `minWidth` alone decide the plate, so the plate is the
 * square canvas and the mark centres on it.
 */
function renderIcon(mono, { text = MARK_TEXT, fontRatio, radiusRatio } = {}) {
  const mark = renderMark(mono, {
    x: 0,
    y: 0,
    height: ICON_BOX,
    text,
    fontSize: ICON_BOX * fontRatio,
    radiusRatio,
    padding: 0,
    minWidth: ICON_BOX,
    plateFill: COLORS.ink,
    textFill: COLORS.bg,
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_BOX}" height="${ICON_BOX}" viewBox="0 0 ${ICON_BOX} ${ICON_BOX}">
  ${mark.svg}
</svg>`;
}

/**
 * The full mark, at every size that can hold it: `mp/` set at 0.4 of the box is
 * about 92 units wide inside the 128 box, an even 18-unit margin each side.
 */
const FULL_MARK = { fontRatio: 0.4, radiusRatio: 0.1 };

/**
 * THE 16px CUT DROPS THE SLASH. Three monospaced glyphs across a 16px tile give
 * each one under 5px and a sub-pixel stem; measured, `mp/` at 16 is a smudge and
 * `mp` at 0.72 of the box is legible. This is the optical-size argument every
 * icon set makes, and the terminator is the one part of the wordmark that can go
 * without the mark stopping being itself. Every other size, and favicon.svg —
 * which is what a browser scales for a retina tab — carries the full `mp/`.
 */
const SMALL_MARK = { text: 'mp', fontRatio: 0.72, radiusRatio: 0.08 };

function renderIconPng(svg, size) {
  return new Resvg(svg, {
    font: { loadSystemFonts: false },
    fitTo: { mode: 'width', value: size },
  }).render().asPng();
}

/**
 * A PNG-payload ICO. Every browser and every Windows since Vista reads PNG
 * inside an ICO container, and it keeps the three entries byte-identical to the
 * standalone PNGs.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);      // width, 0 means 256
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);  // height
    directory.writeUInt8(0, at + 2);                       // palette size
    directory.writeUInt8(0, at + 3);                       // reserved
    directory.writeUInt16LE(1, at + 4);                    // colour planes
    directory.writeUInt16LE(32, at + 6);                   // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...entries.map(({ png }) => png)]);
}

async function main() {
  const { display, mono } = await loadBrandFonts();

  const iconSvg = renderIcon(mono, FULL_MARK);
  writeFileSync(join(publicDir, 'favicon.svg'), `${iconSvg}
`);
  console.log('generate-brand-assets: wrote favicon.svg');

  const smallIconSvg = renderIcon(mono, SMALL_MARK);

  // 180 is the size Apple asks for; the rest are the sizes already declared in
  // Layout.astro's head and site.webmanifest.
  const pngSizes = [
    { size: 16, file: 'favicon-16x16.png', svg: smallIconSvg },
    { size: 32, file: 'favicon-32x32.png', svg: iconSvg },
    { size: 48, file: 'favicon-48x48.png', svg: iconSvg },
    { size: 512, file: 'favicon-512x512.png', svg: iconSvg },
    { size: 180, file: 'apple-touch-icon.png', svg: iconSvg },
  ];

  const rendered = new Map();
  for (const { size, file, svg } of pngSizes) {
    const png = renderIconPng(svg, size);
    rendered.set(size, png);
    writeFileSync(join(publicDir, file), png);
    console.log(`generate-brand-assets: wrote ${file}`);
  }

  writeFileSync(join(publicDir, 'favicon.ico'), buildIco(
    [16, 32, 48].map((size) => ({ size, png: rendered.get(size) })),
  ));
  console.log('generate-brand-assets: wrote favicon.ico');

  // og:image is 1.91:1 and twitter:image is 16:9, hence two files.
  const fallbacks = [
    { height: 630, file: 'og-fallback.png' },
    { height: Math.round((CANVAS_WIDTH / 16) * 9), file: 'og-fallback-twitter.png' },
  ];

  for (const { height, file } of fallbacks) {
    writeFileSync(join(publicDir, file), rasterise(renderFallbackCard({ height, display, mono })));
    console.log(`generate-brand-assets: wrote ${file}`);
  }
}

export { FULL_MARK, SMALL_MARK, buildIco, renderIcon };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('generate-brand-assets: failed');
    console.error(error);
    process.exit(1);
  });
}
