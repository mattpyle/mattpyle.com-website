import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTALLED_BY_SHIM_ENV,
  REINSTALL_EXIT_CODE,
  envFileHasReference,
  installFailureMessage,
  launchPlan,
  nextShimStep,
  opMissingMessage,
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

// Built at run time: the reference text holds no real item name.
const REF = ['op:', '', 'Steward', 'DUMMY', 'credential'].join('/');

test('envFileHasReference finds a reference value and ignores comments, plain values and key text', () => {
  assert.equal(envFileHasReference(`A=1\nB=${REF}\n`), true);
  assert.equal(envFileHasReference(`B="${REF}"\r\n`), true);
  assert.equal(envFileHasReference(`# B=${REF}\nA=plain\n`), false);
  assert.equal(envFileHasReference('A=https://example.test/op://x\n'), false);
  assert.equal(envFileHasReference(''), false);
});

test('launchPlan wraps when references are present and op exists', () => {
  assert.deepEqual(launchPlan({ envFileText: `B=${REF}\n`, opPath: 'op-path' }), { kind: 'wrap' });
});

test('launchPlan runs plain when the file has no references', () => {
  assert.deepEqual(launchPlan({ envFileText: 'A=1\n', opPath: 'op-path' }), { kind: 'plain' });
  assert.deepEqual(launchPlan({ envFileText: 'A=1\n', opPath: null }), { kind: 'plain' });
});

test('launchPlan runs plain when there is no file', () => {
  assert.deepEqual(launchPlan({ envFileText: null, opPath: null }), { kind: 'plain' });
});

test('launchPlan gives a clear message, not a spawn error, when op is missing', () => {
  const plan = launchPlan({ envFileText: `B=${REF}\n`, opPath: null });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.kind === 'error' && plan.message, opMissingMessage());
  assert.match(opMissingMessage(), /1Password CLI \(`op`\) is not on PATH/);
});
