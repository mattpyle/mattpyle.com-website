import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCORD_ROLE_REFUSED, DISCORD_ROLE_REQUIRED, readDiscordRoleEnvironment } from '../../src/discord/role-env.js';
import { parseWorkerRole } from '../../src/worker-role.js';
import { hostedRegistry, publicRegistry } from '../../src/hosted-registry.js';
import { testApplication } from './support.js';

/**
 * The Discord role's start: what its environment must hold and must not, a
 * GitHub credential included, and the two entry points run as processes with a
 * broken environment.
 */

const STEWARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A complete environment. The values are made here, at run time. */
function complete(): Record<string, string> {
  const stand = ['stand', 'in', 'value'].join('-');
  return {
    STEWARD_DISCORD_PUBLIC_KEY: testApplication().publicKeyHex,
    STEWARD_DISCORD_OWNER_ID: '100000000000000001',
    TEMPORAL_ADDRESS: 'findings.example.tmprl.cloud:7233',
    TEMPORAL_NAMESPACE: 'findings.example',
    TEMPORAL_API_KEY: stand,
  };
}

test('a complete environment starts, on PORT or 8080', () => {
  const env = complete();
  assert.deepEqual(readDiscordRoleEnvironment(env), { publicKey: env.STEWARD_DISCORD_PUBLIC_KEY, ownerId: '100000000000000001', port: 8080 });
  assert.equal(readDiscordRoleEnvironment({ ...env, PORT: '3000' }).port, 3000);
  // A blank refused variable counts as unset.
  assert.doesNotThrow(() => readDiscordRoleEnvironment({ ...env, GITHUB_TOKEN: '' }));
});

test('the role refuses to start without each value it needs, naming the variable', () => {
  assert.deepEqual([...DISCORD_ROLE_REQUIRED].sort(), Object.keys(complete()).sort());
  for (const name of DISCORD_ROLE_REQUIRED) {
    const env = complete();
    delete env[name];
    assert.throws(() => readDiscordRoleEnvironment(env), (err: Error) => /refuses to start/.test(err.message) && err.message.includes(name), name);
    assert.throws(() => readDiscordRoleEnvironment({ ...complete(), [name]: '  ' }), new RegExp(name), `${name} blank`);
  }
  assert.throws(() => readDiscordRoleEnvironment({}), (err: Error) => DISCORD_ROLE_REQUIRED.every((name) => err.message.includes(name)));
});

test('the role refuses to start beside a credential it has no use for, and never prints the value', () => {
  const secret = ['not', 'a', 'real', 'value'].join('-');
  for (const name of DISCORD_ROLE_REFUSED) {
    assert.throws(
      () => readDiscordRoleEnvironment({ ...complete(), [name]: secret }),
      (err: Error) => err.message.includes(name) && !err.message.includes(secret),
      name,
    );
  }
  // No GitHub credential of any kind: the hosted worker reads the findings repository for it.
  for (const name of ['STEWARD_GITHUB_APP_ID', 'STEWARD_GITHUB_APP_PRIVATE_KEY', 'STEWARD_GITHUB_APP_INSTALLATION_ID', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    assert.ok(DISCORD_ROLE_REFUSED.includes(name), name);
    assert.ok(!DISCORD_ROLE_REQUIRED.includes(name), name);
  }
  for (const name of ['STEWARD_DISCORD_BOT_TOKEN', 'ANTHROPIC_API_KEY']) assert.ok(DISCORD_ROLE_REFUSED.includes(name), name);
});

test('a malformed public key, owner id or port stops the start without echoing the value', () => {
  const wrong = ['zz', 'not', 'hex'].join('-');
  assert.throws(() => readDiscordRoleEnvironment({ ...complete(), STEWARD_DISCORD_PUBLIC_KEY: wrong }), (err: Error) =>
    err.message.includes('STEWARD_DISCORD_PUBLIC_KEY') && !err.message.includes(wrong),
  );
  assert.throws(() => readDiscordRoleEnvironment({ ...complete(), STEWARD_DISCORD_OWNER_ID: 'matt' }), /STEWARD_DISCORD_OWNER_ID/);
  assert.throws(() => readDiscordRoleEnvironment({ ...complete(), PORT: 'http' }), /PORT/);
});

test('"discord" is a role; a misspelling is still refused', () => {
  assert.equal(parseWorkerRole({ STEWARD_WORKER_ROLE: 'discord' }), 'discord');
  assert.throws(() => parseWorkerRole({ STEWARD_WORKER_ROLE: 'Discord' }), /must be "public", "discord" or "default"/);
});

test('the Discord role adds no queue: the two worker registries are as they were', () => {
  assert.equal(hostedRegistry().length, 3);
  assert.equal(publicRegistry().length, 2);
});

// ---------------------------------------------------------------------------
// The entry points, as processes
// ---------------------------------------------------------------------------

function start(script: string, env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', script)], {
      cwd: STEWARD,
      // The parent's environment, which the credential guard has blanked, plus the case's own.
      env: { ...process.env, STEWARD_LOG_LEVEL: 'info', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('the hosted entry with the Discord role and nothing else set exits 1, naming what is missing', { timeout: 50_000 }, async () => {
  const { code, output } = await start('hosted-entry.ts', { STEWARD_WORKER_ROLE: 'discord', PORT: '0' });
  assert.equal(code, 1);
  assert.match(output, /discord service exited/);
  assert.match(output, /STEWARD_WORKER_ROLE=discord refuses to start: .*STEWARD_DISCORD_PUBLIC_KEY, STEWARD_DISCORD_OWNER_ID/);
  assert.doesNotMatch(output, /steward worker polling|steward discord service listening/);
});

test('the hosted entry with the Discord role refuses to start beside a GitHub credential', { timeout: 50_000 }, async () => {
  const stand = ['stand', 'in', 'value'].join('-');
  const { code, output } = await start('hosted-entry.ts', { ...complete(), STEWARD_WORKER_ROLE: 'discord', PORT: '0', STEWARD_GITHUB_APP_ID: stand });
  assert.equal(code, 1);
  assert.match(output, /refuses to start: STEWARD_GITHUB_APP_ID is set/);
  assert.ok(!output.includes(stand));
});

test('the hosted entry refuses a role it does not know before loading either entry', { timeout: 50_000 }, async () => {
  const { code, output } = await start('hosted-entry.ts', { STEWARD_WORKER_ROLE: 'discrod' });
  assert.notEqual(code, 0);
  assert.match(output, /must be "public", "discord" or "default"/);
  assert.doesNotMatch(output, /hosted worker exited|discord service exited/);
});

test('the worker entry started directly with the Discord role refuses, and does not become the credentialed worker', { timeout: 50_000 }, async () => {
  const { code, output } = await start('worker-hosted.ts', { STEWARD_WORKER_ROLE: 'discord' });
  assert.equal(code, 1);
  assert.match(output, /STEWARD_WORKER_ROLE=discord is not a worker/);
  assert.doesNotMatch(output, /steward worker polling/);
});
