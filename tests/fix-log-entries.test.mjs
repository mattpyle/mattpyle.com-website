import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENTRIES_DIR, FORBIDDEN, entryFile, entryText, readEntries, readFinding, readFindings } from '../scripts/fix-log-entries.mjs';

/**
 * The fix log's guards that CI can run.
 *
 * `scripts/fix-log-entries.mjs --check` compares the entries with the private findings folder,
 * which CI does not have. So this file covers the rest: the finding parser, against synthetic
 * findings written here (never a real one), and the entry files themselves.
 */

const ORIGIN = 'https://www.mattpyle.com';

function finding({ key, status = 'resolved', pr = 900, resolvedBy = '', verify = '', body }) {
  return `---
key: synthetic-${key.toLowerCase()}
key_short: ${key}
title_short: "A synthetic finding"
status: ${status}
kind: defect
type: content
first_seen: 2026-10-01
verdict_at: 2026-10-02T03:04:05.678Z
${resolvedBy ? `resolved_by: ${resolvedBy}\n` : ''}verify:${verify || ' []'}
links:
${pr ? `  pr: https://github.com/mattpyle/mattpyle.com-website/pull/${pr}` : '  {}'}
---

# A synthetic finding

## What happened

- URL: ${ORIGIN}/about/

${body}
`;
}

function withFindings(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-log-'));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a single-URL check parses into a site path, expectation and measure', () => {
  withFindings(
    {
      'one.md': finding({
        key: 'MP-901',
        verify: `\n  - url: "${ORIGIN}/writing/post/"\n    kind: text`,
        body: `## Verification

Steward ran this finding's checks against production at 2026-10-03T04:05:06.789Z. Outcome: resolved.

1. Pass, \`text\` on ${ORIGIN}/writing/post/. Expected: 0 occurrences of "href=\\"/webmcp\\"". Measured: 0 occurrences.`,
      }),
    },
    (dir) => {
      const f = readFinding(path.join(dir, 'one.md'));
      assert.equal(f.key, 'MP-901');
      assert.equal(f.status, 'fixed');
      assert.equal(f.confirmedBy, 'check');
      assert.equal(f.where, '/writing/post/');
      assert.equal(f.pr, 900);
      assert.equal(f.found, '2026-10-01');
      assert.equal(f.approved, '2026-10-02T03:04:05.678Z');
      assert.equal(f.verified, '2026-10-03T04:05:06.789Z');
      assert.deepEqual(f.checks, [
        { passed: true, method: 'text', urls: ['/writing/post/'], expected: '0 occurrences of `href="/webmcp"`', measured: '0 occurrences' },
      ]);
    },
  );
});

test('a multi-URL check with a viewport keeps every URL and the viewport', () => {
  withFindings(
    {
      'many.md': finding({
        key: 'MP-902',
        status: 'reopened',
        body: `## Verification

Steward ran this finding's checks against production at 2026-10-03T04:05:06.789Z. Outcome: reopened.

1. Fail, \`js\` on 2 URLs (${ORIGIN}/, ${ORIGIN}/about/) at 390x844. Expected: (() => true)() is true. Measured: 1 of 2 pass.`,
      }),
    },
    (dir) => {
      const f = readFinding(path.join(dir, 'many.md'));
      assert.equal(f.status, 'reopened');
      assert.equal(f.where, '/about/', 'with no verify block, where falls back to the URL the finding observed');
      assert.deepEqual(f.checks, [
        { passed: false, method: 'js', urls: ['/', '/about/'], viewport: '390x844', expected: '(() => true)() is true', measured: '1 of 2 pass' },
      ]);
    },
  );
});

test('a finding confirmed by its deploy has no checks and says so', () => {
  withFindings(
    {
      'deploy.md': finding({
        key: 'MP-903',
        resolvedBy: 'deploy',
        body: `## Verification

Steward confirmed this finding's fix by its deploy at 2026-10-03T04:05:06.789Z. Outcome: confirmed.

No check could measure the fix: the finding has no verify block.`,
      }),
    },
    (dir) => {
      const f = readFinding(path.join(dir, 'deploy.md'));
      assert.equal(f.confirmedBy, 'deploy');
      assert.equal(f.verified, '2026-10-03T04:05:06.789Z');
      assert.deepEqual(f.checks, []);
    },
  );
});

