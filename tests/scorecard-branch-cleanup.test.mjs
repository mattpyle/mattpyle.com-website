import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The workflow that deletes a closed scorecard PR's head branch. It is a
// YAML file, so the checks read its text: the job guard that keeps it off
// merged PRs, forks and every other branch, and the step script, which runs
// here under bash against a stub `gh` that records its arguments.

const source = readFileSync(
  fileURLToPath(new URL('../.github/workflows/scorecard-branch-cleanup.yml', import.meta.url)),
  'utf8',
);

function stepScript() {
  const marker = source.indexOf('        run: |\n');
  assert.ok(marker > -1, 'the workflow must have a run block');
  return source
    .slice(marker + '        run: |\n'.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

const posix = (p) => p.split(sep).join('/');

const bash = spawnSync('bash', ['-c', 'exit 0']);
const hasBash = bash.status === 0;

function runStep(headRef, ghBehaviour) {
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-cleanup-'));
  try {
    const log = posix(join(dir, 'gh.log'));
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/bash\necho "$@" >> "${log}"\n${ghBehaviour}\n`,
    );
    chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(join(dir, 'step.sh'), stepScript());
    const result = spawnSync('bash', [posix(join(dir, 'step.sh'))], {
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        REPO: 'owner/repo',
        HEAD_REF: headRef,
      },
      encoding: 'utf8',
    });
    let calls = '';
    try {
      calls = readFileSync(join(dir, 'gh.log'), 'utf8');
    } catch {}
    return { status: result.status, calls, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the job runs only for an unmerged PR from this repository on a steward/scorecard- branch', () => {
  assert.match(source, /types: \[closed\]/);
  assert.match(source, /github\.event\.pull_request\.merged == false/);
  assert.match(source, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(source, /startsWith\(github\.event\.pull_request\.head\.ref, 'steward\/scorecard-'\)/);
});

test('the head ref reaches the script through the environment, not interpolation', () => {
  const script = stepScript();
  assert.doesNotMatch(script, /\$\{\{/);
  assert.match(source, /HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
});

test('the token is scoped to contents: write', () => {
  assert.match(source, /^permissions:\n {2}contents: write\n/m);
});

test(
  'a dated scorecard branch is deleted through the git refs API',
  { skip: !hasBash && 'bash is not available' },
  () => {
    const r = runStep('steward/scorecard-2026-10-09', 'exit 0');
    assert.equal(r.status, 0);
    assert.equal(r.calls.trim(), 'api -X DELETE repos/owner/repo/git/refs/heads/steward/scorecard-2026-10-09');
  },
);

test(
  'the archive branch and other names are left alone',
  { skip: !hasBash && 'bash is not available' },
  () => {
    for (const ref of ['steward/scorecard-archive', 'steward/scorecard-2026-10-09-2', 'steward/scorecard-x']) {
      const r = runStep(ref, 'exit 0');
      assert.equal(r.status, 0, ref);
      assert.equal(r.calls, '', `${ref} must not reach the API`);
    }
  },
);

test(
  'a branch that is already gone is not an error',
  { skip: !hasBash && 'bash is not available' },
  () => {
    const r = runStep('steward/scorecard-2026-10-09', 'echo "gh: Reference does not exist (HTTP 422)" >&2; exit 1');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already gone/);
  },
);

test(
  'any other API failure fails the job',
  { skip: !hasBash && 'bash is not available' },
  () => {
    const r = runStep('steward/scorecard-2026-10-09', 'echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /403/);
  },
);
