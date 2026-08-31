#!/usr/bin/env node
/**
 * Walk every visible element of a page in RETRO appearance and report the ones still resolving a
 * modern colour token or a non-retro font.
 *
 * WHY THIS EXISTS. Retro and modern now ship one DOM: the same markup, repainted by
 * `src/styles/retro.css` under `html[data-appearance='retro']`. That makes a whole defect class
 * silent. A retro rule that loses a specificity tie, misses one compound of a compiled Astro
 * selector, or sets a custom property on an ancestor that a component redeclares closer to the
 * target leaves a modern colour painted inside a parchment page — valid markup, adequate contrast,
 * correct aria tree. The build passes, the a11y suite passes, the goldens pass, axe passes. Across
 * three consecutive conversion phases this sweep is the only check that caught any of it: seven
 * element/property pairs on /steward, five across /scorecard and /activity, one font on /webmcp.
 *
 * It works because the two palettes are mechanically distinguishable. Modern's colours are all
 * `oklch()` or `color()`; retro's are hex and named. Modern's faces are the self-hosted webfonts;
 * retro's are the four system faces below. So "a modern token survived here" is a computed-style
 * question, not a visual one, and a browser can answer it for every element on the page.
 *
 * ADVISORY. Never in the `build` chain, no CI wiring, no a11y-suite row — the same footing as
 * spellcheck and the validators. It runs against a served production build because the dev server
 * renders CSS differently (CLAUDE.md, Authoring content) and because two of the routes have no
 * file in `dist/client` at all.
 *
 * Usage:
 *   npm run build
 *   node scripts/serve-built-site.mjs --port 4321 &
 *   npm run sweep:retro [-- --base http://localhost:4321] [--routes /steward,/projects]
 *
 * Exit 1 on any finding, 2 on a usage or environment error.
 */

import { chromium } from '@playwright/test';
import { RETRO_ROUTES } from './lib/retro-routes.mjs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

const base = flag('base', 'http://localhost:4321').replace(/\/$/, '');

/**
 * The viewport the sweep measures at. 1280 is the suite's desktop width, and the width every
 * recorded per-phase count was taken at, so a count here is comparable with the ones on the cards.
 */
const VIEWPORT = { width: 1280, height: 900 };

/**
 * The faces retro uses. A visible element whose resolved `font-family` names none of them is
 * wearing a modern webfont or the UA default.
 *
 * Matched as substrings of the resolved stack rather than against its first entry: a resolved
 * stack is the authored list, not the face that won, so the honest question is whether a retro
 * face appears in it at all.
 */
const RETRO_FONTS = ['Georgia', 'Comic Sans MS', 'Verdana', 'Courier New'];

/**
 * The colour properties walked, and the signature of a modern value.
 *
 * The four border colours are in the list even though most elements draw no border, because an
 * unpainted border resolves to `currentColor` — which is exactly how one wrong `color` on a
 * container becomes five findings on the same element and why a per-element count can run below
 * the finding count.
 */
const COLOUR_PROPERTIES = [
  'color',
  'backgroundColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'outlineColor',
  'textDecorationColor',
];
const MODERN_COLOUR = /oklch\(|color\(/;

/**
 * Findings that are intended and not defects.
 *
 * Deliberately empty. Every known exception candidate turned out not to need one — the /webmcp LCD
 * output panel is the obvious case, and it is painted entirely in retro tokens, so it does not
 * flag. This is machinery with zero entries rather than a list waiting to be filled: an entry gets
 * added only when classifying a real finding produces one, and it carries the reason inline. A
 * suppression written as prose somewhere else is a suppression nobody will ever re-examine.
 *
 * @type {{ id: string, route: string, matches: (finding: { selector: string, property: string, value: string }) => boolean, why: string }[]}
 */
const ALLOWLIST = [];

function allowanceFor(route, finding) {
  return ALLOWLIST.find((entry) => entry.route === route && entry.matches(finding));
}

/**
 * The one route that has to be interacted with before it can be swept.
 *
 * /webmcp's output panes are empty until a tool runs, and their contents are built by script, so
 * a scan of the page as served never sees the JSON syntax colours at all — which is where phase
 * 7's defect lived. Running the first tool puts one real result on the page and makes those spans
 * measurable.
 */
const PREPARE = {
  '/webmcp': async (page) => {
    const run = page.locator('.tool-card .run-button:not([disabled])').first();
    await run.waitFor({ state: 'visible', timeout: 15_000 });
    await run.click();
    // The wiring script sets `data-state` on the output frame; "success" means the JSON is
    // rendered and its `json-*` spans exist.
    await page
      .locator('.tool-card [data-frame][data-state="success"]')
      .first()
      .waitFor({ timeout: 15_000 });
  },
};

/** Persist retro before the first paint, the way a returning visitor arrives. */
async function openRetro(context, path) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mattpyle:appearance', 'retro');
    } catch {
      /* ignore */
    }
  });
  const response = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  if (!response || response.status() !== 200) {
    throw new Error(`${path}: expected 200 from ${base}, got ${response?.status() ?? 'no response'}. Is the build served?`);
  }
  const appearance = await page.locator('html').getAttribute('data-appearance');
  if (appearance !== 'retro') {
    // A page that silently rendered modern would sweep clean while checking nothing.
    throw new Error(`${path}: data-appearance is "${appearance}", not "retro".`);
  }
  return page;
}

