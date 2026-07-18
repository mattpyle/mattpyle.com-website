import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as createFont } from 'fontkit';
import wawoff2 from 'wawoff2';
import { Resvg } from '@resvg/resvg-js';
import { readWritingMetadata } from './lib/writing-metadata.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 630;
const PADDING = 72;
const TITLE_MAX_WIDTH = 1000;
const COLORS = {
  bg: '#faf7f0',
  heading: '#231f18',
  text: '#3a3428',
  muted: '#6b6358',
  label: '#7d6035',
  border: '#e7e0d2',
  accent: '#7a2e2e',
};

function titleFontSize(title) {
  if (title.length <= 55) return 76;
  if (title.length <= 80) return 62;
  if (title.length <= 110) return 50;
  return 42;
}

function formatDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDate().toString().padStart(2, '0');
  const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  return `${day} ${month} ${d.getUTCFullYear()}`;
}

/** @param {import('fontkit').Font} instance @param {number} fontSize */
function metrics(instance, fontSize) {
  const scale = fontSize / instance.unitsPerEm;
  return {
    ascent: instance.ascent * scale,
    descent: Math.abs(instance.descent) * scale,
    widthOf: (text) => instance.layout(text).advanceWidth * scale,
  };
}

/** Vertical centering for a single-line text box within a row of height `rowHeight`, top at `rowTop`. */
function centeredBaseline(rowTop, rowHeight, instance, fontSize) {
  const { ascent, descent } = metrics(instance, fontSize);
  const contentHeight = ascent + descent;
  return rowTop + (rowHeight - contentHeight) / 2 + ascent;
}

/** Natural single-line box height for a font at a given size and CSS line-height multiplier. */
function naturalLineHeight(instance, fontSize, lineHeightMultiplier) {
  return fontSize * lineHeightMultiplier;
}

