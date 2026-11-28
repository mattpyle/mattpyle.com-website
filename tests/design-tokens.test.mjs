import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileTokens } from '../scripts/build-tokens.mjs';
import { ACCENTS, COLORS, THEME_COLOR } from '../scripts/lib/brand-tokens.mjs';
import { contrastRatio, oklchToHex, parseOpaqueColor } from '../scripts/lib/oklch.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC_CODE_EXT = /\.(astro|css|html|svg|js|mjs|ts|tsx|jsx)$/i;
const readJson = (rel) => JSON.parse(readFileSync(`${ROOT}${rel}`, 'utf8'));

/** Parse lightness L from `oklch(L C H ...)` */
function oklchLightness(value) {
  const m = /^oklch\(\s*([\d.]+)\s+/.exec(String(value).trim());
  assert.ok(m, `Expected oklch() colour, got ${value}`);
  return Number(m[1]);
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, out);
    else out.push(fullPath);
  }
  return out;
}

test('generated design-token artifacts are in sync with tokens/*.tokens.json', async () => {
  const expected = await compileTokens();
  const stale = [];

  for (const [relPath, content] of Object.entries(expected)) {
    const actual = readFileSync(`${ROOT}${relPath}`, 'utf8').replaceAll('\r\n', '\n');
    if (actual !== content) stale.push(relPath);
  }

  assert.deepEqual(
    stale,
    [],
    `Generated token files are out of date. Run \`npm run tokens:build\`:\n  ${stale.join('\n  ')}`,
  );
});

test('every custom property declared in src/styles/tokens.css is read under src/', () => {
  const tokensCssPath = resolve(ROOT, 'src/styles/tokens.css');
  const tokensCss = readFileSync(tokensCssPath, 'utf8');

  assert.match(
    tokensCss,
    /@layer\s+reset,\s*tokens,\s*base,\s*components,\s*themes;/,
    'tokens.css must declare the cascade layer order',
  );
  assert.match(tokensCss, /@layer\s+tokens\s*\{/, 'tokens.css must wrap tokens in @layer tokens');

  // Parse all custom-property declarations directly from tokens.css on disk.
  const declared = new Map();
  for (const match of tokensCss.matchAll(/(?<![\w-])(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const name = match[1];
    const refs = [...match[2].matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]);
    const existing = declared.get(name) ?? [];
    declared.set(name, [...existing, ...refs]);
  }
  assert.ok(declared.size > 0, 'tokens.css must declare custom properties');

  // Scan src/ independently of build-tokens.mjs for real var(--name) consumers.
  const excluded = new Set([
    tokensCssPath,
    resolve(ROOT, 'src/data/design-tokens.generated.json'),
  ]);
  const readInSrc = new Set();
  for (const fullPath of walkFiles(join(ROOT, 'src'))) {
    if (excluded.has(resolve(fullPath)) || !SRC_CODE_EXT.test(fullPath)) continue;
    const text = readFileSync(fullPath, 'utf8');
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      readInSrc.add(match[1]);
    }
  }

  // A property in tokens.css is reachable if src/ reads it directly or via another emitted property.
  const reachable = new Set(readInSrc);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...reachable]) {
      const deps = declared.get(name);
      if (!deps) continue;
      for (const dep of deps) {
        if (!reachable.has(dep)) {
          reachable.add(dep);
          changed = true;
        }
      }
    }
  }

  const unused = [...declared.keys()].filter((name) => !reachable.has(name)).sort();
  assert.deepEqual(
    unused,
    [],
    `src/styles/tokens.css declares custom properties that nothing under src/ reads:\n  ${unused.join('\n  ')}`,
  );
});

