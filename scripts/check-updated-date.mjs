// Warns when a post or changelog entry's body changed and its `updated:` date did not.
//
// `updated:` is set by hand on a substantive edit (CLAUDE.md, Content). Whether an edit is
// substantive takes judgement, so this only warns and always exits 0: it names the file and the
// author decides. It is silent for a new entry, a change to frontmatter alone, and a body change
// that alters only whitespace.
//
// What it compares: the working tree against a base commit, so uncommitted edits count too.
//   - UPDATED_CHECK_BASE, when set: CI sets it to the pull request's base commit.
//   - Otherwise the merge-base of HEAD and origin/master: the fixer's and a local checkout's case.
// When neither resolves (a shallow clone, no origin/master, no remote) it prints one line saying
// it did not run, and exits 0. It must never break `npm test`, which runs it as `posttest`.
//
// Output: under GitHub Actions a `::warning file=…::` line, which shows as an annotation on the
// pull request and in the job summary; elsewhere a plain line naming the file.
//
//   node scripts/check-updated-date.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTENT_DIRS = ['src/content/writing', 'src/content/changelog'];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** @param {string} text @returns {{ frontmatter: string, body: string }} */
export function split(text) {
  const match = text.match(FRONTMATTER);
  if (!match) return { frontmatter: '', body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/** The `updated:` value as written, or null when there is none. @param {string} frontmatter */
export function updatedOf(frontmatter) {
  const match = frontmatter.match(/^updated:[ \t]*(.*?)[ \t]*$/m);
  return match ? match[1].replace(/^["']|["']$/g, '') : null;
}

/** A body with every run of whitespace made one space, so a whitespace-only change compares equal. @param {string} body */
const normalise = (body) => body.replace(/\s+/g, ' ').trim();

/**
 * Whether one modified file needs the warning.
 * @param {string} before the file at the base commit
 * @param {string} after the file now
 */
export function needsWarning(before, after) {
  const was = split(before);
  const now = split(after);
  if (normalise(was.body) === normalise(now.body)) return false;
  return updatedOf(was.frontmatter) === updatedOf(now.frontmatter);
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ ran: false, reason: string } | { ran: true, base: string, files: string[] }}
 */
export function check({ cwd = process.cwd(), env = process.env } = {}) {
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  let base;
  try {
    base = env.UPDATED_CHECK_BASE
      ? git(['rev-parse', '--verify', '--quiet', `${env.UPDATED_CHECK_BASE}^{commit}`])
      : git(['merge-base', 'HEAD', 'origin/master']);
  } catch {
    const wanted = env.UPDATED_CHECK_BASE ? `base commit ${env.UPDATED_CHECK_BASE} is not in this clone` : 'no merge-base with origin/master';
    return { ran: false, reason: wanted };
  }

  const changed = git(['diff', '--no-renames', '--name-only', '--diff-filter=M', base, '--', ...CONTENT_DIRS])
    .split('\n')
    .filter((path) => path.endsWith('.md'));

  const files = changed.filter((path) => needsWarning(git(['show', `${base}:${path}`]), readFileSync(join(cwd, path), 'utf8')));
  return { ran: true, base, files };
}

function main() {
  const result = check();
  if (!result.ran) {
    console.log(`check-updated-date: did not run: ${result.reason}.`);
    return;
  }
  const actions = process.env.GITHUB_ACTIONS === 'true';
  for (const file of result.files) {
    const message = 'The body changed and updated: did not. Set updated: if the change is substantive.';
    console.log(actions ? `::warning file=${file},title=updated: not set::${message}` : `check-updated-date: ${file}: ${message}`);
  }
  if (result.files.length === 0) console.log('check-updated-date: no post or changelog body changed without its updated: date.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