test('a check measured at the verdict becomes the before of the matching after', () => {
  withFindings(
    {
      'before.md': finding({
        key: 'MP-904',
        body: `## Measured at the verdict

Steward ran this finding's checks against production at 2026-10-02T03:04:06.000Z, at its approved verdict.

1. Fail, \`text\` on ${ORIGIN}/agents.md. Expected: 0 occurrences of "old line". Measured: 1 occurrences.

## Verification

Steward ran this finding's checks against production at 2026-10-03T04:05:06.789Z. Outcome: resolved.

1. Pass, \`text\` on ${ORIGIN}/agents.md. Expected: 0 occurrences of "old line". Measured: 0 occurrences.`,
      }),
    },
    (dir) => {
      const [c] = readFinding(path.join(dir, 'before.md')).checks;
      assert.equal(c.before, '1 occurrences');
      assert.equal(c.measured, '0 occurrences');
    },
  );
});

test('a URL on another host that starts with the origin stays a full URL', () => {
  withFindings(
    {
      'host.md': finding({
        key: 'MP-908',
        body: `## Verification

Steward ran this finding's checks against production at 2026-10-03T04:05:06.789Z. Outcome: resolved.

1. Pass, \`text\` on ${ORIGIN}.example.net/page/. Expected: 0 occurrences of "x". Measured: 0 occurrences.`,
      }),
    },
    (dir) => assert.deepEqual(readFinding(path.join(dir, 'host.md')).checks[0].urls, [`${ORIGIN}.example.net/page/`]),
  );
});

test('only resolved or reopened findings with a fix pull request are in the log', () => {
  const body = '## Verification\n\nNothing.';
  withFindings(
    {
      'in.md': finding({ key: 'MP-905', body }),
      'proposed.md': finding({ key: 'MP-906', status: 'proposed', body }),
      'no-pr.md': finding({ key: 'MP-907', pr: 0, body }),
      'INDEX.md': '# index',
    },
    (dir) => assert.deepEqual(readFindings(dir).map((f) => f.key), ['MP-905']),
  );
});

test('each entry file is named by its key in lower case, and no key repeats', () => {
  const entries = readEntries(ENTRIES_DIR);
  assert.ok(entries.length > 0, 'the collection has entries');
  for (const e of entries) assert.equal(e.file, entryFile(String(e.key)), `${e.file} holds key ${e.key}`);
  const keys = entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'no key repeats');
});

test('each entry has a URL-safe slug, and no slug repeats', () => {
  const slugs = readEntries(ENTRIES_DIR).map((e) => e.data.slug);
  for (const slug of slugs) assert.match(String(slug), /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `slug ${slug}`);
  assert.equal(new Set(slugs).size, slugs.length, 'no slug repeats');
});

test('a freshly extracted entry has an empty slug beside its empty title', () => {
  const text = entryText({ key: 'MP-902', type: 'content', kind: 'defect', status: 'fixed', confirmedBy: 'check', where: '/about/', found: '2026-10-01', approved: '2026-10-02T03:04:05.678Z', verified: '2026-10-03T03:04:05.678Z', checks: [] }, { number: 900, title: 't', opened: '2026-10-02T04:00:00Z', merged: '2026-10-02T05:00:00Z' });
  assert.ok(text.includes('title: ""\nslug: ""\n'), 'title and slug are both empty');
});

test('no entry body holds an angle-bracket tag outside code', () => {
  for (const e of readEntries(ENTRIES_DIR)) {
    const prose = e.body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    const tag = prose.match(/<[A-Za-z/!][^>\n]*>?/);
    assert.equal(tag, null, `${e.file} holds ${tag?.[0]} outside backticks`);
  }
});

test('no entry holds a string a workflow id, preview or private path leaves behind', () => {
  for (const e of readEntries(ENTRIES_DIR)) {
    for (const s of FORBIDDEN) assert.ok(!e.text.includes(s), `${e.file} holds ${s}`);
  }
});

test('the sitemap date is the later of verified and updated, in Vancouver time', async () => {
  const { readFixMetadata } = await import('../scripts/lib/fix-metadata.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-meta-'));
  const entry = (slug, extra) => `---\nkey: MP-9${slug.length}\nslug: "${slug}"\nverified: "2026-11-11T04:02:41.358Z"\n${extra}---\nBody.\n`;
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), entry('plain', ''));
    fs.writeFileSync(path.join(dir, 'b.md'), entry('edited', 'updated: "2026-11-20"\n'));
    fs.writeFileSync(path.join(dir, 'c.md'), entry('earlier', 'updated: "2026-11-01"\n'));
    const meta = readFixMetadata(dir);
    assert.equal(meta.get('plain').lastmod, '2026-11-10');
    assert.equal(meta.get('edited').lastmod, '2026-11-20');
    assert.equal(meta.get('earlier').lastmod, '2026-11-10');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
