import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTALLED_BY_SHIM_ENV,
  REINSTALL_EXIT_CODE,
  installFailureMessage,
  nextShimStep,
} from '../../scripts/shim-decision.mjs';

test('the reinstall exit code is a code no ordinary failure uses', () => {
  assert.equal(REINSTALL_EXIT_CODE, 75);
  assert.equal(INSTALLED_BY_SHIM_ENV, 'STEWARD_INSTALLED_BY_SHIM');
});

test('the shim reinstalls on the reinstall exit code and passes every other code through', () => {
  assert.equal(nextShimStep({ exitCode: REINSTALL_EXIT_CODE, installedByShim: false }), 'reinstall');
  for (const exitCode of [0, 1, 2, 130, null]) {
    assert.equal(nextShimStep({ exitCode, installedByShim: false }), 'exit');
  }
});

test('the shim never reinstalls twice in one run', () => {
  assert.equal(nextShimStep({ exitCode: REINSTALL_EXIT_CODE, installedByShim: true }), 'exit');
});

test('the install failure message names the exit code and the fix', () => {
  const msg = installFailureMessage(1);
  assert.match(msg, /exit 1/);
  assert.match(msg, /`npm ci` at the repository root, then `steward up`/);
});
