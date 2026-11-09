import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { run } from './proc.js';
import type {
  OpItem,
  RailwayDeployment,
  RotateDeps,
  RotateState,
  RotateTarget,
  TcldKey,
  TcldListedKey,
} from './credential-rotate.js';

/**
 * The real calls behind `steward credential rotate`. `credential-rotate.ts`
 * decides; this file only reaches out. Nothing here logs a value, and a secret
 * travels to a child process over stdin, never in argv.
 *
 * Child processes run through `run` in `proc.ts`: `execFile`, no shell. On
 * Windows that rules out the npm `.cmd` shim for Railway, so
 * {@link resolveBinary} finds the real `railway.exe` the shim points at.
 */

const RAILWAY_GRAPHQL = 'https://backboard.railway.com/graphql/v2';

/* ------------------------------------------------------------------ */
/* Pure parsers, exported for the tests                                 */
/* ------------------------------------------------------------------ */

/** The first JSON value in a command's output, tolerating text around it. */
export function parseJsonOutput(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('the command printed no JSON');
  const open = text[start];
  const end = text.lastIndexOf(open === '{' ? '}' : ']');
  return JSON.parse(text.slice(start, end + 1));
}

function walk(value: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
  } else if (value && typeof value === 'object') {
    visit(value as Record<string, unknown>);
    for (const v of Object.values(value as Record<string, unknown>)) walk(v, visit);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The key id and token from `tcld apikey create`. Temporal's own forum says a
 * user key answers `id` and a service account key answers `apiKeyId`, and the
 * API docs say `keyId`, so all three are accepted.
 */
export function parseTcldKey(stdout: string): TcldKey {
  const parsed = parseJsonOutput(stdout);
  // The response carries a `requestStatus` object (a request id, a state). It describes the
  // operation, not the key, so nothing inside it may be read as the key id.
  const json = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([k]) => k !== 'requestStatus'))
    : parsed;
  let keyId: string | undefined;
  let token: string | undefined;
  let expires: string | undefined;
  walk(json, (o) => {
    keyId ??= str(o.apiKeyId) ?? str(o.keyId) ?? str(o.id);
    // `secretKey` is what tcld prints today; `token` is the cloudservice spelling.
    token ??= str(o.secretKey) ?? str(o.token) ?? str(o.secret);
    expires ??= str(o.expiryTime) ?? str(o.expiry) ?? str(o.expiresAt);
  });
  if (!keyId || !token) throw new Error('tcld printed no key id and token in the shape this command expects');
  const iso = expires && /^\d{4}-\d{2}-\d{2}/.test(expires) ? expires.slice(0, 10) : undefined;
  return { keyId, token, expires: iso };
}

/** The id of the service account called `name`, from `tcld service-account list`. */
export function findServiceAccountId(stdout: string, name: string): string {
  const json = parseJsonOutput(stdout);
  let found: string | undefined;
  walk(json, (o) => {
    const spec = o.spec && typeof o.spec === 'object' ? (o.spec as Record<string, unknown>) : {};
    if ((str(spec.name) ?? str(o.name)) === name) found ??= str(o.id) ?? str(o.serviceAccountId);
  });
  if (!found) throw new Error(`tcld lists no service account named ${name}. Pass --service-account-id.`);
  return found;
}

/**
 * The arguments and environment for `tcld apikey delete`. tcld's global
 * confirmation switch is spelled `--auto_confirm` in its docs and `--auto-confirm`
 * in Temporal's newer CLI, and it also reads the `AUTO_CONFIRM` environment
 * variable. The variable works under either spelling, so the flag stays out.
 */
export function tcldDeleteInvocation(keyId: string): { args: string[]; env: NodeJS.ProcessEnv } {
  return { args: ['apikey', 'delete', '--id', keyId], env: { AUTO_CONFIRM: 'true' } };
}

/**
 * The request state tcld prints for an asynchronous call such as `apikey delete`:
 * `{"requestStatus": {"requestId", "state": "Pending", "checkDuration": "10s"}}`.
 * Undefined when the output has no such state.
 */
export function parseRequestState(stdout: string): string | undefined {
  try {
    const json = parseJsonOutput(stdout) as { requestStatus?: { state?: unknown } };
    return str(json?.requestStatus?.state);
  } catch {
    return undefined;
  }
}