/** Greedy word-wrap using real glyph advances so lines never exceed maxWidth. */
function wrapText(instance, text, fontSize, maxWidth) {
  const { widthOf } = metrics(instance, fontSize);
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && widthOf(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadVariableFont(publicPath) {
  const woff2 = readFileSync(join(root, 'public', publicPath));
  return wawoff2.decompress(woff2).then((ttf) => Buffer.from(ttf));
}

async function main() {
  // wawoff2's decompress reuses a shared WASM output buffer, so these must run
  // sequentially — Promise.all interleaves them and corrupts the first result.
  const monoTtf = await loadVariableFont('fonts/jetbrains-mono-latin.woff2');
  const serifTtf = await loadVariableFont('fonts/source-serif-4-latin.woff2');
  const monoFont = createFont(monoTtf);
  const serifFont = createFont(serifTtf);
  const monoRegular = monoFont.getVariation({ wght: 400 });
  const monoMedium = monoFont.getVariation({ wght: 500 });
  const serifSemibold = serifFont.getVariation({ wght: 600 });

  const markPng = readFileSync(join(root, 'public', 'favicon-512x512.png')).toString('base64');

  // Each content collection that needs per-entry share cards, with the eyebrow
  // its card carries. Both render into public/og/<collection>/ (gitignored,
  // regenerated every build).
  const collections = [
    { dir: join(root, 'src', 'content', 'writing'), eyebrow: 'Writing', out: 'writing' },
    { dir: join(root, 'src', 'content', 'changelog'), eyebrow: 'Changelog', out: 'changelog' },
  ];

  for (const { dir, eyebrow, out } of collections) {
    const metadata = readWritingMetadata(dir);
    const outDir = join(root, 'public', 'og', out);
    mkdirSync(outDir, { recursive: true });

    for (const [slug, entry] of metadata) {
      if (entry.draft) continue;
      if (!entry.title || !entry.date) {
        throw new Error(`generate-og-images: ${slug} is missing a title or date`);
      }

      const svg = renderWritingCard({
        title: entry.title,
        date: formatDate(entry.date),
        eyebrow,
        monoRegular,
        monoMedium,
        serifSemibold,
        markPng,
      });

      const resvg = new Resvg(svg, {
        font: { fontBuffers: [monoTtf, serifTtf], loadSystemFonts: false },
      });
      const png = resvg.render().asPng();
      writeFileSync(join(outDir, `${slug}.png`), png);
      console.log(`generate-og-images: wrote og/${out}/${slug}.png`);
    }
  }
}

function renderWritingCard({ title, date, eyebrow, monoRegular, monoMedium, serifSemibold, markPng }) {
  const contentTop = PADDING;
  const contentBottom = CANVAS_HEIGHT - PADDING;
  const availableHeight = contentBottom - contentTop;

  const eyebrowFontSize = 20;
  const eyebrowLineHeight = naturalLineHeight(monoMedium, eyebrowFontSize, 1.2);

  const fontSize = titleFontSize(title);
  const titleLines = wrapText(serifSemibold, title, fontSize, TITLE_MAX_WIDTH);
  const titleLineHeight = fontSize * 1.06;
  const titleBlockHeight = titleLines.length * titleLineHeight;

  const bottomRowHeight = 40; // set by the 40x40 mark image, the tallest item in the row

  const gap = (availableHeight - eyebrowLineHeight - titleBlockHeight - bottomRowHeight) / 2;

  const eyebrowTop = contentTop;
  const titleTop = eyebrowTop + eyebrowLineHeight + gap;
  const bottomRowTop = titleTop + titleBlockHeight + gap;

  const eyebrowBaseline = centeredBaseline(eyebrowTop, eyebrowLineHeight, monoMedium, eyebrowFontSize);

  const titleLineSvg = titleLines.map((line, i) => {
    const { ascent } = metrics(serifSemibold, fontSize);
    const halfLeading = (titleLineHeight - (ascent + metrics(serifSemibold, fontSize).descent)) / 2;
    const baseline = titleTop + i * titleLineHeight + halfLeading + ascent;
    const letterSpacing = (fontSize * -0.02).toFixed(2);
    return `<text x="${PADDING}" y="${baseline.toFixed(1)}" font-family="Source Serif 4" font-weight="600" font-size="${fontSize}" letter-spacing="${letterSpacing}" fill="${COLORS.heading}">${escapeXml(line)}</text>`;
  }).join('\n    ');

  const markSize = 40;
  const markX = PADDING;
  const markY = bottomRowTop;
  const markRadius = markSize * 0.22;

  const dividerX = markX + markSize + 20;
  const dividerHeight = 28;
  const dividerY = bottomRowTop + (bottomRowHeight - dividerHeight) / 2;

  const nameFontSize = 18;
  const nameX = dividerX + 1 + 20;
  const nameBaseline = centeredBaseline(bottomRowTop, bottomRowHeight, monoRegular, nameFontSize);
  const nameWidth = metrics(monoRegular, nameFontSize).widthOf('Matt Pyle ');

  const dateFontSize = 16;
  const dateX = CANVAS_WIDTH - PADDING;
  const dateBaseline = centeredBaseline(bottomRowTop, bottomRowHeight, monoRegular, dateFontSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">
  <defs>
    <clipPath id="mark-clip">
      <rect x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" rx="${markRadius}" ry="${markRadius}" />
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="${COLORS.bg}" />
  <text x="${PADDING}" y="${eyebrowBaseline.toFixed(1)}" font-family="JetBrains Mono" font-weight="500" font-size="${eyebrowFontSize}" letter-spacing="3.2" fill="${COLORS.label}">${escapeXml(eyebrow.toUpperCase())}</text>
  ${titleLineSvg}
  <image href="data:image/png;base64,${markPng}" x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" clip-path="url(#mark-clip)" />
  <rect x="${dividerX}" y="${dividerY.toFixed(1)}" width="1" height="${dividerHeight}" fill="${COLORS.border}" />
  <text x="${nameX}" y="${nameBaseline.toFixed(1)}" font-family="JetBrains Mono" font-weight="400" font-size="${nameFontSize}" fill="${COLORS.text}">Matt Pyle </text>
  <text x="${(nameX + nameWidth).toFixed(1)}" y="${nameBaseline.toFixed(1)}" font-family="JetBrains Mono" font-weight="400" font-size="${nameFontSize}" fill="${COLORS.muted}">&#8212; mattpyle.com</text>
  <text x="${dateX}" y="${dateBaseline.toFixed(1)}" font-family="JetBrains Mono" font-weight="400" font-size="${dateFontSize}" letter-spacing="0.96" fill="${COLORS.label}" text-anchor="end">${escapeXml(date)}</text>
  <rect x="0" y="${CANVAS_HEIGHT - 10}" width="${CANVAS_WIDTH}" height="10" fill="${COLORS.accent}" />
</svg>`;
}

main().catch((error) => {
  console.error('generate-og-images: failed');
  console.error(error);
  process.exit(1);
});
