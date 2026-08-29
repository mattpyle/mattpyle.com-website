/**
 * The redesign identity, shared by every generated brand surface: the per-entry
 * OG cards, the two hand-off fallback cards, and the favicon set.
 *
 * Colours are the `global.css` redesign tokens converted to sRGB hex, because
 * neither resvg nor the ICO/PNG surfaces understand oklch. `oklchToHex` below is
 * the converter that produced them, kept next to its output so a token change
 * can be re-resolved rather than eyeballed.
 *
 * Two rules bind everything that imports this file, and both come from the OG
 * pipeline (see docs/reference/content-pipeline.md):
 *   1. Text is emitted as glyph paths, never `<text>`. Native resvg ignores the
 *      WASM-only `fontBuffers` option, so a `<text>` node silently rasterises in
 *      whatever font the host has — which is not the same font on Vercel's Linux
 *      builder as on a Windows laptop.
 *   2. The mark is vector. It was a data-URI `<image>` once and disappeared on
 *      Vercel.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as createFont } from 'fontkit';
import wawoff2 from 'wawoff2';

const root = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

/** oklch(L C H) → sRGB hex, via Oklab and the linear-sRGB matrix, then gamma. */
export function oklchToHex(lightness, chroma, hueDegrees) {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return `#${linear.map((channel) => {
    const encoded = channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(encoded * 255)))
      .toString(16)
      .padStart(2, '0');
  }).join('')}`;
}

/**
 * `--bg` resolves to #f2f3f6, one unit of blue off the `#f2f3f7` that
 * `Layout.astro` has always sent as its theme-color. The three brand surfaces
 * agreeing exactly is worth more than the last bit of the round trip, so the
 * head's value wins and the manifest and these cards follow it.
 */
export const COLORS = {
  bg: '#f2f3f7',
  ink: oklchToHex(0.21, 0.012, 265),      // --ink, titles and the mark ground
  text: oklchToHex(0.36, 0.012, 265),     // --ink-4, the author name
  muted: oklchToHex(0.41, 0.012, 265),    // --ink-6, domain and date
  rule: oklchToHex(0.9, 0.006, 265),      // --rule, the hairline divider
};

/**
 * The semantic colours. `writing` and `changelog` are the two content
 * collections that get per-entry cards; `agents` is here because the homepage
 * H1 fills "Pyle" with it and the fallback card repeats that headline.
 */
export const ACCENTS = {
  writing: oklchToHex(0.47, 0.13, 255),   // --writing
  changelog: oklchToHex(0.45, 0.11, 65),  // --changelog
  agents: oklchToHex(0.47, 0.16, 330),    // --agents
};

/** The site's own wordmark, re-cut as a chip. `SiteHeader.astro` sets the same string. */
export const MARK_TEXT = 'mp/';

function loadWoff2(publicPath) {
  const woff2 = readFileSync(join(root, 'public', publicPath));
  return wawoff2.decompress(woff2).then((ttf) => Buffer.from(ttf));
}

export { loadWoff2 as loadVariableFont };

/**
 * The two faces every brand surface draws with.
 *
 * `wawoff2.decompress` reuses one shared WASM output buffer, so the two loads
 * must run sequentially — `Promise.all` interleaves them and corrupts the first
 * result.
 *
 * IBM Plex Mono ships here as a static weight-400 file (the `@font-face` in
 * `global.css` declares 400, not a range), so it has no variation axes and
 * `getVariation` must not be called on it. Bricolage is variable over 400–800
 * and is asked for 700, the weight the site's own headings render at.
 */
export async function loadBrandFonts() {
  const displayTtf = await loadWoff2('fonts/bricolage-grotesque-opsz96-latin.woff2');
  const monoTtf = await loadWoff2('fonts/ibm-plex-mono-400-latin.woff2');

  return {
    display: createFont(displayTtf).getVariation({ wght: 700 }),
    mono: createFont(monoTtf),
  };
}

/** @param {import('fontkit').Font} instance @param {number} fontSize */
export function metrics(instance, fontSize) {
  const scale = fontSize / instance.unitsPerEm;
  return {
    ascent: instance.ascent * scale,
    descent: Math.abs(instance.descent) * scale,
    widthOf: (text, letterSpacing = 0) => {
      const run = instance.layout(text);
      return run.advanceWidth * scale + Math.max(0, run.glyphs.length - 1) * letterSpacing;
    },
  };
}

