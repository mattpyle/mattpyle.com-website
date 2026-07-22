#!/usr/bin/env node
// The `steward` CLI shim (package.json `bin`), letting `steward <verb>` run
// from any directory after `npm link`. Not in `bin/` — that whole directory
// is gitignored (it's where `setup-vale.mjs` drops the downloaded Vale
// binary), and this file must be committed to be reproducible.
//
// Resolves paths from THIS FILE's own location, never `process.cwd()` — the
// whole point is running from outside `agents/steward`. Spawns tsx's own JS
// entrypoint directly rather than `tsx.cmd`: `spawn('tsx.cmd', …, { shell:
// false })` is a Windows EINVAL trap (the CVE-2024-27980 fix made `shell:
// true` the only way to reach `.cmd` shims, and this project never sets
// `shell: true`). Same fix as `src/lib/proc.ts`'s `tsxCommand` — duplicated
// rather than imported, because this shim runs under plain `node`, before
// tsx (or any TS loader) exists in the process.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = path.join(packageRoot, 'src', 'cli.ts');

const child = spawn(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  cwd: packageRoot,
  stdio: 'inherit',
  windowsHide: true,
  shell: false,
});

child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
