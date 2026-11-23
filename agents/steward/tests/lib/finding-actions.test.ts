import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixOffered, verifyOffered } from '../../src/lib/finding-actions.js';

/**
 * The shared half of `steward finding fix|verify` and the console's buttons, against fakes: the gates
 * the page uses to offer Fix and Verify.
 */

const PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/533';

const defect = { status: 'approved', kind: 'defect' };
const textOf = (cause: boolean, measure: boolean) =>
  [
    '---',
    'status: approved',
    '---',
    '# A title',
    '## What happened',
    cause ? '- Cause: a missing alt attribute.' : '- Seen on /about.',
    ...(measure ? ['## How to measure', 'Open /about and look for an alt attribute.'] : []),
  ].join('\n');

test('Fix is offered for an approved finding with no open run on a site with a fixer that fixRefusal accepts', () => {
  const base = { site: 'mattpyle-com', status: 'approved', runOpen: false, stopAfter: null, data: defect, text: textOf(true, true) };
  assert.equal(fixOffered(base), true);
  assert.equal(fixOffered({ ...base, runOpen: true }), false, 'an open run');
  assert.equal(fixOffered({ ...base, status: 'proposed' }), false, 'not approved');
  assert.equal(fixOffered({ ...base, stopAfter: 'verdict' }), false, 'a site that stops at the verdict');
  assert.equal(fixOffered({ ...base, site: 'temporal-io' }), false, 'a site with no production origin');
  assert.equal(fixOffered({ ...base, text: textOf(false, true) }), false, 'no cause');
  assert.equal(fixOffered({ ...base, text: textOf(true, false) }), false, 'no measure');
  assert.equal(fixOffered({ ...base, data: { status: 'approved', kind: 'direction' } }), false, 'a direction');
});

test('Fix is also offered for a run parked at waiting-fix with no issue, and not for one with an issue or mid-fix', () => {
  const base = { site: 'mattpyle-com', status: 'approved', runOpen: true, runStep: 'waiting-fix', issueUrl: null, stopAfter: null, data: defect, text: textOf(true, true) };
  assert.equal(fixOffered(base), true, 'a parked run the gate accepts');
  assert.equal(fixOffered({ ...base, issueUrl: 'https://github.com/o/r/issues/1' }), false, 'its issue is open or its fix ended: the CLI retries it');
  assert.equal(fixOffered({ ...base, runStep: 'fixing' }), false, 'mid-fix');
  assert.equal(fixOffered({ ...base, runStep: null }), false, 'a run that was not queried');
  assert.equal(fixOffered({ ...base, text: textOf(true, false) }), false, 'a parked run the gate refuses');
});

test('Verify is offered for a fixing finding with a PR that is merged, and the PR is asked about only when the gate accepts', async () => {
  const asked: string[] = [];
  const merged = async (url: string) => (asked.push(url), true);
  const open = async (url: string) => (asked.push(url), false);
  const fixing = { status: 'fixing', links: { pr: PR } };
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: fixing }, merged), true);
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: fixing }, open), false, 'an open PR');
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: { status: 'fixing' } }, merged), false, 'no links.pr');
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: { status: 'resolved', links: { pr: PR } } }, merged), false, 'resolved');
  assert.equal(await verifyOffered({ site: 'mattpyle-com', data: { status: 'approved', links: { pr: PR } } }, merged), false, 'approved');
  assert.equal(await verifyOffered({ site: 'temporal-io', data: fixing }, merged), false, 'a site with no production origin');
  assert.deepEqual(asked, [PR, PR]);
});
