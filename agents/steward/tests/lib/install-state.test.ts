import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertLighthouseMatchesLock,
  installStaleReason,
  lighthouseMismatch,
  lighthouseMismatchMessage,
  readInstallStaleReason,
} from '../../src/lib/install-state.js';

const lock = (lh: string) => ({
  packages: { '': {}, 'node_modules/lighthouse': { version: lh }, 'node_modules/axe-core': { version: '4.12.0' } },
});
const installed = (lh: string) => ({
  packages: { 'node_modules/lighthouse': { version: lh }, 'node_modules/axe-core': { version: '4.12.0' } },
});

test('matching package entries are not stale, whatever the key order', () => {
  const reordered = {
    packages: { 'node_modules/axe-core': { version: '4.12.0' }, 'node_modules/lighthouse': { version: '13.5.0' } },
  };
  assert.equal(installStaleReason(reordered, lock('13.5.0')), null);
});

test('a version that differs is stale and names both versions', () => {
  const reason = installStaleReason(installed('13.4.1'), lock('13.5.0'));
  assert.match(reason ?? '', /lighthouse is installed at 13\.4\.1, locked at 13\.5\.0/);
});

test('a missing install record is stale', () => {
  assert.match(installStaleReason(null, lock('13.5.0')) ?? '', /missing/);
});

test('a locked package that is not installed, and the reverse, are stale', () => {
  const missing = { packages: { 'node_modules/lighthouse': { version: '13.5.0' } } };
  assert.match(installStaleReason(missing, lock('13.5.0')) ?? '', /axe-core is locked but not installed/);
  const extra = { packages: { ...installed('13.5.0').packages, 'node_modules/left-pad': { version: '1.0.0' } } };
  assert.match(installStaleReason(extra, lock('13.5.0')) ?? '', /left-pad is installed but not locked/);
});

test('the Lighthouse message names both versions and the fix', () => {
  const m = lighthouseMismatch('13.4.1', '13.5.0');
  assert.ok(m);
  const text = lighthouseMismatchMessage(m);
  assert.match(text, /13\.4\.1/);
  assert.match(text, /13\.5\.0/);
  assert.match(text, /npm ci/);
  assert.equal(lighthouseMismatch('13.5.0', '13.5.0'), null);
});

function fixtureRoot(installedLh: string | null, lockedLh: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-'));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock(lockedLh)));
  if (installedLh !== null) {
    fs.mkdirSync(path.join(root, 'node_modules', 'lighthouse'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'node_modules', 'lighthouse', 'package.json'),
      JSON.stringify({ version: installedLh }),
    );
    fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), JSON.stringify(installed(installedLh)));
  }
  return root;
}

test('the worker startup guard refuses a mismatched install, with both versions in the message', () => {
  const root = fixtureRoot('13.4.1', '13.5.0');
  assert.throws(() => assertLighthouseMatchesLock(root), /13\.4\.1.*13\.5\.0.*npm ci/s);
});

test('the worker startup guard returns the installed version when it matches the lock', () => {
  assert.equal(assertLighthouseMatchesLock(fixtureRoot('13.5.0', '13.5.0')), '13.5.0');
});

test('a root with no install is refused, and readInstallStaleReason reports the missing record', () => {
  const root = fixtureRoot(null, '13.5.0');
  assert.throws(() => assertLighthouseMatchesLock(root), /not installed/);
  assert.match(readInstallStaleReason(root) ?? '', /missing/);
});
