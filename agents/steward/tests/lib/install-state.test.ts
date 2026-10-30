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

// Shaped like the real lockfile on Windows: platform builds are locked as
// optional and never installed.
const platformLock = {
  packages: {
    '': {},
    'node_modules/lighthouse': { version: '13.5.0' },
    'node_modules/@astrojs/compiler-binding-android-arm64': { version: '1.0.0', optional: true },
    'node_modules/@esbuild/aix-ppc64': { version: '0.25.0', optional: true, os: ['aix'] },
  },
};
const platformInstalled = { packages: { 'node_modules/lighthouse': { version: '13.5.0' } } };

test('locked optional packages that npm did not install do not make the install stale', () => {
  assert.equal(installStaleReason(platformInstalled, platformLock), null);
});

test('an absent non-optional entry, a version difference and an extra entry still read as stale', () => {
  const absent = { packages: { ...platformLock.packages, 'node_modules/axe-core': { version: '4.12.0' } } };
  assert.match(installStaleReason(platformInstalled, absent) ?? '', /axe-core is locked but not installed/);
  const flagFalse = {
    packages: { ...platformLock.packages, 'node_modules/axe-core': { version: '4.12.0', optional: false } },
  };
  assert.match(installStaleReason(platformInstalled, flagFalse) ?? '', /axe-core is locked but not installed/);
  const older = { packages: { 'node_modules/lighthouse': { version: '13.4.1' } } };
  assert.match(installStaleReason(older, platformLock) ?? '', /lighthouse is installed at 13\.4\.1/);
  const extra = { packages: { ...platformInstalled.packages, 'node_modules/left-pad': { version: '1.0.0' } } };
  assert.match(installStaleReason(extra, platformLock) ?? '', /left-pad is installed but not locked/);
});

test('an optional package that is installed at another version is still stale', () => {
  const installed = {
    packages: { ...platformInstalled.packages, 'node_modules/@esbuild/aix-ppc64': { version: '0.24.0' } },
  };
  assert.match(installStaleReason(installed, platformLock) ?? '', /aix-ppc64 is installed at 0\.24\.0/);
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

test('a process counts as running from node_modules only under the repository root', async () => {
  const { runsFromNodeModules } = await import('../../src/lib/stack.js');
  const BS = String.fromCharCode(92);
  const root = 'C:/Users/me/repo';
  assert.equal(runsFromNodeModules('C:/Users/me/repo/node_modules/@esbuild/win32-x64/esbuild.exe', root), true);
  assert.equal(runsFromNodeModules(['C:', 'Users', 'me', 'repo', 'node_modules', 'a.exe'].join(BS), 'C:' + BS + 'Users' + BS + 'me' + BS + 'repo'), true);
  assert.equal(runsFromNodeModules('c:/users/ME/repo/NODE_MODULES/x/a.exe', root), true);
  assert.equal(runsFromNodeModules('C:/Users/me/repo/node_modules_other/a.exe', root), false);
  assert.equal(runsFromNodeModules('C:/Users/me/other/node_modules/a.exe', root), false);
  assert.equal(runsFromNodeModules('C:/Program Files/nodejs/node.exe', root), false);
  assert.equal(runsFromNodeModules(null, root), false);
});
