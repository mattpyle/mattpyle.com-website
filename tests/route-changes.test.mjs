// scripts/route-changes.sh decides which CI jobs run and, through
// scripts/vercel-ignore.sh, whether Vercel builds a preview. A served file routed
// as documentation loses its preview, and the findings loop then has nothing to
// measure a fix on before the merge.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/route-changes.sh', import.meta.url));

/** The routing outputs for a pull request that changes exactly `file`. */
function route(file) {
  const dir = mkdtempSync(join(tmpdir(), 'route-changes-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), 'changed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  // The script fetches from `origin`; the repository is its own.
  git('remote', 'add', 'origin', dir);
  const output = join(dir, '.routing');
  execFileSync('bash', [script, 'pull_request', base], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'route-scratch-')) },
    stdio: 'ignore',
  });
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('='))
  );
}

test('markdown the site serves or builds from is a site change', () => {
  for (const file of ['public/agents.md', 'src/data/skills/a-skill.md', 'src/content/writing/post.md']) {
    assert.equal(route(file).site, 'true', file);
  }
});

test('markdown that documents the repository builds no preview', () => {
  for (const file of ['README.md', 'CLAUDE.md', 'agents/steward/README.md', 'agents/consultant/README.md']) {
    assert.equal(route(file).site, 'false', file);
  }
});
