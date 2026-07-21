import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Connection } from '@temporalio/client';
import { REPO_ROOT, TEMPORAL_ADDRESS, WEB_UI } from '../config.js';
import { killTree } from './proc.js';

const execFileAsync = promisify(execFile);

/** The one live database (README, "Runbook"). Always resolved from REPO_ROOT. */
export const DB_PATH = path.join(REPO_ROOT, 'agents', 'steward', '.cache', 'temporal-dev.db');

interface OrphanProcess {
  processId: number;
  commandLine: string;
}

interface BoundPort {
  localPort: number;
  owningProcess: number;
}

interface OrphanScan {
  workers: OrphanProcess[];
  servers: OrphanProcess[];
  ports: BoundPort[];
}

/**
 * Operational rule 0 (README): a worker or server left running from an earlier
 * session competes for the same queue/port rather than failing loudly. One
 * PowerShell call checks all three signs at once — a stray `worker.ts` process,
 * a stray `temporal.exe`, and a bound 7233/8233 — because any one of them means
 * `up` would start a second, competing process rather than the first.
 */
async function scanForOrphans(): Promise<OrphanScan> {
  const script = `
    $workers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*worker.ts*' } |
      Select-Object @{N='processId';E={$_.ProcessId}}, @{N='commandLine';E={$_.CommandLine}}
    $servers = Get-CimInstance Win32_Process -Filter "Name='temporal.exe'" |
      Select-Object @{N='processId';E={$_.ProcessId}}, @{N='commandLine';E={$_.CommandLine}}
    $ports = Get-NetTCPConnection -LocalPort 7233,8233 -ErrorAction SilentlyContinue |
      Select-Object @{N='localPort';E={$_.LocalPort}}, @{N='owningProcess';E={$_.OwningProcess}}
    @{ workers = @($workers); servers = @($servers); ports = @($ports) } | ConvertTo-Json -Depth 4 -Compress
  `;
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim() || '{}');
  return {
    workers: parsed.workers ?? [],
    servers: parsed.servers ?? [],
    ports: parsed.ports ?? [],
  };
}

/**
 * Refuses to start a second stack on top of a stray one (README rule 0). Prints
 * the offending processes and the exact `taskkill` command rather than killing
 * anything itself — a bare kill here would take down a stack someone else is
 * using without them ever seeing why.
 */
export async function refuseIfOrphaned(): Promise<void> {
  const scan = await scanForOrphans();
  const pids = new Set<number>();
  for (const w of scan.workers) pids.add(w.processId);
  for (const s of scan.servers) pids.add(s.processId);
  for (const p of scan.ports) pids.add(p.owningProcess);

  if (pids.size === 0) return;

  console.error('\n  Refusing to start: found a stack already running.\n');
  for (const w of scan.workers) {
    console.error(`    worker   pid ${w.processId}  ${w.commandLine}`);
  }
  for (const s of scan.servers) {
    console.error(`    server   pid ${s.processId}  ${s.commandLine}`);
  }
  for (const p of scan.ports) {
    console.error(`    port ${p.localPort} bound by pid ${p.owningProcess}`);
  }
  console.error('\n  If this is a stale leftover, clear it first:');
  for (const pid of pids) {
    console.error(`    taskkill /PID ${pid} /T /F`);
  }
  console.error('\n  Or run `steward down` to do the same thing for you.\n');
  process.exit(1);
}

/** Best-effort teardown of anything matching the orphan signature. Used by `steward down`. */
export async function killOrphans(): Promise<number> {
  const scan = await scanForOrphans();
  const pids = new Set<number>();
  for (const w of scan.workers) pids.add(w.processId);
  for (const s of scan.servers) pids.add(s.processId);
  for (const p of scan.ports) pids.add(p.owningProcess);
  for (const pid of pids) killTree(pid);
  return pids.size;
}

