/**
 * Steward's copy of the fix log's entry rules (`src/lib/fix-log-rules.ts`) against the
 * site's own: `scripts/fix-log-entries.mjs`, the `fixes` schema in `src/content.config.ts`,
 * `scripts/lib/fix-metadata.mjs` and every real entry in `src/content/fixes/`.
 *
 * The worker's image holds no site file, so the copy lives in Steward's source and only
 * this test reads the site. `SITE_READERS` and `RULE_COPY_READERS` in
 * `scripts/select-steward-tests.mjs` select it when the content or any of those files
 * changes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REAL_SITE_DIR, realSitePath } from '../helpers/real-site.js';
import {
  FIX_LOG_FORBIDDEN,
  checkEntry,
  entryData,
  entryFile,
  entryFileText,
  findingFacts,
  fixEntryShape,
  slugFromTitle,
} from '../../src/lib/fix-log-rules.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';

// Through a URL, not a literal specifier: these are plain JavaScript outside this workspace.
const siteScript = new URL('../../../../scripts/fix-log-entries.mjs', import.meta.url).href;
const metadataScript = new URL('../../../../scripts/lib/fix-metadata.mjs', import.meta.url).href;
const { FORBIDDEN } = (await import(siteScript)) as { FORBIDDEN: string[] };
const { readFixMetadata } = (await import(metadataScript)) as {
  readFixMetadata: (dir: string) => Map<string, { lastmod: string; key: string }>;
};

const ENTRIES = realSitePath('src/content/fixes');

function realEntries(): Array<{ file: string; text: string; data: Record<string, any> }> {
  return fs
    .readdirSync(ENTRIES)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const text = fs.readFileSync(path.join(ENTRIES, file), 'utf8');
      return { file, text, data: parseFrontmatter(text.replace(/\r\n/g, '\n')).data as Record<string, any> };
    });
}

/** The field names of the site's `fixes` schema, each with whether it may be absent. */
function siteFields(): Map<string, boolean> {
  const config = fs.readFileSync(path.join(REAL_SITE_DIR, 'src', 'content.config.ts'), 'utf8').replace(/\r\n/g, '\n');
  const block = config.match(/const fixes = defineCollection\(\{[\s\S]*?schema: z\.object\(\{\n([\s\S]*?)\n  \}\)\.refine/)?.[1];
  assert.ok(block, 'the fixes schema is where this test expects it in src/content.config.ts');
  const fields = new Map<string, boolean>();
  // A field opens at four spaces of indent; its options close the field, on its last line.
  const opens = [...block.matchAll(/^ {4}(\w+): +z\./gm)];
  opens.forEach((m, i) => {
    const end = i + 1 < opens.length ? opens[i + 1].index : block.length;
    const body = block.slice(m.index, end).replace(/\s*\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/, '').trimEnd();
    fields.set(m[1], /\.(optional|default)\([^()]*\),?$/.test(body));
  });
  return fields;
}

test('the forbidden strings equal the site script\'s', () => {
  assert.deepEqual([...FIX_LOG_FORBIDDEN], FORBIDDEN);
});

test('the schema copy has the site schema\'s fields, each optional where the site\'s is', () => {
  const site = siteFields();
  const steward = new Map(
    Object.entries(fixEntryShape).map(([name, schema]) => [name, schema.safeParse(undefined).success]),
  );
  assert.deepEqual([...steward.keys()].sort(), [...site.keys()].sort(), 'the same field names');
  for (const [name, optional] of site) assert.equal(steward.get(name), optional, `${name} optional on both sides or neither`);
});

test('the change fields are optional where the site\'s are', () => {
  const config = fs.readFileSync(path.join(REAL_SITE_DIR, 'src', 'content.config.ts'), 'utf8');
  const changes = fixEntryShape.changes.element.shape;
  for (const name of ['number', 'title', 'opened', 'merged'] as const) {
    const site = config.match(new RegExp(`^ +${name}: +(z\\..*),?$`, 'm'))?.[1] ?? '';
    assert.ok(site, `the site's changes.${name}`);
    assert.equal(changes[name].safeParse(undefined).success, /\.optional\(\)/.test(site), `changes.${name}`);
  }
});

test('every real entry passes Steward\'s schema and rules', () => {
  const entries = realEntries();
  assert.ok(entries.length > 0, 'the collection has entries');
  for (const e of entries) {
    const others = entries.filter((o) => o !== e);
    const failures = checkEntry(e.text, { titles: others.map((o) => o.data.title), slugs: others.map((o) => o.data.slug) });
    assert.deepEqual(failures, [], `${e.file} fails Steward's copy of the rules`);
  }
});

test('the slug derivation reproduces the slugs not set by hand', () => {
  const entries = realEntries();
  const differ = entries.filter((e) => slugFromTitle(e.data.title) !== e.data.slug).map((e) => e.data.key).sort();
  // Set by hand before Steward derived slugs: a camel-case word split, a possessive dropped.
  assert.deepEqual(differ, ['MP-105', 'MP-62', 'MP-75']);
  assert.equal(slugFromTitle("The site's agent said: it takes SendMessage—only"), 'the-sites-agent-said-it-takes-sendmessage-only');
});

test('an entry Steward writes reads back through the site\'s metadata reader', () => {
  const finding = `---\nkey_short: MP-990\nstatus: resolved\ntype: content\nkind: defect\nfirst_seen: 2026-11-20\nverdict_at: 2026-11-21T10:00:00.000Z\nlinks:\n  pr: https://github.com/mattpyle/mattpyle.com-website/pull/990\n---\n\n## What happened\n\n- URL: https://www.mattpyle.com/about/\n`;
  const facts = findingFacts(finding);
  assert.ok(facts);
  assert.equal(facts.verified, null, 'no verification yet');
  const data = entryData(facts, { number: 990, title: 'fix: about', opened: '2026-11-21T11:00:00Z', merged: null }, {
    title: 'The about page named a section that no longer exists',
    lead: 'A reader following the page looked for a heading it no longer has.',
    visual: false,
    measures: [{ label: 'Sections the page named that exist', before: '2 of 3', after: '3 of 3' }],
    story: 'The about page named three sections.',
  });
  const text = entryFileText(data, 'The about page named three sections.');
  assert.deepEqual(checkEntry(text, { titles: [], slugs: [] }, { newEntry: true }), []);
  assert.doesNotMatch(text, /verified:|merged:/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-log-rules-'));
  try {
    fs.writeFileSync(path.join(dir, entryFile('MP-990')), text);
    const meta = readFixMetadata(dir);
    assert.deepEqual([...meta.keys()], ['the-about-page-named-a-section-that-no-longer-exists']);
    assert.equal(meta.get('the-about-page-named-a-section-that-no-longer-exists')?.lastmod, '2026-11-21');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