/**
 * The sweep itself, run inside the page.
 *
 * Every element under `main` — the site chrome is shared and already covered wherever it is
 * painted — minus anything the reader cannot see: `display: none`, `visibility: hidden`, or a
 * zero-by-zero box. Those three exclusions matter more than they look: retro hides whole modern
 * subtrees rather than restyling them, and without the skips the sweep would report every hidden
 * modern element on every page.
 */
async function sweep(page) {
  return await page.evaluate(
    ({ properties, modern, fonts }) => {
      const modernColour = new RegExp(modern);

      /** A selector a person can paste into devtools: the element's own shape plus its ancestry. */
      function describe(el) {
        const parts = [];
        for (let node = el; node && node !== document.body; node = node.parentElement) {
          let part = node.tagName.toLowerCase();
          if (node.id) part += `#${node.id}`;
          else if (node.classList.length) part += `.${[...node.classList].join('.')}`;
          parts.unshift(part);
          if (node.id) break;
        }
        return parts.join(' > ');
      }

      const findings = [];
      const elements = [...document.querySelectorAll('main *')];
      let visible = 0;

      for (const el of elements) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        visible++;

        const selector = describe(el);
        for (const property of properties) {
          const value = style[property];
          if (value && modernColour.test(value)) findings.push({ selector, property, value });
        }

        const family = style.fontFamily;
        if (!fonts.some((face) => family.includes(face))) {
          findings.push({ selector, property: 'fontFamily', value: family });
        }
      }

      return { findings, visible, total: elements.length };
    },
    { properties: COLOUR_PROPERTIES, modern: MODERN_COLOUR.source, fonts: RETRO_FONTS },
  );
}

const only = flag('routes', '')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);
const unknown = only.filter((path) => !RETRO_ROUTES.includes(path));
if (unknown.length > 0) {
  console.error(`retro-sweep: no such route(s): ${unknown.join(', ')}`);
  process.exit(2);
}
const routes = only.length > 0 ? only : RETRO_ROUTES;

console.log(`retro-sweep: ${routes.length} route(s) from ${base} in retro at ${VIEWPORT.width}px`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT });
let failures = 0;
let allowed = 0;

try {
  for (const route of routes) {
    const page = await openRetro(context, route);
    try {
      await PREPARE[route]?.(page);
      const { findings, visible, total } = await sweep(page);

      const reported = [];
      for (const finding of findings) {
        const allowance = allowanceFor(route, finding);
        if (allowance) {
          allowed++;
          continue;
        }
        reported.push(finding);
      }
      failures += reported.length;

      console.log(`\n${route}: ${reported.length} finding(s) over ${visible} visible element(s) (${total} total)`);
      for (const { selector, property, value } of reported) {
        console.log(`  ${property}: ${value}\n    ${selector}`);
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await context.close();
  await browser.close();
}

if (allowed > 0) console.log(`\n${allowed} finding(s) covered by an allowlist entry.`);

if (failures > 0) {
  console.error(`\nretro-sweep: FAILED — ${failures} finding(s) across ${routes.length} route(s).`);
  process.exit(1);
}

console.log(`\nretro-sweep: ${routes.length} route(s) clean, 0 findings, ${ALLOWLIST.length} allowlist entr(ies).`);
