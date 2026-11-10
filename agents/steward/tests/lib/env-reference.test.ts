import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { envLineIsReference, isOpReference, unresolvedReferenceRefusal } from '../../src/lib/env-reference.js';
import { createRealDeps } from '../../src/lib/credential-rotate-deps.js';

/**
 * The 1Password reference guard behind `loadDotEnv`, and the rotate command's
 * `.env` skip. The reference text is built at run time and holds no real item
 * name or value (gitleaks scans full history).
 */

const ref = (item: string) => ['op:', '', 'Steward', item, 'credential'].join('/');

test('a clean environment passes the guard', () => {
  assert.equal(unresolvedReferenceRefusal({ PATH: '/bin', TEMPORAL_API_KEY: 'plain-value' }), null);
  assert.equal(unresolvedReferenceRefusal({}), null);
  assert.equal(unresolvedReferenceRefusal({ TEMPORAL_API_KEY: '' }), null);
});

test('a reference in a secret variable stops the process and names the variable, not the value', () => {
  const message = unresolvedReferenceRefusal({ ANTHROPIC_API_KEY: ref('DUMMY_ITEM') });
  assert.ok(message);
  assert.match(message, /ANTHROPIC_API_KEY/);
  assert.match(message, /through `steward <verb>`/);
  assert.ok(!message.includes('DUMMY_ITEM'), 'the item path is not printed');
});

test('a quoted reference still counts, and the first offending variable is named', () => {
  const message = unresolvedReferenceRefusal({ A: 'fine', B: `"${ref('X')}"`, C: ref('Y') });
  assert.match(message ?? '', /\bB\b/);
  assert.equal(isOpReference(`'${ref('X')}'`), true);
  assert.equal(isOpReference('https://example.test/op://not-at-start'), false);
  assert.equal(isOpReference(undefined), false);
});

test('envLineIsReference reads one line and ignores comments and other keys', () => {
  const text = `# KEY_A=${ref('A')}\nKEY_A=plain\nKEY_B=${ref('B')}\r\n`;
  assert.equal(envLineIsReference(text, 'KEY_A'), false);
  assert.equal(envLineIsReference(text, 'KEY_B'), true);
  assert.equal(envLineIsReference(text, 'KEY_C'), false);
});

test('the rotate .env write keeps a reference line and writes a plain line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-envref-'));
  try {
    fs.mkdirSync(path.join(dir, 'agents', 'steward'), { recursive: true });
    const file = path.join(dir, 'agents', 'steward', '.env');
    const start = `KEY_REF=${ref('R')}\nKEY_PLAIN=old\n`;
    fs.writeFileSync(file, start);
    const { deps } = createRealDeps({
      checkout: dir,
      envFile: 'agents/steward/.env',
      target: { railwayService: 's', railwayEnvironment: 'e' } as never,
      verifiers: {},
      timeZone: 'UTC',
      log: () => {},
    });
    assert.equal(await deps.env.setLine('KEY_REF', 'new-value'), 'kept-reference');
    assert.equal(fs.readFileSync(file, 'utf8'), start, 'a reference line is untouched');
    assert.equal(await deps.env.setLine('KEY_PLAIN', 'new-value'), undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), `KEY_REF=${ref('R')}\nKEY_PLAIN=new-value\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config.ts exits with the guard message when a reference reaches it', () => {
  const stewardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tsx = path.resolve(stewardDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(process.execPath, [tsx, '-e', "import('./src/config.ts')"], {
    cwd: stewardDir,
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: ref('DUMMY') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ANTHROPIC_API_KEY is still a 1Password reference/);
  assert.ok(!result.stderr.includes('DUMMY'));
});
