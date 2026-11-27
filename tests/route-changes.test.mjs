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

/** The routing outputs for a pull request that changes exactly `files`. */
function route(...files) {
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
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), 'changed\n');
  }
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

const FULL = 'tests/**/*.test.ts';

test('content and data run Steward on the tests the selection script lists, not the full suite', () => {
  for (const file of ['src/content/changelog/a-fix.md', 'src/content/writing/post.md', 'src/data/scorecard-runs.json', 'src/data/skills/a-skill.md']) {
    const out = route(file);
    assert.equal(out.steward, 'true', file);
    assert.equal(out.site, 'true', file);
    assert.equal(out.steward_tests, 'select', file);
    assert.equal(out.browser, 'false', file);
  }
});

test('a site file Steward keeps a copy of runs Steward on the selection script', () => {
  for (const file of ['src/content.config.ts', 'scripts/fix-log-entries.mjs', 'scripts/lib/fix-metadata.mjs']) {
    const out = route(file);
    assert.equal(out.steward, 'true', file);
    assert.equal(out.steward_tests, 'select', file);
  }
});

test('content beside a Steward file, a console file or a page still goes to the selection script', () => {
  assert.equal(route('src/content/writing/post.md', 'agents/steward/src/lib/findings.ts').steward_tests, 'select');
  assert.equal(route('src/content/writing/post.md', 'agents/steward/src/console/server.ts').steward_tests, 'select');
  assert.equal(route('src/data/scorecard-runs.json', 'src/pages/index.astro').steward_tests, 'select');
});

test('the install, the workflow file and the routing scripts keep the full Steward suite, with content or alone', () => {
  for (const file of ['package.json', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/route-changes.sh', 'scripts/select-steward-tests.mjs', 'scripts/vercel-ignore.sh']) {
    assert.equal(route(file).steward_tests, FULL, file);
    assert.equal(route(file).steward, 'true', file);
    assert.equal(route('src/content/writing/post.md', file).steward_tests, FULL, `content and ${file}`);
  }
});

test('a console-only change keeps the console tests, and a page alone skips Steward', () => {
  assert.equal(route('agents/steward/src/console/server.ts').steward_tests, 'tests/console/**/*.test.ts');
  assert.equal(route('src/pages/index.astro').steward, 'false');
});

const ignoreScript = fileURLToPath(new URL('../scripts/vercel-ignore.sh', import.meta.url));

/**
 * A repository as Vercel checks out a pull request branch: `master` holds a Steward-only commit
 * the branch does not have, the branch holds `branchFile`, and the branch then merges `master`
 * in. HEAD is that merge, with the branch as its first parent.
 */
function branchWithMasterMergedIn(branchFile) {
  const dir = mkdtempSync(join(tmpdir(), 'route-merge-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const commit = (file, message) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `${message}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('checkout', '-q', '-b', 'branch');
  commit(branchFile, 'the branch change');
  git('checkout', '-q', 'master');
  commit('agents/steward/src/lib/a-steward-file.ts', 'a steward change on master');
  git('checkout', '-q', 'branch');
  git('merge', '-q', '--no-edit', 'master');
  // The scripts fetch from `origin`; the repository is its own.
  git('remote', 'add', 'origin', dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const name of ['route-changes.sh', 'vercel-ignore.sh']) {
    writeFileSync(join(dir, 'scripts', name), readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url))));
  }
  return { dir, base: git('merge-base', 'HEAD', 'master') };
}

function routeIn(dir, args) {
  const output = join(dir, '.routing');
  execFileSync('bash', [script, ...args], {
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

/** The exit code of vercel-ignore.sh in `dir`: 0 skips the build, 1 builds. */
function ignoreExit(dir) {
  try {
    execFileSync('bash', [ignoreScript], { cwd: dir, env: { ...process.env, VERCEL_ENV: 'preview' }, stdio: 'ignore' });
    return 0;
  } catch (err) {
    return err.status;
  }
}

test('a branch that merged master in is diffed from the merge base when the caller asks', () => {
  const { dir, base } = branchWithMasterMergedIn('src/pages/a-page.astro');
  // Without the third argument the merge-commit rule applies, as on a pull request in Actions,
  // where the first parent is master. Here the first parent is the branch, so only master's
  // Steward file is listed. This is the case the third argument exists for.
  assert.equal(routeIn(dir, ['pull_request', base]).site, 'false');
  assert.equal(routeIn(dir, ['pull_request', base, 'base']).site, 'true');
});

test('Vercel builds a preview for a site change on a branch that merged master in', () => {
  const { dir } = branchWithMasterMergedIn('src/pages/a-page.astro');
  assert.equal(ignoreExit(dir), 1);
});

test('Vercel skips a preview for a Steward-only branch that merged master in', () => {
  const { dir } = branchWithMasterMergedIn('agents/steward/src/lib/another-steward-file.ts');
  assert.equal(ignoreExit(dir), 0);
});
