import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteAutoFix } from '../../src/activities/findings.js';
import { approvedNextStep } from '../../src/lib/finding-fix.js';

/** The line `steward finding approve` prints after the verdict, from the site's `auto_fix` flag. */

const KEY = 'ux-more-menu-never-closes--sitewide';

test('on a site with auto_fix, approve says the run measures first and then opens the fix issue', () => {
  const autoFix = siteAutoFix('site:\n  name: mattpyle-com\nauto_fix: true\n');
  assert.equal(approvedNextStep(KEY, autoFix), 'The run measures the checks on production first, and resolves the finding with no fix if all pass. Otherwise it opens the fix issue: the site has auto_fix.');
});

test('on a site without auto_fix, approve says the workflow waits for the fix command', () => {
  const expected = `The run measures the checks on production first, and resolves the finding with no fix if all pass. Otherwise it waits for \`steward finding fix ${KEY}\`.`;
  assert.equal(approvedNextStep(KEY, siteAutoFix('site:\n  name: temporal-io\n')), expected);
  assert.equal(approvedNextStep(KEY, siteAutoFix('auto_fix: false\n')), expected);
});
