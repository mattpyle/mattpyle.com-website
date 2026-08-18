import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildHtml,
  collectUnits,
  DocsUnitError,
  generateDocsViewer,
  parseIndex,
} from '../../src/lib/docs-viewer.js';

const INDEX = `---
title: Steward operator docs
task: reference
commands: []
updated: 2026-08-17
---

# Steward operator docs

One file per operator question. New to it: [alpha](alpha.md).

## Publishing

| Question | Unit |
|---|---|
| How do I do the first thing? | [alpha](alpha.md) |
| How do I do the second? | [beta](beta.md) |

## Reference

| Question | Unit |
|---|---|
| What is every command? | [gamma](gamma.md) |

## The other Steward documents

| Document | Job |
|---|---|
| \`steward/steward-spec.md\` | The design |
| [\`_inventory.md\`](_inventory.md) | What migrated |
`;

const ALPHA = `---
title: Do the first thing
task: run
commands: [steward up, steward review]
updated: 2026-08-16
---

# Do the first thing

\`\`\`bash
steward up
\`\`\`

Run it, then read [beta](beta.md) and the [spec](../steward-spec.md).

## A subheading

| Column | Other |
|---|---|
| a | b |
`;

const BETA = `---
title: Do the second thing
task: decide
commands: [steward reject]
updated: 2026-08-17
---

# Do the second thing

Close it with a reason. It links to [alpha](alpha.md) and to <https://example.com>.
`;

const GAMMA = `---
title: Command reference
task: reference
commands: [steward]
updated: 2026-08-15
---

# Command reference

Every verb, one line each.
`;

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-docs-'));
  const all: Record<string, string> = {
    'README.md': INDEX,
    'alpha.md': ALPHA,
    'beta.md': BETA,
    'gamma.md': GAMMA,
    '_inventory.md': '---\ntitle: Inventory\n---\n\n# Inventory\n',
    ...files,
  };
  for (const [name, body] of Object.entries(all)) {
    if (body === '') continue;
    await fs.writeFile(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

test('the index drives the groups, their order, and each unit question', () => {
  const { groups, questions } = parseIndex(INDEX);
  assert.deepEqual(
    groups.map((group) => group.name),
    ['Publishing', 'Reference'],
  );
  assert.deepEqual(groups[0]?.slugs, ['alpha', 'beta']);
  assert.equal(questions.get('beta'), 'How do I do the second?');
});

test('README.md and _inventory.md are not units', async () => {
  const dir = await fixture();
  const { units } = await collectUnits(dir);
  assert.deepEqual(
    units.map((unit) => unit.slug),
    ['alpha', 'beta', 'gamma'],
  );
});

test('inter-unit links become in-page anchors, other markdown stays a file link', async () => {
  const dir = await fixture();
  const { units } = await collectUnits(dir);
  const alpha = units.find((unit) => unit.slug === 'alpha');
  assert.ok(alpha);
  assert.match(alpha.html, /href="#beta"/);
  assert.match(alpha.html, /href="docs\/steward-spec\.md"/);
  assert.doesNotMatch(alpha.html, /href="[^"#]*beta\.md"/);
});

test('body headings drop a level and carry a unit-scoped id', async () => {
  const dir = await fixture();
  const { units } = await collectUnits(dir);
  const alpha = units.find((unit) => unit.slug === 'alpha');
  assert.match(alpha?.html ?? '', /<h3 id="alpha--a-subheading">/);
});

test('the search text keeps link text and drops link targets', async () => {
  const dir = await fixture();
  const { units } = await collectUnits(dir);
  const gamma = units.find((unit) => unit.slug === 'gamma');
  assert.ok(gamma);
  assert.doesNotMatch(gamma.searchText, /\.md/);
});

test('a unit the index does not list still renders, with a warning', async () => {
  const dir = await fixture({
    'delta.md': '---\ntitle: Stray\ntask: reference\ncommands: []\nupdated: 2026-08-17\n---\n\n# Stray\n\nText.\n',
  });
  const { units, groups, warnings } = await collectUnits(dir);
  assert.ok(units.some((unit) => unit.slug === 'delta'));
  assert.equal(groups.at(-1)?.name, 'Not in the index');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /delta\.md/);
});

test('a unit missing required frontmatter fails, naming the file', async () => {
  const dir = await fixture({
    'delta.md': '---\ntask: reference\nupdated: 2026-08-17\n---\n\n# No title\n',
  });
  await assert.rejects(() => collectUnits(dir), (err: unknown) => {
    assert.ok(err instanceof DocsUnitError);
    assert.match(err.message, /delta\.md: frontmatter "title"/);
    return true;
  });
});

test('an index row pointing at a missing unit fails', async () => {
  const dir = await fixture();
  await fs.rm(path.join(dir, 'gamma.md'));
  await assert.rejects(() => collectUnits(dir), (err: unknown) => {
    assert.ok(err instanceof DocsUnitError);
    assert.match(err.message, /units that do not exist: gamma/);
    return true;
  });
});

test('the page is self-contained: no external stylesheet, script or image', async () => {
  const dir = await fixture();
  const { units, groups, intro } = await collectUnits(dir);
  const html = buildHtml({ units, groups, intro });
  assert.doesNotMatch(html, /<link\b/);
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/);
  assert.doesNotMatch(html, /@import/);
});

test('the same units render byte-identically twice', async () => {
  const dir = await fixture();
  const out = path.join(dir, 'docs.html');
  const first = await generateDocsViewer({ docsDir: dir, outPath: out });
  const second = await generateDocsViewer({ docsDir: dir, outPath: out });
  assert.equal(first.html, second.html);
  assert.equal(await fs.readFile(out, 'utf8'), first.html);
});

test('every in-page anchor the page emits has a matching id', async () => {
  const dir = await fixture();
  const { units, groups, intro } = await collectUnits(dir);
  const html = buildHtml({ units, groups, intro });
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  const broken = targets.filter((target) => !ids.has(target));
  assert.deepEqual(broken, []);
});