/** tsx's own JS entrypoint under the current Node binary — see build-audit.ts's `npmCommand` for
 * why `spawn('tsx.cmd', …, { shell: false })` is a trap (EINVAL, CVE-2024-27980 fix). Same fix
 * here: skip the `.cmd` shim entirely. */
function tsxCommand(scriptRelPath: string): { binary: string; args: string[] } {
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return { binary: process.execPath, args: [tsxCli, scriptRelPath] };
}

function prefixLines(prefix: string, chunk: Buffer, sink: (line: string) => void): void {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim()) sink(`  [${prefix}] ${line}`);
  }
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // `Connection.connect` (unlike `Connection.lazy`) verifies connectivity
      // itself via `getSystemInfo` — no need to make the RPC call again here.
      const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
      await connection.close();
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`Temporal server never became reachable at ${TEMPORAL_ADDRESS}: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function waitForWorker(worker: ChildProcess, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Worker did not report "steward worker polling" within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes('steward worker polling')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Worker exited before registering (code ${code})`));
    };
    function cleanup() {
      clearTimeout(timer);
      worker.stdout?.off('data', onData);
      worker.off('exit', onExit);
    }
    worker.stdout?.on('data', onData);
    worker.once('exit', onExit);
  });
}

export interface RunningStack {
  server: ChildProcess;
  worker: ChildProcess;
  dbPath: string;
  dbExisted: boolean;
}

/**
 * Starts the Temporal dev server and the worker together, and does not resolve
 * until the server is reachable AND the worker has registered on both queues —
 * a ready banner that lies is worse than none.
 */
export async function startStack(): Promise<RunningStack> {
  await refuseIfOrphaned();

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const dbExisted = fs.existsSync(DB_PATH);

  console.log(`\n  starting temporal server  →  ${DB_PATH}${dbExisted ? ' (existing)' : ' (new)'}`);
  const server = spawn('temporal', ['server', 'start-dev', '--db-filename', DB_PATH], {
    cwd: REPO_ROOT,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (c: Buffer) => prefixLines('server', c, console.log));
  server.stderr?.on('data', (c: Buffer) => prefixLines('server', c, console.error));
  const serverExitedEarly = new Promise<never>((_, reject) => {
    server.once('exit', (code) => reject(new Error(`temporal server exited early (code ${code})`)));
  });

  try {
    await Promise.race([waitForServer(), serverExitedEarly]);
  } catch (err) {
    killTree(server.pid);
    throw err;
  }
  console.log(`  server reachable at ${TEMPORAL_ADDRESS}`);

  const { binary, args } = tsxCommand('src/worker.ts');
  const stewardDir = path.join(REPO_ROOT, 'agents', 'steward');
  console.log('  starting worker (queues: steward-light, steward-heavy)');
  const worker = spawn(binary, args, {
    cwd: stewardDir,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  worker.stdout?.on('data', (c: Buffer) => prefixLines('worker', c, console.log));
  worker.stderr?.on('data', (c: Buffer) => prefixLines('worker', c, console.error));

  try {
    await waitForWorker(worker);
  } catch (err) {
    killTree(server.pid);
    killTree(worker.pid);
    throw err;
  }

  return { server, worker, dbPath: DB_PATH, dbExisted };
}

export function printReadyBanner(stack: RunningStack): void {
  console.log('');
  console.log('  ── steward up: ready ──────────────────────────────────────────');
  console.log(`  db      ${stack.dbPath}${stack.dbExisted ? '  (existing history)' : '  (created — empty history)'}`);
  console.log(`  ui      ${WEB_UI}`);
  console.log('  stop    Ctrl+C  (tears down server + worker), or `steward down` from another terminal');
  console.log('  ───────────────────────────────────────────────────────────────\n');
}

export function teardownStack(stack: RunningStack): void {
  console.log('\n  tearing down worker + server…');
  killTree(stack.worker.pid);
  killTree(stack.server.pid);
}
