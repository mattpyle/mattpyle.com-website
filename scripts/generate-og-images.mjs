/**
 * Per-entry share cards for the writing and changelog collections, plus the two
 * site-wide fallback cards.
 *
 * Wired as `predev`/`prebuild`, so every non-draft entry has a card by the time
 * the build reads `image`. Output lands in `public/og/` and is gitignored.
 *
 * The identity, the fonts and the glyph-path rule live in `scripts/lib/brand.mjs`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { readWritingMetadata } from './lib/writing-metadata.mjs';
import {
  ACCENTS,
  COLORS,
  centeredBaseline,
  loadBrandFonts,
  loadVariableFont,
  metrics,
  renderMark,
  renderTextPath,
  wrapText,
} from './lib/brand.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 630;
const PADDING = 72;
const TITLE_MAX_WIDTH = 1000;
const MARK_HEIGHT = 44;

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

/** Natural single-line box height for a font at a given size and CSS line-height multiplier. */
function naturalLineHeight(fontSize, lineHeightMultiplier) {
  return fontSize * lineHeightMultiplier;
}

/**
 * The signature row every card ends on: the `mp/` chip, a hairline, the domain,
 * and an optional right-aligned date.
 *
 * No byline. The mark is already the name in short form, and on the fallback the
 * name is also the 128px headline, so "Matt Pyle — mattpyle.com" here said it a
 * third time on one image (Matt, 2026-08-28). The domain is the one thing the
 * row has to carry, because a share card is often the only place a reader sees
 * where the page lives.
 */
function renderSignatureRow(mono, { top, date }) {
  const mark = renderMark(mono, { x: PADDING, y: top, height: MARK_HEIGHT });

  const dividerX = PADDING + mark.width + 22;
  const dividerHeight = 28;
  const dividerY = top + (MARK_HEIGHT - dividerHeight) / 2;

  const domainFontSize = 18;
  const domainX = dividerX + 1 + 22;
  const domainBaseline = centeredBaseline(top, MARK_HEIGHT, mono, domainFontSize);

  const dateSvg = date
    ? renderTextPath(mono, date, {
      x: CANVAS_WIDTH - PADDING - metrics(mono, 16).widthOf(date, 0.96),
      baseline: centeredBaseline(top, MARK_HEIGHT, mono, 16),
      fontSize: 16,
      fill: COLORS.muted,
      letterSpacing: 0.96,
      role: 'date',
    })
    : '';

  return `${mark.svg}
  <rect x="${dividerX}" y="${dividerY.toFixed(1)}" width="1" height="${dividerHeight}" fill="${COLORS.rule}" />
  ${renderTextPath(mono, 'mattpyle.com', { x: domainX, baseline: domainBaseline, fontSize: domainFontSize, fill: COLORS.muted, role: 'domain' })}
  ${dateSvg}`;
}

/**
 * A per-entry card. `accent` is the collection's semantic colour and is the only
 * thing that changes between a writing card and a changelog card: it paints the
 * short rule and the eyebrow, which is enough to tell the two apart at the size
 * a timeline actually renders a share card.
 */
