import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findServiceAccountId,
  parseJsonOutput,
  parseRailwayStatus,
  parseTcldKey,
  parseTcldKeyList,
  replaceEnvLine,
  resolveBinary,
} from '../../src/lib/credential-rotate-deps.js';
import { run } from '../../src/lib/proc.js';

/**
 * The parsers and file edits behind `steward credential rotate`, and the one
 * change to `proc.ts` it needs. Fake secrets are built at run time (gitleaks
 * scans full history).
 */

const fresh = () => randomBytes(20).toString('hex');

test('parseTcldKey reads the three id spellings Temporal documents, and the token', () => {
  const token = fresh();
  for (const field of ['keyId', 'apiKeyId', 'id']) {
    const out = `some banner\n${JSON.stringify({ [field]: 'abc123', token })}\n`;
    assert.deepEqual(parseTcldKey(out), { keyId: 'abc123', token, expires: undefined });
  }
});

test('parseTcldKey finds a nested token and keeps an expiry date when tcld prints one', () => {
  const token = fresh();
  const out = JSON.stringify({ apiKey: { id: 'k1', spec: { expiryTime: '2027-02-01T00:00:00Z' } }, token });
  assert.deepEqual(parseTcldKey(out), { keyId: 'k1', token, expires: '2027-02-01' });
});

test('parseTcldKey refuses output with no token, and never echoes the output', () => {
  assert.throws(() => parseTcldKey('{"keyId":"abc"}'), /no key id and token/);
  assert.throws(() => parseTcldKey('login required'), /no JSON/);
});

test('findServiceAccountId matches by name in either list shape', () => {
  const flat = JSON.stringify([{ id: 'sa-1', name: 'other' }, { id: 'sa-2', name: 'steward-metrics' }]);
  assert.equal(findServiceAccountId(flat, 'steward-metrics'), 'sa-2');
  const nested = JSON.stringify({ serviceAccount: [{ id: 'sa-9', spec: { name: 'steward-metrics' } }] });
  assert.equal(findServiceAccountId(nested, 'steward-metrics'), 'sa-9');
  assert.throws(() => findServiceAccountId(flat, 'nobody'), /no service account named nobody/);
});

test('parseTcldKeyList returns keys only, not the objects nested inside them', () => {
  const out = JSON.stringify({
    apiKeys: [
      { id: 'k1', spec: { displayName: 'steward-metrics', expiryTime: '2026-12-01T00:00:00Z', access: { owner: { id: 'sa-2' } } } },
      { id: 'k2', displayName: 'older' },
    ],
  });
  assert.deepEqual(parseTcldKeyList(out), [
    { id: 'k1', name: 'steward-metrics', expires: '2026-12-01' },
    { id: 'k2', name: 'older', expires: undefined },
  ]);
});

test('parseRailwayStatus finds the worker service and the production environment', () => {
  const out = JSON.stringify({
    id: 'p1',
    name: 'mattpyle.com-website',
    environments: {
      edges: [
        {
          node: {
            id: 'env-1',
            name: 'production',
            serviceInstances: { edges: [{ node: { serviceId: 'svc-1', serviceName: 'steward-audit-worker' } }] },
          },
        },
      ],
    },
    services: { edges: [{ node: { id: 'svc-1', name: 'steward-audit-worker' } }] },
  });
  assert.deepEqual(parseRailwayStatus(out, 'steward-audit-worker', 'production'), { project: 'mattpyle.com-website', serviceId: 'svc-1', environmentId: 'env-1' });
  assert.throws(() => parseRailwayStatus(JSON.stringify({ name: 'x', environments: { edges: [] }, services: { edges: [] } }), 'steward-audit-worker', 'production'), /no steward-audit-worker/);
});

test('parseJsonOutput tolerates text before and after the JSON', () => {
  assert.deepEqual(parseJsonOutput('warning\n{"a":1}\nbye'), { a: 1 });
  assert.deepEqual(parseJsonOutput('[1,2]'), [1, 2]);
});

test('replaceEnvLine rewrites exactly one line and leaves every other byte alone', () => {
  const value = fresh();
  const before = ['# comment', 'A=1', 'TEMPORAL_METRICS_API_KEY=old', 'B="two words"', ''].join('\n');
  const after = replaceEnvLine(before, 'TEMPORAL_METRICS_API_KEY', value);
  assert.equal(after, ['# comment', 'A=1', `TEMPORAL_METRICS_API_KEY=${value}`, 'B="two words"', ''].join('\n'));
});

test('replaceEnvLine keeps CRLF line endings, appends a missing variable, and does not touch a longer name', () => {
  const crlf = 'A=1\r\nTEMPORAL_METRICS_API_KEY_OLD=keep\r\n';
  const after = replaceEnvLine(crlf, 'TEMPORAL_METRICS_API_KEY', 'new');
  assert.equal(after, 'A=1\r\nTEMPORAL_METRICS_API_KEY_OLD=keep\r\nTEMPORAL_METRICS_API_KEY=new\r\n');
  assert.equal(replaceEnvLine('A=1', 'B', '2'), 'A=1\nB=2\n');
  assert.equal(replaceEnvLine('', 'B', '2'), 'B=2\n');
});

test('replaceEnvLine quotes a value dotenv would misread, and does not read $ as a group reference', () => {
  assert.equal(replaceEnvLine('K=old\n', 'K', 'a b#c'), 'K="a b#c"\n');
  assert.equal(replaceEnvLine('K=old\n', 'K', 'x$&y'), 'K=x$&y\n');
});

test('resolveBinary finds a command on PATH and returns null for an absent one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-bin-'));
  try {
    const name = `rotate-probe-${process.pid}`;
    const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    fs.writeFileSync(file, '');
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    try {
      assert.equal(resolveBinary(name), file);
      assert.equal(resolveBinary(`${name}-missing`), null);
    } finally {
      process.env.PATH = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBinary follows an npm .cmd shim to the exe beside it (Windows only)', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-shim-'));
  try {
    const real = path.join(dir, 'node_modules', 'pkg', 'bin', 'tool.exe');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '');
    fs.writeFileSync(path.join(dir, 'tool.cmd'), '');
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    try {
      assert.equal(resolveBinary('tool', [path.join('node_modules', 'pkg', 'bin', 'tool.exe')]), real);
      assert.equal(resolveBinary('tool'), null, 'a bare .cmd is not runnable without a shell');
    } finally {
      process.env.PATH = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run writes `input` to the child over stdin and leaves argv without it', async () => {
  const secret = fresh();
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.length+':'+process.argv.length)})";
  const result = await run(process.execPath, ['-e', script], { input: secret });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `${secret.length}:1`);
});

test('run still reports a non-zero exit when the child never reads its input', async () => {
  const result = await run(process.execPath, ['-e', 'process.exit(3)'], { input: fresh() });
  assert.equal(result.exitCode, 3);
});