/** Keys from `tcld apikey list`. */
export function parseTcldKeyList(stdout: string): TcldListedKey[] {
  const json = parseJsonOutput(stdout);
  const keys: TcldListedKey[] = [];
  walk(json, (o) => {
    const id = str(o.id) ?? str(o.keyId);
    if (!id || o.token !== undefined) return;
    const spec = o.spec && typeof o.spec === 'object' ? (o.spec as Record<string, unknown>) : {};
    // A nested `id` inside an owner or a state object is not a key. A key has a spec or a display name.
    if (!o.spec && !str(o.displayName) && !str(o.name)) return;
    const expiry = str(spec.expiryTime) ?? str(o.expiryTime);
    keys.push({
      id,
      name: str(spec.displayName) ?? str(o.displayName) ?? str(o.name),
      expires: expiry?.slice(0, 10),
      disabled: spec.disabled === true ? true : undefined,
      created: str(o.createdTime),
    });
  });
  return keys;
}

export interface RailwayTarget {
  project: string;
  serviceId: string;
  environmentId: string;
}

/** The project, service id and environment id from `railway status --json`. */
export function parseRailwayStatus(stdout: string, service: string, environment: string): RailwayTarget {
  const json = parseJsonOutput(stdout) as Record<string, unknown>;
  const project = str(json.name) ?? '';
  let serviceId: string | undefined;
  let environmentId: string | undefined;
  walk(json, (o) => {
    if (str(o.serviceName) === service) serviceId ??= str(o.serviceId);
    if (str(o.name) === service) serviceId ??= str(o.id);
  });
  walk(json.environments, (o) => {
    if (str(o.name) === environment) environmentId ??= str(o.id);
  });
  if (!serviceId || !environmentId) {
    throw new Error(`railway status lists no ${service} service in ${environment} for project ${project || '(unknown)'}`);
  }
  return { project, serviceId, environmentId };
}

/**
 * Replaces the `KEY=` line of a dotenv file, or appends one, leaving every other
 * byte alone. Line endings follow the file. A value that dotenv would misread
 * (spaces, `#`, quotes) is double-quoted.
 */
export function replaceEnvLine(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (/[\r\n]/.test(value)) throw new Error(`The value for ${key} contains a line break, which a .env line cannot hold.`);
  // loadDotEnv (config.ts) takes everything after the first "=", trims it and strips one pair of
  // outer quotes. It decodes no escapes, so the value goes in raw; quotes are only needed to keep
  // leading or trailing spaces, which the trim would drop.
  const quoted = value !== value.trim() ? `"${value}"` : value;
  const line = `${key}=${quoted}`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'm');
  if (pattern.test(text)) {
    // A function replacer, so a `$` in the value is not read as a group reference.
    return text.replace(pattern, () => line);
  }
  const needsBreak = text !== '' && !text.endsWith('\n');
  return `${text}${needsBreak ? eol : ''}${line}${eol}`;
}

/* ------------------------------------------------------------------ */
/* Binaries                                                             */
/* ------------------------------------------------------------------ */

/**
 * The absolute path of a command, or null. On Windows only `.exe` and `.com`
 * count, because `execFile` without a shell cannot start a `.cmd`. For a tool
 * installed through npm, the real binary sits beside the shim, and `siblings`
 * names where.
 */
export function resolveBinary(name: string, siblings: string[] = []): string | null {
  const win = process.platform === 'win32';
  const exts = win ? ['.exe', '.com'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (win) {
      for (const rel of siblings) {
        if (fs.existsSync(path.join(dir, `${name}.cmd`))) {
          const sibling = path.join(dir, rel);
          if (fs.existsSync(sibling)) return sibling;
        }
      }
    }
  }
  return null;
}

const RAILWAY_SIBLING = path.join('node_modules', '@railway', 'cli', 'bin', 'railway.exe');

/* ------------------------------------------------------------------ */
/* Prompts                                                              */
/* ------------------------------------------------------------------ */

function needTerminal(): void {
  if (!process.stdin.isTTY) throw new Error('This step needs a terminal. Run the command in a terminal tab.');
}

async function promptLine(label: string, fallback = ''): Promise<string> {
  needTerminal();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => rl.question(`  ${label}${fallback ? ` [${fallback}]` : ''}: `, resolve));
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

/** Reads a line with the echo off. Paste works; the characters never reach the screen. */
async function promptSecret(label: string): Promise<string> {
  needTerminal();
  const stdin = process.stdin;
  process.stdout.write(`  ${label} (input is hidden): `);
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(buffer);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return reject(new Error('Cancelled.'));
        }
        if (ch === '\u007f' || ch === '\b') buffer = buffer.slice(0, -1);
        else buffer += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/* ------------------------------------------------------------------ */
