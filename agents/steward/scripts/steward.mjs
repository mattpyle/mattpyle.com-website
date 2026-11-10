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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  INSTALLED_BY_SHIM_ENV,
  installFailureMessage,
  launchPlan,
  nextShimStep,
} from './shim-decision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = path.join(packageRoot, 'src', 'cli.ts');
const envFile = path.join(packageRoot, '.env');

// `op` as an absolute path, or null. Only `.exe` and `.com` count on Windows,
// because spawn without a shell cannot start a `.cmd`.
function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// The shim reads .env for reference lines only (`KEY=op://...`). For each one whose
// key the shell has not set, it adds the reference string to the child's environment
// and runs the CLI under `op run --`, which resolves references in environment
// variables. A shell value wins over the file, as in loadDotEnv, so no `--env-file`.
// Plain values stay with loadDotEnv. The shim keeps key names and reference strings only.
function readEnvFile() {
  try {
    return fs.readFileSync(envFile, 'utf8');
  } catch {
    return null;
  }
}
const plan = launchPlan({
  envFileText: readEnvFile(),
  opPath: findOnPath('op'),
  env: process.env,
});
if (plan.kind === 'error') {
  console.error(`
  steward: ${plan.message}
`);
  process.exit(1);
}

// `npm ci` runs here, never inside the CLI. tsx keeps `esbuild.exe` from
// node_modules running as its child, and `npm ci` deletes node_modules first, so
// a reinstall from inside the CLI fails with EPERM on that file and leaves the
// install half removed. This process runs under plain node and loads no esbuild.
// The CLI exits with REINSTALL_EXIT_CODE when it needs a reinstall; the shim
// installs, then re-runs it with the original arguments.
function npmCommand(args) {
  if (process.platform !== 'win32') return { binary: 'npm', args };
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { binary: process.execPath, args: [npmCli, ...args] };
}

function runCli(env) {
  return new Promise((resolve) => {
    const cliCommand = [process.execPath, tsxCli, cliEntry, ...process.argv.slice(2)];
    const [binary, ...args] =
      plan.kind === 'wrap'
        ? [findOnPath('op'), 'run', '--', ...cliCommand]
        : cliCommand;
    const child = spawn(binary, args, {
      cwd: packageRoot,
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
      env,
    });
    child.on('error', (err) => {
      console.error(err);
      resolve({ code: 1, signal: null });
    });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function runNpmCi() {
  const { binary, args } = npmCommand(['ci']);
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd: repoRoot, stdio: 'inherit', windowsHide: true, shell: false });
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let installedByShim = false;
for (;;) {
  const base = installedByShim ? { ...process.env, [INSTALLED_BY_SHIM_ENV]: '1' } : process.env;
  const env = plan.kind === 'wrap' ? { ...base, ...plan.inject } : base;
  const { code, signal } = await runCli(env);
  if (signal) process.kill(process.pid, signal);
  if (nextShimStep({ exitCode: code, installedByShim }) === 'exit') {
    process.exitCode = code ?? 1;
    break;
  }
  console.log('\n  steward: installing dependencies with npm ci\n');
  const npmCode = await runNpmCi();
  if (npmCode !== 0) {
    console.error(`\n  ${installFailureMessage(npmCode)}\n`);
    process.exitCode = 1;
    break;
  }
  installedByShim = true;
}
