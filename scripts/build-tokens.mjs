/**
 * Compile W3C DTCG design tokens (`tokens/*.tokens.json`) using Style Dictionary into:
 *   1. `src/styles/tokens.css`                 - `@layer tokens` CSS custom properties read under `src/`
 *   2. `scripts/lib/brand-tokens.mjs`          - sRGB hex constants for OG cards, favicons, and theme-color
 *   3. `src/data/design-tokens.generated.json` - machine-readable catalogue (swatches, scales, contrast)
 *
 * `src/styles/tokens.css` emits only properties referenced by `var(--name)` under `src/`
 * (plus any transitive `var(--dep)` referenced by an emitted declaration), so every page
 * loads only active tokens while `tokens/*.tokens.json` and the generated catalogue retain
 * the full scales and `--ds-*` roles.
 *
 * Usage:
 *   node scripts/build-tokens.mjs          # write generated files
 *   node scripts/build-tokens.mjs --check  # exit 1 if any generated file differs from disk
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import StyleDictionary from 'style-dictionary';
import {
  contrastRatio,
  oklchToHex,
  oklchToLinearRgb,
  parseOpaqueColor,
} from './lib/oklch.mjs';

export { contrastRatio, oklchToHex, oklchToLinearRgb, parseOpaqueColor };

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const SRC_CODE_EXT = /\.(astro|css|html|svg|js|mjs|ts|tsx|jsx)$/i;

/** Scan `src/` (excluding generated token outputs) for `var(--name)` custom-property reads. */
function scanUsedCssVars(rootDir) {
  const srcDir = join(rootDir, 'src');
  const excluded = new Set([
    resolve(rootDir, 'src/styles/tokens.css'),
    resolve(rootDir, 'src/data/design-tokens.generated.json'),
  ]);
  const used = new Set();

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (excluded.has(resolve(fullPath)) || !SRC_CODE_EXT.test(entry.name)) {
        continue;
      }
      const text = readFileSync(fullPath, 'utf8');
      for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        used.add(match[1]);
      }
    }
  }

  walk(srcDir);
  return used;
}

/** Expand a seed set of custom property names with any `var(--dep)` they reference in `candidates`. */
function closeOverTransitiveRefs(seedVars, candidates) {
  const byName = new Map();
  for (const { varName, val } of candidates) {
    const list = byName.get(varName) ?? [];
    list.push(val);
    byName.set(varName, list);
  }

  const emitted = new Set(seedVars);
  let changed = true;
  while (changed) {
    changed = false;
    for (const varName of [...emitted]) {
      const values = byName.get(varName);
      if (!values) continue;
      for (const val of values) {
        for (const match of val.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
          if (!emitted.has(match[1])) {
            emitted.add(match[1]);
            changed = true;
          }
        }
      }
    }
  }
  return emitted;
}

/** Canonical CSS custom-property name for a Style Dictionary token. */
function cssVarName(token) {
  const explicit = token.$extensions?.['com.mattpyle']?.cssVar;
  if (explicit) return explicit;
  return `--${token.path.join('-')}`;
}

/** Slug safe for a CSS class suffix (e.g. `--ink-6` -> `ink-6`). */
function swatchSlug(varName) {
  return varName.replace(/^--/, '');
}

/** Extract resolved token value in Style Dictionary v4/v5 DTCG mode. */
function resolvedValue(token) {
  return token.$value ?? token.value;
}

/** Extract original (pre-alias) token value in Style Dictionary v4/v5 DTCG mode. */
function originalValue(token) {
  return token.original?.$value ?? token.original?.value ?? resolvedValue(token);
}

async function resolveDictionary(sources) {
  const sd = new StyleDictionary({
    source: sources.map((rel) => join(root, rel).replace(/\\/g, '/')),
    usesDtcg: true,
    log: { verbosity: 'silent' },
    platforms: {
      css: {
        transforms: [],
      },
    },
  });
  await sd.hasInitialized;
  // Build token dictionary in memory using Style Dictionary's official platform dictionary helper.
  const tokens = await sd.getPlatformTokens('css');
  return tokens;
}

