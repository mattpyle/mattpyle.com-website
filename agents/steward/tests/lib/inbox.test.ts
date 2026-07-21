import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveInboxHint } from '../../src/lib/inbox.js';

test('awaiting_verdict is your turn', () => {
  const { yourTurn, hint } = deriveInboxHint({ state: 'awaiting_verdict' });
  assert.equal(yourTurn, true);
  assert.match(hint, /approve or reject/);
});

test('stale is your turn (send rereview)', () => {
  const { yourTurn, hint } = deriveInboxHint({ state: 'stale' });
  assert.equal(yourTurn, true);
  assert.match(hint, /rereview/);
});

test('running is in progress, not your turn', () => {
  const { yourTurn, hint } = deriveInboxHint({ state: 'running' });
  assert.equal(yourTurn, false);
  assert.match(hint, /in progress/);
});

test('applying_patches is in progress, not your turn', () => {
  const { yourTurn, hint } = deriveInboxHint({ state: 'applying_patches' });
  assert.equal(yourTurn, false);
  assert.match(hint, /applying patches/);
});

test('verifying_deploy is in progress, not your turn', () => {
  const { yourTurn, hint } = deriveInboxHint({ state: 'verifying_deploy' });
  assert.equal(yourTurn, false);
  assert.match(hint, /verifying production deploy/);
});

test('publishing with no staleReason is mid-flight, not your turn', () => {
  const { yourTurn, hint } = deriveInboxHint({ state: 'publishing' });
  assert.equal(yourTurn, false);
  assert.match(hint, /in progress: publishing/);
});

test('publishing parked on unmerged PR is your turn: merge, then re-approve', () => {
  const { yourTurn, hint } = deriveInboxHint({
    state: 'publishing',
    staleReason:
      'PR open, awaiting merge: https://github.com/mattpyle/mattpyle.com-website/pull/42. ' +
      'Verification against production did not pass after 10 attempts.',
    prUrl: 'https://github.com/mattpyle/mattpyle.com-website/pull/42',
  });
  assert.equal(yourTurn, true);
  assert.match(hint, /merge PR #42/);
  assert.match(hint, /re-approve/);
});

test('publishing parked on failing CI is your turn: fix, then approve to resume', () => {
  const { yourTurn, hint } = deriveInboxHint({
    state: 'publishing',
    staleReason:
      'PR CI is FAILING — merge is blocked, so waiting cannot succeed. Failing: build. ' +
      'PR: https://github.com/mattpyle/mattpyle.com-website/pull/7. Fix the cause, then send `approve` again.',
    prUrl: 'https://github.com/mattpyle/mattpyle.com-website/pull/7',
  });
  assert.equal(yourTurn, true);
  assert.match(hint, /PR #7/);
  assert.match(hint, /CI is failing/);
  assert.match(hint, /approve.*again to resume/);
});

test('publishing parked with a staleReason but no prUrl still renders a hint', () => {
  const { yourTurn, hint } = deriveInboxHint({
    state: 'publishing',
    staleReason: 'PR open, awaiting merge: https://example.invalid/pr. Verification did not pass.',
  });
  assert.equal(yourTurn, true);
  assert.match(hint, /merge the PR/);
});

for (const state of ['approved', 'published', 'rejected', 'audited', 'failed'] as const) {
  test(`terminal state "${state}" is not your turn`, () => {
    const { yourTurn, hint } = deriveInboxHint({ state });
    assert.equal(yourTurn, false);
    assert.equal(hint, 'closed');
  });
}
