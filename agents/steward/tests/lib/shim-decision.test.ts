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
  referenceEntries,
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

test('launchPlan wraps and injects a reference line whose key the shell has not set', () => {
  const plan = launchPlan({ envFileText: `A=plain\nB=${REF}\nC = "${REF}"\n`, opPath: 'op-path', env: {} });
  assert.deepEqual(plan, { kind: 'wrap', inject: { B: REF, C: REF } });
});

test('a variable already set in the shell wins over a reference line for the same key', () => {
  assert.deepEqual(launchPlan({ envFileText: `B=${REF}\n`, opPath: 'op-path', env: { B: 'from-shell' } }), { kind: 'plain' });
  assert.deepEqual(launchPlan({ envFileText: `B=${REF}\n`, opPath: null, env: { B: '' } }), { kind: 'plain' });
  const plan = launchPlan({ envFileText: `B=${REF}\nC=${REF}\n`, opPath: 'op-path', env: { B: 'from-shell' } });
  assert.deepEqual(plan, { kind: 'wrap', inject: { C: REF } });
});

test('plain lines are never passed on', () => {
  const plan = launchPlan({ envFileText: 'A=plain\nB=also-plain\n', opPath: 'op-path', env: {} });
  assert.deepEqual(plan, { kind: 'plain' });
  const mixed = launchPlan({ envFileText: `A=plain\nB=${REF}\n`, opPath: 'op-path', env: {} });
  assert.deepEqual(Object.keys(mixed.kind === 'wrap' ? mixed.inject : {}), ['B']);
});

test('the first line for a key wins, as in loadDotEnv', () => {
  assert.deepEqual(referenceEntries(`B=plain\nB=${REF}\n`), []);
  assert.deepEqual(referenceEntries(`B=${REF}\nB=plain\n`), [{ key: 'B', value: REF }]);
});

test('launchPlan runs plain when the file has no references', () => {
  assert.deepEqual(launchPlan({ envFileText: 'A=1\n', opPath: 'op-path', env: {} }), { kind: 'plain' });
  assert.deepEqual(launchPlan({ envFileText: 'A=1\n', opPath: null, env: {} }), { kind: 'plain' });
});

test('launchPlan runs plain when there is no file', () => {
  assert.deepEqual(launchPlan({ envFileText: null, opPath: null, env: {} }), { kind: 'plain' });
});

test('launchPlan gives a clear message, not a spawn error, when op is missing', () => {
  const plan = launchPlan({ envFileText: `B=${REF}\n`, opPath: null, env: {} });
  assert.equal(plan.kind, 'error');
  assert.equal(plan.kind === 'error' && plan.message, opMissingMessage());
  assert.match(opMissingMessage(), /1Password CLI \(`op`\) is not on PATH/);
});