/** Format all generated files purely in memory so `--check` and tests never need temp files. */
export async function compileTokens() {
  const modernDict = await resolveDictionary([
    'tokens/primitives.tokens.json',
    'tokens/semantic.tokens.json',
  ]);
  const retroDict = await resolveDictionary([
    'tokens/primitives.tokens.json',
    'tokens/semantic.tokens.json',
    'tokens/retro.tokens.json',
  ]);

  const modernAll = modernDict.allTokens;
  const retroAll = retroDict.allTokens;

  const modernByPath = new Map(modernAll.map((t) => [t.path.join('.'), t]));
  const retroByPath = new Map(retroAll.map((t) => [t.path.join('.'), t]));

  /** Convert a DTCG reference like `{color.neutral.ink-6}` to `var(--ink-6)`. */
  function cssValueFor(token, lookup) {
    const raw = originalValue(token);
    if (typeof raw === 'string') {
      const refMatch = /^\{([^}]+)\}$/.exec(raw.trim());
      if (refMatch) {
        const target = lookup.get(refMatch[1]);
        if (target) return `var(${cssVarName(target)})`;
      }
    }
    return String(resolvedValue(token));
  }

  // ── 1. src/styles/tokens.css ───────────────────────────────────────────────
  const rootCandidates = [];
  for (const token of modernAll) {
    const varName = cssVarName(token);
    const val = cssValueFor(token, modernByPath);
    rootCandidates.push({ varName, val });

    // Emit backward-compatible legacy alias when declared (e.g. --control-border -> var(--ink-6)).
    const legacyAlias = token.$extensions?.['com.mattpyle']?.legacyAlias;
    if (legacyAlias) {
      rootCandidates.push({ varName: legacyAlias, val });
    }
  }

  const retroCandidates = [];
  for (const token of retroAll) {
    const top = token.path[0];
    if (top !== 'retro' && top !== 'ds') continue;
    const varName = cssVarName(token);
    const val = cssValueFor(token, retroByPath);
    retroCandidates.push({ varName, val });
  }

  const usedVars = scanUsedCssVars(root);
  const emittedVars = closeOverTransitiveRefs(usedVars, [...rootCandidates, ...retroCandidates]);

  const rootDecls = rootCandidates
    .filter(({ varName }) => emittedVars.has(varName))
    .map(({ varName, val }) => `    ${varName}: ${val};`);

  const retroDecls = retroCandidates
    .filter(({ varName }) => emittedVars.has(varName))
    .map(({ varName, val }) => `    ${varName}: ${val};`);

  const tokensCss = [
    '/* ── Generated by scripts/build-tokens.mjs from tokens/*.tokens.json ─────────',
    '   DO NOT EDIT BY HAND. Run `npm run tokens:build` after editing tokens/.',
    '   Cascade layer order is declared here so every stylesheet agrees on priority.',
    '   ────────────────────────────────────────────────────────────────────────── */',
    '@layer reset, tokens, base, components, themes;',
    '',
    '@layer tokens {',
    '  :root {',
    ...rootDecls,
    '  }',
    '',
    "  html[data-appearance='retro'] {",
    ...retroDecls,
    '  }',
    '}',
    '',
  ].join('\n');

  // ── 2. scripts/lib/brand-tokens.mjs ────────────────────────────────────────
  function brandHex(pathKey) {
    const token = modernByPath.get(pathKey);
    if (!token) throw new Error(`build-tokens: missing brand token ${pathKey}`);
    const override = token.$extensions?.['com.mattpyle']?.brandHex;
    if (override) return override;
    const parsed = parseOpaqueColor(resolvedValue(token));
    if (!parsed) throw new Error(`build-tokens: cannot convert ${pathKey} (${resolvedValue(token)}) to hex`);
    return parsed.hex;
  }

  const brandTokensMjs = [
    '/**',
    ' * Generated by scripts/build-tokens.mjs from tokens/primitives.tokens.json.',
    ' * DO NOT EDIT BY HAND. Run `npm run tokens:build` after changing colour tokens.',
    ' *',
    ' * sRGB hex values derived from the oklch redesign tokens for surfaces that',
    ' * cannot read oklch directly: OG cards (resvg), favicons, manifest, and theme-color.',
    ' * `COLORS.bg` honours the explicit `#f2f3f7` brandHex pin so Layout.astro,',
    ' * site.webmanifest, and OG cards agree to the last byte.',
    ' */',
    '',
    'export const COLORS = {',
    `  bg: '${brandHex('color.neutral.bg')}',`,
    `  ink: '${brandHex('color.neutral.ink')}',`,
    `  text: '${brandHex('color.neutral.ink-4')}',`,
    `  muted: '${brandHex('color.neutral.ink-6')}',`,
    `  rule: '${brandHex('color.neutral.rule')}',`,
    '};',
    '',
    'export const ACCENTS = {',
    `  writing: '${brandHex('color.section.writing')}',`,
    `  projects: '${brandHex('color.section.projects')}',`,
    `  changelog: '${brandHex('color.section.changelog')}',`,
    `  agents: '${brandHex('color.section.agents')}',`,
    '};',
    '',
    `export const THEME_COLOR = '${brandHex('color.neutral.bg')}';`,
    '',
  ].join('\n');

  // ── 3. src/data/design-tokens.generated.json ───────────────────────────────
  const modernColors = modernAll
    .filter((t) => t.path[0] === 'color')
    .map((t) => {
      const varName = cssVarName(t);
      const value = String(resolvedValue(t));
      const parsed = parseOpaqueColor(value);
      const bgVal = String(resolvedValue(modernByPath.get('color.neutral.bg')));
      const surfaceVal = String(resolvedValue(modernByPath.get('color.neutral.surface')));
      return {
        path: t.path.join('.'),
        cssVar: varName,
        swatchClass: `ds-swatch--${swatchSlug(varName)}`,
        group: t.$extensions?.['com.mattpyle']?.group ?? 'Other',
        value,
        hex: t.$extensions?.['com.mattpyle']?.brandHex ?? parsed?.hex ?? null,
        contrastOnBg: contrastRatio(value, bgVal),
        contrastOnSurface: contrastRatio(value, surfaceVal),
        description: t.$description ?? t.comment ?? '',
      };
    });

  const semanticTokens = modernAll
    .filter((t) => t.path[0] === 'ds')
    .map((t) => {
      const key = t.path.join('.');
      const retroTok = retroByPath.get(key);
      const varName = cssVarName(t);
      const modVal = String(resolvedValue(t));
      const retVal = retroTok ? String(resolvedValue(retroTok)) : modVal;
      return {
        path: key,
        cssVar: varName,
        swatchClass: (t.$type ?? t.type) === 'color' ? `ds-swatch--${swatchSlug(varName)}` : null,
        type: t.$type ?? t.type,
        modernRef: String(originalValue(t)),
        modernValue: modVal,
        modernHex: parseOpaqueColor(modVal)?.hex ?? null,
        retroRef: retroTok ? String(originalValue(retroTok)) : null,
        retroValue: retVal,
        description: t.$description ?? t.comment ?? '',
      };
    });

  const retroColors = retroAll
    .filter((t) => t.path[0] === 'retro' && t.path[1] === 'color')
    .map((t) => {
      const varName = cssVarName(t);
      const value = String(resolvedValue(t));
      const parchment = String(resolvedValue(retroByPath.get('retro.color.parchment')));
      const frameBg = String(resolvedValue(retroByPath.get('retro.color.frame-bg')));
      return {
        path: t.path.join('.'),
        cssVar: varName,
        swatchClass: `ds-swatch--${swatchSlug(varName)}`,
        value,
        contrastOnParchment: contrastRatio(value, parchment),
        contrastOnFrame: contrastRatio(value, frameBg),
        description: t.$description ?? t.comment ?? '',
      };
    });

  function collectGroup(prefix) {
    return modernAll
      .filter((t) => t.path.join('.').startsWith(`${prefix}.`))
      .map((t) => ({
        path: t.path.join('.'),
        name: t.path[t.path.length - 1],
        cssVar: cssVarName(t),
        value: String(resolvedValue(t)),
        description: t.$description ?? t.comment ?? '',
      }));
  }

  // Required WCAG AA pairs verified both in tests and shown on the workbench.
  const contrastPairs = [
    // Modern text & accents on --bg
    { appearance: 'modern', fg: 'color.neutral.ink', bg: 'color.neutral.bg', min: 4.5, role: 'Primary text on page ground' },
    { appearance: 'modern', fg: 'color.neutral.ink-2', bg: 'color.neutral.bg', min: 4.5, role: 'Prose text on page ground' },
    { appearance: 'modern', fg: 'color.neutral.ink-4', bg: 'color.neutral.bg', min: 4.5, role: 'Secondary text on page ground' },
    { appearance: 'modern', fg: 'color.neutral.ink-5', bg: 'color.neutral.bg', min: 4.5, role: 'Summary text on page ground' },
    { appearance: 'modern', fg: 'color.neutral.ink-6', bg: 'color.neutral.bg', min: 4.5, role: 'Muted labels on page ground' },
    { appearance: 'modern', fg: 'color.neutral.ink-6', bg: 'color.neutral.surface', min: 3.0, role: 'Control border on card surface (WCAG 1.4.11)' },
    { appearance: 'modern', fg: 'color.section.writing', bg: 'color.neutral.bg', min: 4.5, role: 'Writing accent on page ground' },
    { appearance: 'modern', fg: 'color.section.projects', bg: 'color.neutral.bg', min: 4.5, role: 'Projects accent on page ground' },
    { appearance: 'modern', fg: 'color.section.agents', bg: 'color.neutral.bg', min: 4.5, role: 'Agents accent on page ground' },
    { appearance: 'modern', fg: 'color.section.changelog', bg: 'color.neutral.bg', min: 4.5, role: 'Changelog accent on page ground' },
    { appearance: 'modern', fg: 'color.neutral.paper', bg: 'color.status.pass', min: 4.5, role: 'Pass badge text on pass fill' },
    { appearance: 'modern', fg: 'color.neutral.paper', bg: 'color.status.fail', min: 4.5, role: 'Fail badge text on fail fill' },
    { appearance: 'modern', fg: 'color.neutral.paper', bg: 'color.section.agents-pressed', min: 4.5, role: 'Button text on pressed agents fill' },
    // Retro pairings
    { appearance: 'retro', fg: 'retro.color.ink', bg: 'retro.color.parchment', min: 4.5, role: 'Retro text on parchment' },
    { appearance: 'retro', fg: 'retro.color.ink-muted', bg: 'retro.color.parchment', min: 4.5, role: 'Retro muted text on parchment' },
    { appearance: 'retro', fg: 'retro.color.ink-muted', bg: 'retro.color.sidebar-bg', min: 4.5, role: 'Retro muted text on sidebar ground' },
    { appearance: 'retro', fg: 'retro.color.maroon', bg: 'retro.color.parchment', min: 4.5, role: 'Retro maroon heading on parchment' },
    { appearance: 'retro', fg: 'retro.color.link', bg: 'retro.color.parchment', min: 4.5, role: 'Retro link blue on parchment' },
    { appearance: 'retro', fg: 'retro.color.gold', bg: 'retro.color.forest', min: 4.5, role: 'Retro gold masthead on forest bar' },
    { appearance: 'retro', fg: 'retro.color.cream-soft', bg: 'retro.color.forest', min: 4.5, role: 'Retro nav link on forest bar' },
    { appearance: 'retro', fg: 'retro.color.frame-bg', bg: 'retro.color.status-pass', min: 4.5, role: 'Retro Pass badge text' },
    { appearance: 'retro', fg: 'retro.color.gold', bg: 'retro.color.maroon', min: 4.5, role: 'Retro Fail badge text' },
    { appearance: 'retro', fg: 'retro.color.lcd-digit', bg: 'retro.color.lcd-ground', min: 4.5, role: 'Retro LCD bright output' },
    { appearance: 'retro', fg: 'retro.color.lcd-dim', bg: 'retro.color.lcd-ground', min: 4.5, role: 'Retro LCD idle copy' },
    { appearance: 'retro', fg: 'retro.color.lcd-danger', bg: 'retro.color.lcd-ground', min: 4.5, role: 'Retro LCD error text' },
  ].map((pair) => {
    const map = pair.appearance === 'retro' ? retroByPath : modernByPath;
    const fgTok = map.get(pair.fg);
    const bgTok = map.get(pair.bg);
    const ratio = contrastRatio(String(resolvedValue(fgTok)), String(resolvedValue(bgTok)));
    return {
      ...pair,
      fgVar: cssVarName(fgTok),
      bgVar: cssVarName(bgTok),
      ratio,
      passes: ratio !== null && ratio >= pair.min,
    };
  });

  const designTokensJson = `${JSON.stringify(
    {
      $note: 'Generated by scripts/build-tokens.mjs from tokens/*.tokens.json. Do not edit by hand.',
      themeColor: brandHex('color.neutral.bg'),
      modernColors,
      semanticTokens,
      retroColors,
      fontFamilies: collectGroup('font.family'),
      retroFontFamilies: retroAll
        .filter((t) => t.path[0] === 'retro' && t.path[1] === 'font')
        .map((t) => ({
          path: t.path.join('.'),
          name: t.path[t.path.length - 1],
          cssVar: cssVarName(t),
          value: String(resolvedValue(t)),
          description: t.$description ?? t.comment ?? '',
        })),
      fontSizes: collectGroup('font.size'),
      spacing: collectGroup('space'),
      layout: collectGroup('layout'),
      radii: collectGroup('radius'),
      breakpoints: collectGroup('breakpoint'),
      durations: collectGroup('duration'),
      contrastPairs,
    },
    null,
    2,
  )}\n`;

  return {
    'src/styles/tokens.css': tokensCss,
    'scripts/lib/brand-tokens.mjs': brandTokensMjs,
    'src/data/design-tokens.generated.json': designTokensJson,
  };
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const outputs = await compileTokens();
  const stale = [];

  for (const [relPath, content] of Object.entries(outputs)) {
    const absPath = join(root, relPath);
    const current = existsSync(absPath) ? readFileSync(absPath, 'utf8').replaceAll('\r\n', '\n') : null;
    if (checkOnly) {
      if (current !== content) stale.push(relPath);
    } else {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, 'utf8');
      console.log(`build-tokens: wrote ${relPath}`);
    }
  }

  if (checkOnly) {
    if (stale.length > 0) {
      console.error(`build-tokens: out of date — run \`npm run tokens:build\`:\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`build-tokens: ${Object.keys(outputs).length} generated file(s) up to date.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('build-tokens: failed');
    console.error(error);
    process.exit(1);
  });
}