/** Vertical centering for a single-line text box within a row of height `rowHeight`, top at `rowTop`. */
export function centeredBaseline(rowTop, rowHeight, instance, fontSize) {
  const { ascent, descent } = metrics(instance, fontSize);
  return rowTop + (rowHeight - (ascent + descent)) / 2 + ascent;
}

export function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert shaped glyphs to SVG paths using the same font instance used for
 * measurement, for the reason in this file's header.
 */
export function renderTextPath(instance, text, { x, baseline, fontSize, fill, letterSpacing = 0, role }) {
  const run = instance.layout(text);
  const scale = fontSize / instance.unitsPerEm;
  const letterSpacingUnits = letterSpacing / scale;
  let penX = 0;

  const paths = run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const glyphX = penX + position.xOffset;
    const glyphY = position.yOffset;
    penX += position.xAdvance + (index < run.glyphs.length - 1 ? letterSpacingUnits : 0);
    return `<path d="${glyph.path.toSVG()}" transform="translate(${glyphX.toFixed(3)} ${glyphY.toFixed(3)})" />`;
  }).join('\n      ');

  const roleAttribute = role ? ` data-role="${role}"` : '';
  return `<g${roleAttribute} data-text="${escapeXml(text)}" transform="translate(${x.toFixed(3)} ${baseline.toFixed(3)}) scale(${scale.toFixed(6)} ${(-scale).toFixed(6)})" fill="${fill}">
      ${paths}
    </g>`;
}

/** Greedy word-wrap using real glyph advances so lines never exceed maxWidth. */
export function wrapText(instance, text, fontSize, maxWidth, letterSpacing = 0) {
  const { widthOf } = metrics(instance, fontSize);
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && widthOf(candidate, letterSpacing) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Union bounding box of a mark string's drawn outlines, in px at `fontSize`. */
function markInkBox(mono, text, fontSize) {
  const scale = fontSize / mono.unitsPerEm;
  const run = mono.layout(text);
  let penX = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index];
    const { bbox } = glyph;
    minX = Math.min(minX, penX + position.xOffset + bbox.minX);
    maxX = Math.max(maxX, penX + position.xOffset + bbox.maxX);
    minY = Math.min(minY, position.yOffset + bbox.minY);
    maxY = Math.max(maxY, position.yOffset + bbox.maxY);
    penX += position.xAdvance;
  });

  return {
    left: minX * scale,
    top: maxY * scale,
    width: (maxX - minX) * scale,
    height: (maxY - minY) * scale,
  };
}

/**
 * The `mp/` chip: a rounded ink plate with the wordmark set in IBM Plex Mono.
 * The plate is sized from the measured advance width rather than from a
 * constant, so the three glyphs sit on an optically even margin at any height.
 *
 * `minWidth` lets the icon surfaces widen the plate to a full square, where the
 * canvas is the plate; the OG card leaves it at its natural width.
 */
export function renderMark(mono, {
  x,
  y,
  height,
  text = MARK_TEXT,
  fontSize = height * 0.55,
  radiusRatio = 0.22,
  padding = height * 0.28,
  plateFill = COLORS.ink,
  textFill = COLORS.bg,
  minWidth = 0,
}) {
  const advanceWidth = metrics(mono, fontSize).widthOf(text);
  const width = Math.max(minWidth, advanceWidth + padding * 2);
  const radius = height * radiusRatio;

  // Centre on the INK, not on the advance box and not on the font's
  // ascent/descent. A mono face reserves the same generous vertical band for
  // every glyph, so centering `mp/` by metrics leaves it visibly low on the
  // plate; the three glyphs here are two x-height letters, one descender and a
  // slash, and the eye centres what it can see.
  const ink = markInkBox(mono, text, fontSize);
  const textX = x + (width - ink.width) / 2 - ink.left;
  const baseline = y + (height - ink.height) / 2 + ink.top;

  return {
    width,
    svg: `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${width.toFixed(3)}" height="${height.toFixed(3)}" rx="${radius.toFixed(3)}" ry="${radius.toFixed(3)}" fill="${plateFill}" />
  ${renderTextPath(mono, text, { x: textX, baseline, fontSize, fill: textFill, role: 'mark' })}`,
  };
}
