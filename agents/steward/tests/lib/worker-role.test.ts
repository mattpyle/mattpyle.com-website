import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUE_AUDIT, QUEUE_AUDIT_FAST, QUEUE_FINDINGS } from '../../src/config.js';
import { hostedRegistry, publicRegistry } from '../../src/hosted-registry.js';
import {
  PUBLIC_ROLE_ALLOWED_CREDENTIALS,
  PUBLIC_ROLE_REFUSED_CREDENTIALS,
  assertPublicRoleEnvironment,
  parseWorkerRole,
} from '../../src/worker-role.js';

/**
 * STW-610: the public-audit role. Like the registry test, nothing here connects
 * to Temporal or needs a credential: the entry point cannot be imported, so the
 * role is a pure module and a registry, and these tests hold both.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

test('unset, empty and "default" are the default role; "public" is public', () => {
  assert.equal(parseWorkerRole({}), 'default');
  assert.equal(parseWorkerRole({ STEWARD_WORKER_ROLE: '' }), 'default');
  assert.equal(parseWorkerRole({ STEWARD_WORKER_ROLE: 'default' }), 'default');
  assert.equal(parseWorkerRole({ STEWARD_WORKER_ROLE: 'public' }), 'public');
});

test('an unknown role throws rather than falling back to the credentialed one', () => {
  assert.throws(() => parseWorkerRole({ STEWARD_WORKER_ROLE: 'publc' }), /must be "public" or "default"/);
  assert.throws(() => parseWorkerRole({ STEWARD_WORKER_ROLE: 'PUBLIC' }), /must be "public" or "default"/);
});

test('the public registry serves the two audit queues and nothing else', () => {
  const entries = publicRegistry();
  assert.deepEqual(entries.map((e) => e.taskQueue), [QUEUE_AUDIT, QUEUE_AUDIT_FAST]);
  assert.ok(!entries.some((e) => e.taskQueue === QUEUE_FINDINGS));
  assert.deepEqual(
    Object.keys(entries[0].activities).sort(),
    ['assembleDeepAudit', 'auditRenderedPage', 'auditSiteFast', 'auditSiteFetchChecks'],
  );
  assert.deepEqual(Object.keys(entries[1].activities), ['auditSiteFast']);
  assert.deepEqual(entries.map((e) => e.carriesWorkflows), [true, false]);
});

test('the public registry keeps the default role\'s caps, and the default registry is unchanged', () => {
  const caps = (list: readonly { taskQueue: string; maxConcurrentActivityTaskExecutions: number }[]) =>
    Object.fromEntries(list.map((e) => [e.taskQueue, e.maxConcurrentActivityTaskExecutions]));
  const hosted = caps(hostedRegistry());
  const pub = caps(publicRegistry());
  assert.equal(pub[QUEUE_AUDIT], hosted[QUEUE_AUDIT]);
  assert.equal(pub[QUEUE_AUDIT_FAST], hosted[QUEUE_AUDIT_FAST]);
  assert.equal(hostedRegistry().length, 3);
});

test('every public-role activity is also in the default role\'s audit map', () => {
  const full = Object.keys(hostedRegistry()[0].activities);
  for (const name of Object.keys(publicRegistry()[0].activities)) assert.ok(full.includes(name), name);
});

test('the public role refuses a GitHub credential and names the variable, never the value', () => {
  const secret = ['not', 'a', 'real', 'value'].join('-');
  for (const name of ['STEWARD_GITHUB_APP_ID', 'STEWARD_GITHUB_APP_PRIVATE_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    assert.throws(
      () => assertPublicRoleEnvironment({ [name]: secret }),
      (err: Error) => err.message.includes(name) && !err.message.includes(secret),
      name,
    );
  }
});

test('the public role starts with only the variables it needs, and a blank counts as unset', () => {
  assert.doesNotThrow(() =>
    assertPublicRoleEnvironment({
      TEMPORAL_ADDRESS: 'x:7233',
      TEMPORAL_NAMESPACE: 'audit',
      TEMPORAL_API_KEY: 'k',
      STEWARD_WEB_BOT_AUTH_KEY: 'k',
      STEWARD_METRICS_OTLP_URL: 'u',
      STEWARD_METRICS_OTLP_USER: 'u',
      STEWARD_METRICS_OTLP_TOKEN: 't',
      STEWARD_HEALTHCHECK_BASE: 'https://example.com/ping',
      GITHUB_TOKEN: '',
    }),
  );
});

test('the refused and allowed sets do not overlap', () => {
  for (const name of PUBLIC_ROLE_REFUSED_CREDENTIALS) assert.ok(!PUBLIC_ROLE_ALLOWED_CREDENTIALS.includes(name), name);
});

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('every credential-shaped variable name in src/ is in the allowed set or the refused set', async () => {
  const known = new Set([...PUBLIC_ROLE_ALLOWED_CREDENTIALS, ...PUBLIC_ROLE_REFUSED_CREDENTIALS]);
  const shape = /['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g;
  const credentialWord = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?|_APP_ID|_INSTALLATION_ID)$/;
  const unclassified = new Map<string, string>();
  for (const file of await sourceFiles(SRC)) {
    const text = await fs.readFile(file, 'utf8');
    for (const match of text.matchAll(shape)) {
      const name = match[1];
      if (credentialWord.test(name) && !known.has(name)) unclassified.set(name, path.relative(SRC, file));
    }
  }
  assert.deepEqual(
    [...unclassified],
    [],
    'a new credential variable must join PUBLIC_ROLE_ALLOWED_CREDENTIALS (the public role needs it) or ' +
      'PUBLIC_ROLE_REFUSED_CREDENTIALS (the public role must not hold it) in src/worker-role.ts',
  );
});
