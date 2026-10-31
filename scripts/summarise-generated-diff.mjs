/**
 * Print, as markdown, how the generated `src/data/` files differ between two checkouts.
 *
 * The three files are gitignored, so a pull request's own diff no longer shows what an agent will
 * be told or which page paths the hit counter can name. The `Site tests & astro check` job in
 * .github/workflows/ci.yml generates them on the base commit and on the head, then runs this with
 * the two roots and appends the output to its job summary. That summary is the review signal the
 * committed diff used to be.
 *
 * Usage: node scripts/summarise-generated-diff.mjs <base-root> <head-root>
 *
 * Each file gets a heading, then either "No change." or a unified diff. A file missing from a root
 * is reported as such rather than failing, so a job whose earlier step died still says something.
 * A diff longer than MAX_DIFF_LINES is cut, because the summary has a size limit.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATED_FILES = [
  'src/data/a2a-digest.json',
  'src/data/agent-skills-index.json',
  'src/data/page-paths.mjs',
];

export const MAX_DIFF_LINES = 300;

/** The unified diff of one file between two roots, or '' when they are identical. */
export function diffFile(baseRoot, headRoot, rel) {
  const basePath = join(baseRoot, rel);
  const headPath = join(headRoot, rel);
  // `git diff --no-index` exits 1 on a difference and above 1 on a failure.
  const res = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--no-color',
      '--ignore-cr-at-eol',
      '--',
      basePath,
      headPath,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status === 0) return '';
  if (res.status !== 1) throw new Error(`git diff failed for ${rel}: ${res.stderr}`);
  // Drop the `diff --git` and `index` lines, and name the two sides by their relative path rather
  // than the absolute one `--no-index` prints.
  return res.stdout
    .split('\n')
    .filter((line) => !line.startsWith('diff --git') && !line.startsWith('index '))
    .map((line) => {
      if (line.startsWith('--- ')) return `--- base/${rel}`;
      if (line.startsWith('+++ ')) return `+++ head/${rel}`;
      return line;
    })
    .join('\n')
    .trimEnd();
}

export function summarise(baseRoot, headRoot) {
  const out = ['## Generated data', ''];
  out.push(
    'These files are gitignored. The diff below is between the base branch and this pull request,',
    'each generated from its own checkout.',
    '',
  );
  for (const rel of GENERATED_FILES) {
    out.push(`### \`${rel}\``, '');
    const missing = [
      !existsSync(join(baseRoot, rel)) && 'base',
      !existsSync(join(headRoot, rel)) && 'head',
    ].filter(Boolean);
    if (missing.length > 0) {
      out.push(`Not generated on ${missing.join(' and ')}.`, '');
      continue;
    }
    const diff = diffFile(baseRoot, headRoot, rel);
    if (diff === '') {
      out.push('No change.', '');
      continue;
    }
    const lines = diff.split('\n');
    const shown = lines.slice(0, MAX_DIFF_LINES);
    out.push('```diff', ...shown, '```', '');
    if (lines.length > shown.length) {
      out.push(`Diff cut at ${MAX_DIFF_LINES} of ${lines.length} lines.`, '');
    }
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [baseRoot, headRoot] = process.argv.slice(2);
  if (!baseRoot || !headRoot) {
    process.stderr.write('usage: node scripts/summarise-generated-diff.mjs <base-root> <head-root>\n');
    process.exit(2);
  }
  process.stdout.write(`${summarise(baseRoot, headRoot)}\n`);
}