/* The real dependencies                                                */
/* ------------------------------------------------------------------ */

export interface RealDepsOptions {
  /**
   * The main checkout: it holds the `.env` file and the Railway link. The env
   * file is `<checkout>/<envFile>`, and the state file sits in a `.cache` folder beside it.
   */
  checkout: string;
  /** The `.env` path relative to the checkout, for example `agents/steward/.env`. */
  envFile: string;
  target: RotateTarget;
  /** The verify functions the credential rows name. */
  verifiers: RotateDeps['verifiers'];
  /** An IANA zone for expiry dates, for example `America/Vancouver`. */
  timeZone: string;
  log(line: string): void;
}

/**
 * The main checkout of the repository `dir` belongs to. A worktree has no
 * `agents/steward/.env` and no Railway link, so a rotation run from one reads
 * both from the main checkout, which git names as the parent of the common dir.
 */
export async function mainCheckout(dir: string): Promise<string> {
  const result = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  const common = result.stdout.trim();
  return result.exitCode === 0 && common ? path.dirname(common) : dir;
}

function railwayToken(): string {
  const file = path.join(os.homedir(), '.railway', 'config.json');
  let token: string | undefined;
  try {
    token = (JSON.parse(fs.readFileSync(file, 'utf8')) as { user?: { token?: string } }).user?.token;
  } catch {
    /* handled below */
  }
  if (!token) throw new Error('No Railway session token in ~/.railway/config.json. Run `railway login`.');
  return token;
}

