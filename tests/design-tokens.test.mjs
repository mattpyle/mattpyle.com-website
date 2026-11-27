import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileTokens, contrastRatio, parseOpaqueColor } from '../scripts/build-tokens.mjs';
import { ACCENTS, COLORS, THEME_COLOR } from '../scripts/lib/brand-tokens.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(`${ROOT}${rel}`, 'utf8'));

/** Parse lightness L from `oklch(L C H ...)` */
function oklchLightness(value) {
  const m = /^oklch\(\s*([\d.]+)\s+/.exec(String(value).trim());
  assert.ok(m, `Expected oklch() colour, got ${value}`);
  return Number(m[1]);
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
