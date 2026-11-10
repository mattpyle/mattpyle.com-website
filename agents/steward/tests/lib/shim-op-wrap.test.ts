import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The `steward` launcher under `op run`, end to end, with a STAND-IN for `op`.
 *
 * What this exercises: the real `scripts/steward.mjs` and `shim-decision.mjs`, copied into
 * a scratch tree with a stub CLI, read that tree's `.env`, find `op` on PATH, run the
 * stub CLI as `op run --env-file <file> -- <node> <tsx> <cli> <args>`, pass the exit code
 * through, and print a clear message when `op` is missing.
 *
 * What it does NOT exercise: the real 1Password CLI. The stand-in is node itself, renamed
 * `op` (or a shell script off Windows), that resolves the one dummy reference from a
 * table. Real `op` approval prompts, masking, Ctrl+C and TTY handling stay unproven here;
 * those are the live proof after the merge.
 *
 * The reference text and its value are built at run time (gitleaks scans full history).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.resolve(here, '..', '..', 'scripts');
const win = process.platform === 'win32';
const REF = ['op:', '', 'Steward', 'DUMMY', 'credential'].join('/');
const VALUE = `dummy-${Math.random().toString(36).slice(2)}`;

function scratchTree(envText: string | null, withOp: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-shim-'));
  const pkg = path.join(root, 'agents', 'steward');
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'tsx', 'dist'), { recursive: true });
  for (const f of ['steward.mjs', 'shim-decision.mjs']) fs.copyFileSync(path.join(scripts, f), path.join(pkg, 'scripts', f));
  // The stub "tsx" runs the stub CLI; the stub CLI reports what it received.
  fs.writeFileSync(
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    "await import(new URL('file:///' + process.argv[2].replace(/\\\\/g, '/')).href);\n",
  );
  fs.writeFileSync(
    path.join(pkg, 'src', 'cli.ts'),
    [
      "console.log('cli-args=' + JSON.stringify(process.argv.slice(3)));",
      "console.log('cli-dummy=' + (process.env.DUMMY_SECRET ?? 'unset'));",
      "process.exit(Number(process.env.DUMMY_EXIT ?? 0));",
    ].join('\n'),
  );
  if (envText !== null) fs.writeFileSync(path.join(pkg, '.env'), envText);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  if (withOp) {
    const resolver = path.join(root, 'fake-op.cjs');
    fs.writeFileSync(
      resolver,
      [
        "if (require('node:path').basename(process.execPath).toLowerCase().replace('.exe', '') !== 'op') return;",
        "const { spawnSync } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(1);",
        "const file = argv[argv.indexOf('--env-file') + 1];",
        "const cmd = argv.slice(argv.indexOf('--') + 1);",
        "const env = { ...process.env };",
        "delete env.NODE_OPTIONS;",
        "for (const line of fs.readFileSync(file, 'utf8').split(/\\r?\\n/)) {",
        "  const i = line.indexOf('=');",
        "  if (i > 0 && line.slice(i + 1).startsWith(process.env.FAKE_OP_REF)) env[line.slice(0, i)] = process.env.FAKE_OP_VALUE;",
        "}",
        "fs.writeFileSync(process.env.FAKE_OP_LOG, JSON.stringify(argv.slice(0, argv.indexOf('--') + 1)));",
        "const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env });",
        "process.exit(r.status ?? 1);",
      ].join('\n'),
    );
    if (win) {
      // node.exe renamed op.exe; NODE_OPTIONS preloads the resolver, which exits before node reads "run" as a script.
      fs.copyFileSync(process.execPath, path.join(bin, 'op.exe'));
    } else {
      fs.writeFileSync(path.join(bin, 'op'), `#!/bin/sh\nexec "${process.execPath}" "${resolver}" "$@"\n`, { mode: 0o755 });
    }
  }
  return { hasOp: withOp, root, pkg, bin, resolver: path.join(root, 'fake-op.cjs') };
}

function runShim(tree: ReturnType<typeof scratchTree>, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const log = path.join(tree.root, 'op-args.json');
  const nodeDir = path.dirname(process.execPath);
  const result = spawnSync(process.execPath, [path.join(tree.pkg, 'scripts', 'steward.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // The scratch bin first; node's own directory last, so a stray real `op` cannot win.
      PATH: [tree.bin, nodeDir].join(path.delimiter),
      FAKE_OP_REF: 'op://',
      FAKE_OP_VALUE: VALUE,
      FAKE_OP_LOG: log,
      ...(win && tree.hasOp ? { NODE_OPTIONS: `--require ${tree.resolver.replace(/\\/g, '/')}` } : {}),
      ...extra,
    },
  });
  return { ...result, opArgs: fs.existsSync(log) ? (JSON.parse(fs.readFileSync(log, 'utf8')) as string[]) : null };
}

test('references present and op on PATH: the CLI runs under op run with the resolved value', () => {
  const tree = scratchTree(`DUMMY_SECRET=${REF}\n`, true);
  try {
    const r = runShim(tree, ['inbox', '--flag']);
    assert.equal(r.status, 0, r.stderr);
    // node resolves the first operand of the renamed binary to a path; its basename is op's `run`.
    assert.deepEqual(r.opArgs?.map((a, i) => (i === 0 ? path.basename(a) : a)), ['run', '--env-file', path.join(tree.pkg, '.env'), '--']);
    assert.match(r.stdout, /cli-args=\["inbox","--flag"\]/);
    assert.ok(r.stdout.includes(`cli-dummy=${VALUE}`), 'the CLI saw the resolved value');
    assert.ok(!r.stdout.includes(REF));
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('the exit code of the wrapped CLI passes through', () => {
  const tree = scratchTree(`DUMMY_SECRET=${REF}\n`, true);
  try {
    assert.equal(runShim(tree, ['x'], { DUMMY_EXIT: '3' }).status, 3);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('a file of plain values runs without op, even when op is absent', () => {
  const tree = scratchTree('DUMMY_SECRET=plain-value\n', false);
  try {
    const r = runShim(tree, ['inbox']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.opArgs, null);
    assert.match(r.stdout, /cli-dummy=unset/, 'the shim did not load the file; the CLI does that');
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('no .env file runs plain', () => {
  const tree = scratchTree(null, false);
  try {
    assert.equal(runShim(tree, ['inbox']).status, 0);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('references present and op missing: a clear message and exit 1, not a spawn error', () => {
  const tree = scratchTree(`DUMMY_SECRET=${REF}\n`, false);
  try {
    const r = runShim(tree, ['inbox']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1Password CLI \(`op`\) is not on PATH/);
    assert.ok(!/ENOENT|spawn/.test(r.stderr));
    assert.ok(!r.stdout.includes('cli-args'));
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});
