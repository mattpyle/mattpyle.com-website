import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { check, needsWarning, split, updatedOf } from '../scripts/check-updated-date.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-updated-date.mjs', import.meta.url));

/** @param {string} updated @param {string} body @param {string} [title] */
const post = (updated, body, title = 'A post') => `---\ntitle: "${title}"\ndate: 2026-01-01\nupdated: ${updated}\n---\n\n${body}\n`;

test('the frontmatter and the updated date are read from the file', () => {
  const { frontmatter, body } = split(post('2026-02-03', 'Body text.'));
  assert.equal(updatedOf(frontmatter), '2026-02-03');
  assert.equal(body.trim(), 'Body text.');
  assert.equal(updatedOf('title: x'), null);
});

test('a body change with the date left as it was warns', () => {
  assert.equal(needsWarning(post('2026-02-03', 'Old sentence.'), post('2026-02-03', 'New sentence.')), true);
});

test('a body change with the date set does not warn', () => {
  assert.equal(needsWarning(post('2026-02-03', 'Old sentence.'), post('2026-11-24', 'New sentence.')), false);
});

test('a change to frontmatter alone does not warn', () => {
  assert.equal(needsWarning(post('2026-02-03', 'Same.'), post('2026-02-03', 'Same.', 'A new title')), false);
});

test('a body change that alters only whitespace does not warn', () => {
  assert.equal(needsWarning(post('2026-02-03', 'One line\nwrapped.'), post('2026-02-03', 'One line   wrapped.\n\n')), false);
});

/** A throwaway repository with a base commit, for the git-reading half. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'updated-date-'));
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  mkdirSync(join(dir, 'src/content/writing'), { recursive: true });
  mkdirSync(join(dir, 'src/content/changelog'), { recursive: true });
  writeFileSync(join(dir, 'src/content/writing/body.md'), post('2026-02-03', 'Old sentence.'));
  writeFileSync(join(dir, 'src/content/writing/front.md'), post('2026-02-03', 'Same.'));
  writeFileSync(join(dir, 'src/content/changelog/entry.md'), post('2026-02-03', 'Old entry.'));
  git(['add', '-A']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  return { dir, git, base: git(['rev-parse', 'HEAD']) };
}

test('against a base commit it names only the file whose body changed without its date', (t) => {
  const { dir, base } = scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'src/content/writing/body.md'), post('2026-02-03', 'New sentence.'));
  writeFileSync(join(dir, 'src/content/writing/front.md'), post('2026-02-03', 'Same.', 'Retitled'));
  writeFileSync(join(dir, 'src/content/changelog/entry.md'), post('2026-11-24', 'New entry.'));
  writeFileSync(join(dir, 'src/content/writing/new.md'), post('2026-11-24', 'A new post.'));
  const result = check({ cwd: dir, env: { UPDATED_CHECK_BASE: base } });
  assert.deepEqual(result, { ran: true, base, files: ['src/content/writing/body.md'] });
});

test('with no origin/master it reports that it did not run, and npm test is not broken', (t) => {
  const { dir } = scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(check({ cwd: dir, env: {} }), { ran: false, reason: 'no merge-base with origin/master' });
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'check-updated-date: did not run: no merge-base with origin/master.\n');
});

test('a base commit that is not in the clone is reported the same way', (t) => {
  const { dir } = scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(check({ cwd: dir, env: { UPDATED_CHECK_BASE: missing } }), {
    ran: false,
    reason: `base commit ${missing} is not in this clone`,
  });
});

test('outside a git repository it does not run either', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'updated-date-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: tmpdir() } });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^check-updated-date: did not run: /);
});