export function createRealDeps(options: RealDepsOptions): { deps: RotateDeps; secretsToMask: () => string[] } {
  const { target: where } = options;
  const envPath = path.join(options.checkout, ...options.envFile.split('/'));
  const cacheDir = path.join(path.dirname(envPath), '.cache');
  const statePath = (name: string) => path.join(cacheDir, `credential-rotate-${name}.json`);
  const masked: string[] = [];

  const tcldBinary = () => resolveBinary('tcld');
  const need = (bin: string | null, name: string, hint: string): string => {
    if (!bin) throw new Error(`${name} is not on PATH. ${hint}`);
    return bin;
  };
  const opBinary = () => need(resolveBinary('op'), 'op', 'Install the 1Password CLI.');
  const railwayBinary = () => need(resolveBinary('railway', [RAILWAY_SIBLING]), 'railway', 'Install the Railway CLI.');

  async function runChecked(bin: string, args: string[], input?: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await run(bin, args, { input, cwd, env });
    if (result.exitCode !== 0) {
      const name = path.basename(bin).replace(/\.exe$/, '');
      throw new Error(`${name} ${args.slice(0, 2).join(' ')} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    }
    return result.stdout;
  }

  let target: RailwayTarget | null = null;
  const railwayTarget = async (): Promise<RailwayTarget> => {
    if (target) return target;
    const out = await runChecked(railwayBinary(), ['status', '--json'], undefined, options.checkout);
    const parsed = parseRailwayStatus(out, where.railwayService, where.railwayEnvironment);
    if (parsed.project !== where.railwayProject) {
      throw new Error(`The Railway CLI in ${options.checkout} links project ${parsed.project || '(none)'}, not ${where.railwayProject}.`);
    }
    target = parsed;
    return parsed;
  };

  async function graphql<T>(query: string, variables: Record<string, string | number>): Promise<T> {
    const token = railwayToken();
    masked.push(token);
    const res = await fetch(RAILWAY_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: { data?: T; errors?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Railway answered ${res.status} with a body that is not JSON`);
    }
    if (!res.ok || body.errors) throw new Error(`Railway answered ${res.status}: ${JSON.stringify(body.errors ?? '').slice(0, 300)}`);
    return body.data as T;
  }

  const deployments = async (): Promise<RailwayDeployment[]> => {
    const t = await railwayTarget();
    const data = await graphql<{ deployments: { edges: Array<{ node: RailwayDeployment }> } }>(
      `query($s: String!, $e: String!) {
        deployments(first: 8, input: { serviceId: $s, environmentId: $e }) { edges { node { id status createdAt } } }
      }`,
      { s: t.serviceId, e: t.environmentId },
    );
    return data.deployments.edges.map((edge) => edge.node);
  };

  const deps: RotateDeps = {
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: options.log,
    isoDatePlus: (from, days) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
        new Date(from.getTime() + days * 86_400_000),
      ),
    prompt: {
      secret: promptSecret,
      line: promptLine,
      confirm: async (label) => /^y(es)?$/i.test(await promptLine(`${label} (y/N)`, 'n')),
    },
    state: {
      load: async (name) => {
        try {
          return JSON.parse(await fsp.readFile(statePath(name), 'utf8')) as RotateState;
        } catch {
          return null;
        }
      },
      save: async (name, state) => {
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(statePath(name), `${JSON.stringify(state, null, 2)}\n`);
      },
      clear: async (name) => {
        await fsp.rm(statePath(name), { force: true });
      },
    },
    hasTcld: () => tcldBinary() !== null,
    preflight: async () => {
      const problems: string[] = [];
      if (!resolveBinary('op')) problems.push('op (the 1Password CLI) is not on PATH.');
      if (!resolveBinary('railway', [RAILWAY_SIBLING])) problems.push('railway is not on PATH, or its npm package has no railway.exe beside the shim.');
      if (!fs.existsSync(envPath)) {
        problems.push(`${envPath} does not exist. A worktree has none: pass --checkout <the main checkout>.`);
      }
      if (problems.length === 0) {
        try {
          await railwayTarget();
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
        }
      }
      return problems;
    },
    tcld: {
      resolveServiceAccount: async (name) => {
        const bin = need(tcldBinary(), 'tcld', 'Install it, then run `tcld login`.');
        return findServiceAccountId(await runChecked(bin, ['service-account', 'list']), name);
      },
      createKey: async ({ serviceAccountId, name, description, duration }) => {
        const bin = need(tcldBinary(), 'tcld', 'Install it, then run `tcld login`.');
        const out = await runChecked(bin, [
          'apikey', 'create',
          '--name', name,
          '--description', description,
          '--duration', duration,
          '--service-account-id', serviceAccountId,
        ]);
        const key = parseTcldKey(out);
        masked.push(key.token);
        return key;
      },
      listKeys: async (serviceAccountId) => {
        const bin = need(tcldBinary(), 'tcld', 'Install it, then run `tcld login`.');
        return parseTcldKeyList(await runChecked(bin, ['apikey', 'list', '--owner-type', 'service-account', '--owner-id', serviceAccountId]));
      },
      deleteKey: async (keyId) => {
        const bin = need(tcldBinary(), 'tcld', 'Install it, then run `tcld login`.');
        // The command asked Matt already; tcld's own prompt would wait on a closed stdin.
        const call = tcldDeleteInvocation(keyId);
        return parseRequestState(await runChecked(bin, call.args, undefined, undefined, call.env));
      },
    },
    op: {
      readItem: async (item) => {
        const out = await runChecked(opBinary(), ['item', 'get', item, '--vault', where.opVault, '--format', 'json']);
        const parsed = JSON.parse(out) as { fields?: OpItem['fields'] };
        return { fields: (parsed.fields ?? []).map((f) => ({ ...f, label: f.label ?? '' })) };
      },
      editItem: async (item, template) => {
        await runChecked(opBinary(), ['item', 'edit', item, '--vault', where.opVault], JSON.stringify(template));
      },
    },
    railway: {
      latestDeploymentId: async () => {
        const all = await deployments();
        const newest = [...all].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        return newest?.id ?? null;
      },
      setVariable: async (name, value) => {
        await railwayTarget();
        await runChecked(
          railwayBinary(),
          ['variable', 'set', name, '--stdin', '-s', where.railwayService, '-e', where.railwayEnvironment],
          value,
          options.checkout,
        );
      },
      deployments,
      logs: async (deploymentId) => {
        const data = await graphql<{ deploymentLogs: Array<{ message: string; attributes?: Array<{ key: string; value: string }> }> }>(
          `query($d: String!, $n: Int!) { deploymentLogs(deploymentId: $d, limit: $n) { message attributes { key value } } }`,
          { d: deploymentId, n: 500 },
        );
        // The ready line carries its facts as attributes, not in the message text.
        return data.deploymentLogs.map((l) => [l.message, ...(l.attributes ?? []).map((a) => `${a.key}: ${a.value}`)].join(' '));
      },
    },
    env: {
      path: envPath,
      setLine: async (key, value) => {
        const before = await fsp.readFile(envPath, 'utf8');
        const after = replaceEnvLine(before, key, value);
        const temp = `${envPath}.rotate-${process.pid}`;
        await fsp.writeFile(temp, after, { mode: 0o600 });
        await fsp.rename(temp, envPath);
      },
    },
    verifiers: options.verifiers,
  };
  return { deps, secretsToMask: () => masked };
}