function renderWritingCard({ title, date, eyebrow, accent = ACCENTS.writing, display, mono }) {
  const ruleHeight = 5;
  const ruleWidth = 96;
  const ruleTop = PADDING;

  const eyebrowFontSize = 20;
  const eyebrowTop = ruleTop + ruleHeight + 24;
  const eyebrowLineHeight = naturalLineHeight(eyebrowFontSize, 1.2);
  const eyebrowBaseline = centeredBaseline(eyebrowTop, eyebrowLineHeight, mono, eyebrowFontSize);

  const bottomRowTop = CANVAS_HEIGHT - PADDING - MARK_HEIGHT;

  const fontSize = titleFontSize(title);
  const titleLetterSpacing = fontSize * -0.03;
  // Wrap against the untracked advance width. The rendered negative tracking
  // only makes the result narrower, preserving a conservative right margin.
  const titleLines = wrapText(display, title, fontSize, TITLE_MAX_WIDTH);
  const titleLineHeight = fontSize * 1.04;
  const titleBlockHeight = titleLines.length * titleLineHeight;

  const titleZoneTop = eyebrowTop + eyebrowLineHeight;
  const titleZoneHeight = bottomRowTop - titleZoneTop;
  const titleTop = titleZoneTop + (titleZoneHeight - titleBlockHeight) / 2;

  const { ascent, descent } = metrics(display, fontSize);
  const halfLeading = (titleLineHeight - (ascent + descent)) / 2;
  const titleLineSvg = titleLines.map((line, i) => renderTextPath(display, line, {
    x: PADDING,
    baseline: titleTop + i * titleLineHeight + halfLeading + ascent,
    fontSize,
    fill: COLORS.ink,
    letterSpacing: titleLetterSpacing,
    role: 'title-line',
  })).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">
  <rect x="0" y="0" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="${COLORS.bg}" />
  <rect x="${PADDING}" y="${ruleTop}" width="${ruleWidth}" height="${ruleHeight}" rx="2.5" ry="2.5" fill="${accent}" />
  ${renderTextPath(mono, eyebrow.toUpperCase(), { x: PADDING, baseline: eyebrowBaseline, fontSize: eyebrowFontSize, fill: accent, letterSpacing: 3.2, role: 'eyebrow' })}
  ${titleLineSvg}
  ${renderSignatureRow(mono, { top: bottomRowTop, date })}
</svg>`;
}

/**
 * The site-wide fallback, used for every page that has no card of its own. It
 * repeats the homepage hero rather than inventing a second headline: the name,
 * with the surname in the agents magenta the H1 fills it with, over a
 * three-noun standfirst.

 *
 * `height` varies because `twitter:image` is cropped 16:9 and `og:image` 1.91:1,
 * so the two are separate files at separate sizes.
 */
function renderFallbackCard({ height, display, mono }) {
  const nameFontSize = 128;
  const nameLetterSpacing = nameFontSize * -0.04;
  const { ascent, descent } = metrics(display, nameFontSize);

  const statement = 'Growth, PLG, and the agentic web';
  const statementFontSize = 24;
  const statementLineHeight = statementFontSize * 1.5;
  const statementLines = wrapText(mono, statement, statementFontSize, 760);

  const bottomRowTop = height - PADDING - MARK_HEIGHT;

  const statementGap = 34;
  const blockHeight = ascent + descent + statementGap + statementLines.length * statementLineHeight;
  const blockTop = PADDING + (bottomRowTop - PADDING - blockHeight) / 2;

  const nameBaseline = blockTop + ascent;
  const firstWidth = metrics(display, nameFontSize).widthOf('Matt ', nameLetterSpacing);

  const statementTop = blockTop + ascent + descent + statementGap;
  const statementSvg = statementLines.map((line, i) => renderTextPath(mono, line, {
    x: PADDING,
    baseline: centeredBaseline(statementTop + i * statementLineHeight, statementLineHeight, mono, statementFontSize),
    fontSize: statementFontSize,
    fill: COLORS.text,
    role: 'statement-line',
  })).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${height}" viewBox="0 0 ${CANVAS_WIDTH} ${height}">
  <rect x="0" y="0" width="${CANVAS_WIDTH}" height="${height}" fill="${COLORS.bg}" />
  ${renderTextPath(display, 'Matt ', { x: PADDING, baseline: nameBaseline, fontSize: nameFontSize, fill: COLORS.ink, letterSpacing: nameLetterSpacing, role: 'name' })}
  ${renderTextPath(display, 'Pyle', { x: PADDING + firstWidth, baseline: nameBaseline, fontSize: nameFontSize, fill: ACCENTS.agents, letterSpacing: nameLetterSpacing, role: 'surname' })}
  ${statementSvg}
  ${renderSignatureRow(mono, { top: bottomRowTop })}
</svg>`;
}

/** All text is paths, so rasterisation has no platform font fallback and is
 * deterministic between local Windows and Vercel. */
function rasterise(svg) {
  return new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
}

async function main() {
  const { display, mono } = await loadBrandFonts();

  // Each content collection that needs per-entry share cards, with the eyebrow
  // and the semantic colour its cards carry. Both render into
  // public/og/<collection>/ (gitignored, regenerated every build).
  const collections = [
    { dir: join(root, 'src', 'content', 'writing'), eyebrow: 'Writing', out: 'writing', accent: ACCENTS.writing },
    { dir: join(root, 'src', 'content', 'changelog'), eyebrow: 'Changelog', out: 'changelog', accent: ACCENTS.changelog },
  ];

  for (const { dir, eyebrow, out, accent } of collections) {
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
        accent,
        display,
        mono,
      });

      writeFileSync(join(outDir, `${slug}.png`), rasterise(svg));
      console.log(`generate-og-images: wrote og/${out}/${slug}.png`);
    }
  }
}

export {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  loadVariableFont,
  main,
  rasterise,
  renderFallbackCard,
  renderTextPath,
  renderWritingCard,
  wrapText,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('generate-og-images: failed');
    console.error(error);
    process.exit(1);
  });
}
