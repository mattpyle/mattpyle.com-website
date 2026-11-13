/**
 * The SDK shim in `src/sdk-compat.ts` is written for one harness version and one specifier. These
 * tests make both facts impossible to miss: a harness upgrade fails here until someone re-checks
 * whether the shim is still needed, and the rewrite cannot widen past the one specifier.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { BROKEN_SPECIFIER, FIXED_SPECIFIER, SHIM_WRITTEN_FOR, bundlerOptions, rewrite } from '../src/sdk-compat.js';

function installedVersion(pkg: string): string {
  for (const base of ['../node_modules/', '../../../node_modules/']) {
    const file = new URL(`${base}${pkg}/package.json`, import.meta.url);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  }
  throw new Error(`${pkg} is not installed`);
}

for (const pkg of ['@temporalio/agent-harness', '@temporalio/agent-harness-worker']) {
  test(`${pkg} is the version the SDK shim was written for`, () => {
    const version = installedVersion(pkg);
    assert.equal(
      version,
      SHIM_WRITTEN_FOR,
      `${pkg} is ${version}, but src/sdk-compat.ts was written for ${SHIM_WRITTEN_FOR}. ` +
        `Check whether the new release still imports ${BROKEN_SPECIFIER}. If it does not, delete ` +
        'src/sdk-compat.ts and its --import flags; if it does, set SHIM_WRITTEN_FOR to the new version.',
    );
  });
}

test('the Node rewrite changes the one specifier and nothing else', () => {
  assert.equal(rewrite(BROKEN_SPECIFIER), FIXED_SPECIFIER);
  for (const other of [
    '@temporalio/common',
    '@temporalio/common/time',
    '@temporalio/common/lib/errors.js',
    '@temporalio/common/lib/time',
    '@temporalio/common/lib/time.js.map',
    './lib/time.js',
    `${BROKEN_SPECIFIER}?x`,
  ]) {
    assert.equal(rewrite(other), other, other);
  }
});

test('the webpack alias is one exact-match entry and keeps existing aliases', () => {
  const objectForm = bundlerOptions.webpackConfigHook!({ resolve: { alias: { kept: 'k' } } });
  assert.deepEqual(objectForm.resolve?.alias, { kept: 'k', [`${BROKEN_SPECIFIER}$`]: FIXED_SPECIFIER });

  const arrayForm = bundlerOptions.webpackConfigHook!({ resolve: { alias: [{ name: 'kept', alias: 'k' }] } });
  assert.deepEqual(arrayForm.resolve?.alias, [
    { name: 'kept', alias: 'k' },
    { name: BROKEN_SPECIFIER, alias: FIXED_SPECIFIER, onlyModule: true },
  ]);
});