test('no file under scripts/lib/ imports scripts/build-tokens.mjs or style-dictionary', () => {
  const libDir = join(ROOT, 'scripts/lib');
  const offenders = [];

  for (const fullPath of walkFiles(libDir)) {
    if (!/\.(mjs|js|ts)$/i.test(fullPath)) continue;
    const text = readFileSync(fullPath, 'utf8');
    for (const match of text.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1] ?? match[2];
      if (specifier.includes('build-tokens') || specifier.includes('style-dictionary')) {
        offenders.push(`${fullPath.slice(ROOT.length)}: ${specifier}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `scripts/lib/ must not import build-tokens.mjs or style-dictionary:\n  ${offenders.join('\n  ')}`,
  );
  assert.equal(oklchToHex(0.21, 0.012, 265), COLORS.ink);
});

test('every declared contrast pair in Modern and Retro clears WCAG AA', async () => {
  const expected = await compileTokens();
  const data = JSON.parse(expected['src/data/design-tokens.generated.json']);

  assert.ok(data.contrastPairs.length >= 25, 'contrast matrix has both modern and retro pairs');

  const failures = data.contrastPairs
    .filter((pair) => !pair.passes)
    .map((pair) => `${pair.appearance}: ${pair.fgVar} on ${pair.bgVar} (${pair.role}) = ${pair.ratio}:1 < ${pair.min}:1`);

  assert.deepEqual(failures, [], `WCAG AA contrast failures:\n  ${failures.join('\n  ')}`);
});

test('modern colours are authored in oklch() so retro-sweep.mjs can detect leaks', () => {
  const primitives = readJson('tokens/primitives.tokens.json');
  const walk = (node, trail = []) => {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      if (v && typeof v === 'object' && '$value' in v) {
        if (v.$type === 'color') {
          assert.match(
            String(v.$value),
            /^oklch\(/,
            `Modern colour token ${[...trail, k].join('.')} must be authored in oklch(), got ${v.$value}`,
          );
        }
      } else if (v && typeof v === 'object') {
        walk(v, [...trail, k]);
      }
    }
  };
  walk(primitives.color, ['color']);
});

test('status and pressed colours stay distinct from the four section colours, and hover states darken their base', () => {
  const { section, status } = readJson('tokens/primitives.tokens.json').color;
  const sectionNames = ['writing', 'projects', 'agents', 'changelog'];

  // Every section hover colour must be darker than its base colour.
  for (const name of sectionNames) {
    const baseL = oklchLightness(section[name].$value);
    const hoverL = oklchLightness(section[`${name}-hover`].$value);
    assert.ok(
      hoverL < baseL,
      `Section hover --${name}-hover (L=${hoverL}) must be darker than --${name} (L=${baseL})`,
    );
  }

  // Status fills must never reuse any section colour or hover colour (so a status never reads as a section).
  const sectionValues = new Set(
    sectionNames.flatMap((n) => [section[n].$value, section[`${n}-hover`].$value]),
  );
  for (const [name, tok] of Object.entries(status)) {
    assert.ok(
      !sectionValues.has(tok.$value),
      `Status token --status-${name} (${tok.$value}) must not duplicate a section colour`,
    );
  }

  // Pressed agents submit state must be darker than base and distinct from hover.
  const agentsBase = section.agents.$value;
  const agentsHover = section['agents-hover'].$value;
  const agentsPressed = section['agents-pressed'].$value;
  assert.notEqual(agentsPressed, agentsBase, '--agents-pressed must differ from --agents');
  assert.notEqual(agentsPressed, agentsHover, '--agents-pressed must differ from --agents-hover');
  assert.ok(
    oklchLightness(agentsPressed) < oklchLightness(agentsBase),
    '--agents-pressed must be darker than --agents',
  );
});

test('--control-border aliases --ink-6 and clears 3:1 non-text contrast where --rule does not', () => {
  const primitives = readJson('tokens/primitives.tokens.json');
  const semantic = readJson('tokens/semantic.tokens.json');
  const surface = primitives.color.neutral.surface.$value;
  const rule = primitives.color.neutral.rule.$value;
  const ink6 = primitives.color.neutral['ink-6'].$value;

  assert.equal(
    semantic.ds.border.control.$value,
    '{color.neutral.ink-6}',
    '--control-border must alias --ink-6',
  );
  assert.ok(
    contrastRatio(ink6, surface) >= 3.0,
    `--control-border (--ink-6) on --surface must clear 3:1 (got ${contrastRatio(ink6, surface)}:1)`,
  );
  assert.ok(
    contrastRatio(rule, surface) < 3.0,
    `--rule on --surface is expected to stay under 3:1 (got ${contrastRatio(rule, surface)}:1), which is why --control-border exists`,
  );
});

test('tokens.css keeps --font-mono-plex separate from legacy --font-mono', () => {
  const tokensCss = readFileSync(`${ROOT}src/styles/tokens.css`, 'utf8');
  assert.match(tokensCss, /--font-mono-plex:/, 'tokens.css must declare --font-mono-plex');
  assert.doesNotMatch(
    tokensCss,
    /--font-mono\s*:/,
    'tokens.css must not redefine legacy --font-mono while legacy JetBrains Mono rules exist in global.css',
  );
});

test('retro tokens stay strictly hex and system faces, avoid LCD glow #1f8f0f as text, and keep retro pass darker than modern pass', () => {
  const retro = readJson('tokens/retro.tokens.json');
  const primitives = readJson('tokens/primitives.tokens.json');
  const retroFonts = ['Georgia', 'Comic Sans MS', 'Verdana', 'Courier New'];

  for (const [name, tok] of Object.entries(retro.retro.color)) {
    assert.match(
      String(tok.$value),
      /^#[0-9a-f]{6}$/i,
      `Retro colour --retro-${name} must be a 6-digit hex, got ${tok.$value}`,
    );
    assert.notEqual(
      String(tok.$value).toLowerCase(),
      '#1f8f0f',
      `Retro colour --retro-${name} must not use the #1f8f0f LCD glow (shadow only, never text)`,
    );
  }

  for (const [name, tok] of Object.entries(retro.retro.font)) {
    assert.ok(
      retroFonts.some((face) => String(tok.$value).includes(face)),
      `Retro font --retro-font-${name} (${tok.$value}) must use a retro system face`,
    );
  }

  const modernPassLum = parseOpaqueColor(primitives.color.status.pass.$value).luminance;
  const retroPassLum = parseOpaqueColor(retro.retro.color['status-pass'].$value).luminance;
  assert.ok(
    retroPassLum < modernPassLum,
    `--retro-status-pass (L=${retroPassLum.toFixed(4)}) must stay darker than modern --status-pass (L=${modernPassLum.toFixed(4)})`,
  );
});

test('every retro semantic token resolves to a non-oklch value and retro system font', async () => {
  const expected = await compileTokens();
  const data = JSON.parse(expected['src/data/design-tokens.generated.json']);
  const retroFonts = ['Georgia', 'Comic Sans MS', 'Verdana', 'Courier New'];

  for (const token of data.semanticTokens) {
    if (token.type === 'color') {
      assert.doesNotMatch(
        token.retroValue,
        /oklch\(|color\(/i,
        `Retro semantic colour ${token.cssVar} must not resolve to a modern oklch() value (breaks retro-sweep.mjs)`,
      );
    }
    if (token.type === 'fontFamily') {
      assert.ok(
        retroFonts.some((face) => token.retroValue.includes(face)),
        `Retro semantic font ${token.cssVar} (${token.retroValue}) must use a retro system face`,
      );
    }
  }
});

test('brand surfaces (brand-tokens.mjs, Layout theme-color, site.webmanifest) agree on #f2f3f7 and derived hexes', () => {
  const manifest = readJson('public/site.webmanifest');
  const primitives = readJson('tokens/primitives.tokens.json');

  assert.equal(COLORS.bg, THEME_COLOR, 'brand COLORS.bg and THEME_COLOR must match');
  assert.equal(manifest.background_color, THEME_COLOR, 'site.webmanifest background_color must match THEME_COLOR');
  assert.equal(manifest.theme_color, THEME_COLOR, 'site.webmanifest theme_color must match THEME_COLOR');

  assert.equal(COLORS.ink, parseOpaqueColor(primitives.color.neutral.ink.$value).hex);
  assert.equal(COLORS.text, parseOpaqueColor(primitives.color.neutral['ink-4'].$value).hex);
  assert.equal(COLORS.muted, parseOpaqueColor(primitives.color.neutral['ink-6'].$value).hex);
  assert.equal(COLORS.rule, parseOpaqueColor(primitives.color.neutral.rule.$value).hex);

  assert.equal(ACCENTS.writing, parseOpaqueColor(primitives.color.section.writing.$value).hex);
  assert.equal(ACCENTS.projects, parseOpaqueColor(primitives.color.section.projects.$value).hex);
  assert.equal(ACCENTS.changelog, parseOpaqueColor(primitives.color.section.changelog.$value).hex);
  assert.equal(ACCENTS.agents, parseOpaqueColor(primitives.color.section.agents.$value).hex);
});
