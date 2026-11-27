/**
 * `steward fix-log backfill` against an in-memory GitHub and an injected model: the
 * launch set, the dry run, the commits and the one pull request, the resume from the
 * branch, the slug clash inside one run, `--only`, a failed draft, and the credential
 * check. No network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKFILL_BRANCH, BRIEF_PATH, runFixLogBackfill, type BackfillGitHub, type PullRequestFacts } from '../../src/lib/fix-log-backfill.js';
import { backfillCredentialRefusal } from '../../src/lib/fix-log-backfill-github.js';
import { GOOD, acceptingReviewer, findingText, problems, reply, scriptedModel } from './fix-log-fixtures.js';

const SITE = 'mattpyle/mattpyle.com-website';
const ARGUS = 'mattpyle/argus';

interface World {
  files: Map<string, string>; // `${repo}@${ref}:${path}`
  branches: Set<string>;
  prs: Map<number, PullRequestFacts>;
  writes: Array<{ path: string; branch: string }>;
  opened: Array<{ branch: string; base: string; body: string }>;
  reads: string[];
}

function world(findings: Array<{ key: string; slug: string; status: string; pr: number; merged: boolean; verified?: boolean }>): World {
  const w: World = { files: new Map(), branches: new Set(['master']), prs: new Map(), writes: [], opened: [], reads: [] };
  w.files.set(`${SITE}@master:${BRIEF_PATH}`, '# Writing a fix log entry\n\nThe brief on master.');
  w.files.set(
    `${SITE}@master:src/content/fixes/mp-1.md`,
    '---\nkey: MP-1\ntitle: "An older entry on another page"\nslug: "an-older-entry-on-another-page"\n---\nBody.\n',
  );
  const index = ['# Findings', '', '`key | status | title | verdict reason`', ''];
  for (const f of findings) {
    index.push(`${f.slug} | ${f.status} | A finding | ok`);
    w.files.set(`${ARGUS}@main:sites/mattpyle-com/findings/${f.slug}.md`, findingText(f.key, { status: f.status, pr: f.pr, verified: f.verified }));
    w.prs.set(f.pr, { number: f.pr, title: `fix: ${f.key}`, body: 'The fix.', opened: '2026-11-19T04:00:00Z', merged: f.merged ? '2026-11-19T05:00:00Z' : null });
  }
  w.files.set(`${ARGUS}@main:sites/mattpyle-com/findings/INDEX.md`, index.join('\n'));
  return w;
}

function github(w: World): BackfillGitHub {
  return {
    async readFile(repo, path, ref) {
      w.reads.push(`${repo}@${ref}:${path}`);
      return w.files.get(`${repo}@${ref}:${path}`);
    },
    async listDir(repo, dir, ref) {
      if (!w.branches.has(ref) && repo === SITE) return undefined;
      const prefix = `${repo}@${ref}:${dir}/`;
      return [...w.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
    async branchSha(_repo, branch) {
      return w.branches.has(branch) ? `sha-${branch}` : undefined;
    },
    async ensureBranch(repo, branch) {
      w.branches.add(branch);
      for (const [k, v] of [...w.files]) if (k.startsWith(`${repo}@master:`)) w.files.set(k.replace('@master:', `@${branch}:`), v);
    },
    async writeFile(repo, input) {
      const key = `${repo}@${input.branch}:${input.path}`;
      assert.ok(!w.files.has(key), `${key} is written once`);
      w.files.set(key, input.text);
      w.writes.push({ path: input.path, branch: input.branch });
      return `commit-${w.writes.length}`;
    },
    async pullRequest(_repo, number) {
      const pr = w.prs.get(number);
      assert.ok(pr, `PR ${number}`);
      return pr;
    },
    async pullRequestDiff() {
      return '--- src/pages/about.astro (modified)\n-old\n+new';
    },
    async openOrUpdatePr(_repo, input) {
      const open = w.opened.find((p) => p.branch === input.branch);
      if (open) open.body = input.body;
      else w.opened.push({ branch: input.branch, base: input.base, body: input.body });
      return 'https://github.com/mattpyle/mattpyle.com-website/pull/999';
    },
  };
}

const options = (extra: Partial<Parameters<typeof runFixLogBackfill>[0]> = {}) => ({
  siteRepo: SITE,
  findingsRepo: ARGUS,
  site: 'mattpyle-com',
  dryRun: false,
  ...extra,
});

const titled = (title: string) => reply({ ...GOOD, title });

const THREE = [
  { key: 'MP-10', slug: 'mp-10-thing', status: 'resolved', pr: 910, merged: true },
  { key: 'MP-11', slug: 'mp-11-thing', status: 'reopened', pr: 911, merged: true },
  { key: 'MP-12', slug: 'mp-12-thing', status: 'fixing', pr: 912, merged: true, verified: false },
  { key: 'MP-13', slug: 'mp-13-thing', status: 'fixing', pr: 913, merged: false, verified: false },
  { key: 'MP-14', slug: 'mp-14-thing', status: 'proposed', pr: 914, merged: false, verified: false },
];

test('a dry run lists the launch set, writes nothing and opens nothing', async () => {
  const w = world(THREE);
  const lines: string[] = [];
  const report = await runFixLogBackfill(options({ dryRun: true }), { github: github(w), print: (l) => lines.push(l) });
  assert.deepEqual(report.wanted, ['MP-10', 'MP-11']);
  assert.deepEqual(report.undecided, ['MP-12'], 'a merged fix whose finding is not decided is listed, not drafted');
  assert.equal(w.writes.length, 0);
  assert.equal(w.opened.length, 0);
  assert.ok(!w.branches.has(BACKFILL_BRANCH), 'no branch');
  assert.ok(lines.some((l) => l.includes('would draft src/content/fixes/mp-10.md from PR #910')));
  assert.ok(lines.some((l) => l.includes('Skipped, the finding not yet resolved or reopened: MP-12')));
  assert.ok(!w.reads.some((r) => r.includes('mp-14-thing')), 'a proposed finding is not read');
});

test('a run commits each entry to one branch, opens one pull request, and prints the cost', async () => {
  const w = world(THREE);
  const lines: string[] = [];
  const model = scriptedModel([titled('The first finding left a stale line on the page'), reply(GOOD)]);
  const report = await runFixLogBackfill(options(), { github: github(w), send: model.send, review: acceptingReviewer().send, print: (l) => lines.push(l) });
  assert.deepEqual(report.drafted.map((d) => d.key), ['MP-10', 'MP-11']);
  assert.deepEqual(w.writes, [
    { path: 'src/content/fixes/mp-10.md', branch: BACKFILL_BRANCH },
    { path: 'src/content/fixes/mp-11.md', branch: BACKFILL_BRANCH },
  ]);
  assert.equal(w.opened.length, 1);
  assert.equal(w.opened[0].base, 'master');
  assert.match(w.opened[0].body, /\| `mp-10\.md` \| 1 \| 1 \| 0 \| 100 in, 20 out \| 50 in, 5 out \|/);
  assert.doesNotMatch(w.opened[0].body, /## Review notes/, 'no notes, no section');
  assert.deepEqual(report.usage, { writer: { inputTokens: 200, outputTokens: 40 }, reviewer: { inputTokens: 100, outputTokens: 10 } });
  assert.equal(report.correctionTurns, 0);
  assert.ok(lines.some((l) => l === 'Tokens in total: writer 200 in, 40 out; reviewer 100 in, 10 out. Correction turns: 0.'));
  assert.ok(lines.some((l) => l.includes('MP-10: src/content/fixes/mp-10.md, 1 writer turn, 1 review, writer 100 in, 20 out; reviewer 50 in, 5 out tokens.')));
  assert.match(model.calls[0].system, /The brief on master/, 'the brief comes from master');
  assert.ok(w.reads.includes(`${SITE}@master:${BRIEF_PATH}`));
  assert.match(String(model.calls[0].messages[0].content), /- An older entry on another page/, 'master entries are taken');
});

test('a second run resumes: it skips what the branch holds and reads its titles from the branch', async () => {
  const w = world(THREE);
  const first = scriptedModel([titled('The first finding left a stale line on the page')]);
  await runFixLogBackfill(options({ only: new Set(['MP-10']) }), { github: github(w), send: first.send, review: acceptingReviewer().send, print: () => {} });
  assert.equal(w.writes.length, 1);

  // The model offers the first run's title again; the branch's copy makes it a clash.
  const second = scriptedModel([titled('The first finding left a stale line on the page'), reply(GOOD)]);
  const report = await runFixLogBackfill(options(), { github: github(w), send: second.send, review: acceptingReviewer().send, print: () => {} });
  assert.deepEqual(report.existing.sort(), ['MP-10']);
  assert.deepEqual(report.drafted.map((d) => d.key), ['MP-11']);
  assert.equal(report.drafted[0].attempts, 2);
  assert.equal(report.correctionTurns, 1);
  assert.match(String(second.calls[1].messages.at(-1)?.content), /title-taken|slug-taken/);
  assert.equal(w.writes.length, 2);
  assert.equal(w.opened.length, 1, 'the open pull request is updated, not opened twice');
});

test('two drafts in one run cannot take the same slug', async () => {
  const w = world(THREE);
  const same = 'Both findings left a stale line on the page';
  const model = scriptedModel([titled(same), titled(same), reply(GOOD)]);
  const report = await runFixLogBackfill(options(), { github: github(w), send: model.send, review: acceptingReviewer().send, print: () => {} });
  const slugs = report.drafted.map((d) => d.slug);
  assert.equal(new Set(slugs).size, 2);
  assert.match(String(model.calls[2].messages.at(-1)?.content), /slug-taken/);
});

test('--only limits the run, and a failed draft is listed while the run goes on', async () => {
  const w = world(THREE);
  const bad = reply({ ...GOOD, story: 'It held a — dash.' });
  const model = scriptedModel([bad, bad, bad, reply(GOOD)]);
  const lines: string[] = [];
  const report = await runFixLogBackfill(options(), { github: github(w), send: model.send, review: acceptingReviewer().send, print: (l) => lines.push(l) });
  assert.deepEqual(report.failed.map((f) => f.key), ['MP-10']);
  assert.match(report.failed[0].reason, /em-dash/);
  assert.deepEqual(report.drafted.map((d) => d.key), ['MP-11']);
  assert.equal(report.correctionTurns, 2, 'the failed draft used two correction turns');
  assert.deepEqual(report.usage.writer, { inputTokens: 400, outputTokens: 80 });
  assert.match(w.opened[0].body, /Not drafted, the draft failed: MP-10/);

  const w2 = world(THREE);
  const only = await runFixLogBackfill(options({ dryRun: true, only: new Set(['MP-11']) }), { github: github(w2), print: () => {} });
  assert.deepEqual(only.wanted, ['MP-11']);

  // `--only` with a full key picks the same finding.
  const slug = THREE.find((f) => f.key === 'MP-11')!.slug;
  const byFull = await runFixLogBackfill(options({ dryRun: true, only: new Set([slug]) }), { github: github(world(THREE)), print: () => {} });
  assert.deepEqual(byFull.wanted, ['MP-11']);
});

test('a run that writes needs the model, and the credential check names what is missing', async () => {
  await assert.rejects(runFixLogBackfill(options(), { github: github(world(THREE)), print: () => {} }), /needs the model/);
  const dry = backfillCredentialRefusal({}, true);
  assert.match(dry ?? '', /^STEWARD_GITHUB_APP_ID, STEWARD_GITHUB_APP_PRIVATE_KEY are not set\. A dry run/);
  assert.doesNotMatch(dry ?? '', /ANTHROPIC/);
  assert.match(backfillCredentialRefusal({ STEWARD_GITHUB_APP_ID: '1', STEWARD_GITHUB_APP_PRIVATE_KEY: 'k' }, false) ?? '', /^ANTHROPIC_API_KEY is not set/);
  assert.equal(backfillCredentialRefusal({ STEWARD_GITHUB_APP_ID: '1', STEWARD_GITHUB_APP_PRIVATE_KEY: 'k' }, true), null);
});

test('a draft the reviewer still objects to is committed, and its notes are listed in the pull request body', async () => {
  const w = world(THREE);
  const note = { quote: 'One of them had been removed.', rule: 'unsupported', reason: 'No source says it was removed; searched the finding and PR #910 for "removed".' };
  const review = scriptedModel([problems([note]), problems([note]), { text: JSON.stringify({ verdict: 'accept' }), usage: { inputTokens: 50, outputTokens: 5 } }]);
  const model = scriptedModel([titled('The first finding left a stale line on the page'), titled('The first finding left a stale line on the page'), reply(GOOD)]);
  const report = await runFixLogBackfill(options(), { github: github(w), send: model.send, review: review.send, print: () => {} });
  assert.deepEqual(report.drafted.map((d) => [d.key, d.reviewNotes.length]), [['MP-10', 1], ['MP-11', 0]]);
  assert.equal(w.writes.length, 2, 'the noted draft is committed, not thrown away');
  const body = w.opened[0].body;
  assert.match(body, /\| `mp-10\.md` \| 2 \| 2 \| 1 \|/);
  assert.match(body, /## Review notes/);
  assert.match(body, /### `mp-10\.md`\n\n1\. "One of them had been removed\." \(unsupported\): No source says it was removed; searched the finding/);
  assert.doesNotMatch(body, /### `mp-11\.md`/);
});

test('a credential failure stops the run at once and lists the entries not tried', async () => {
  const { ApplicationFailure } = await import('@temporalio/activity');
  const findings = [...THREE.slice(0, 2), { key: 'MP-15', slug: 'mp-15-thing', status: 'resolved', pr: 915, merged: true }];
  for (const failure of [
    ApplicationFailure.nonRetryable('The model refused the request (401): invalid x-api-key', 'ModelRequestRefused', { status: 401 }),
    ApplicationFailure.nonRetryable('ANTHROPIC_API_KEY is not set. Drafting a fix log entry needs it.', 'ModelKeyMissing'),
  ]) {
    const w = world(findings);
    let calls = 0;
    const lines: string[] = [];
    const report = await runFixLogBackfill(options(), {
      github: github(w),
      send: async () => {
        calls++;
        throw failure;
      },
      review: acceptingReviewer().send,
      print: (l) => lines.push(l),
    });
    assert.equal(calls, 1, `${failure.type}: one model call, then the stop`);
    assert.deepEqual(report.failed.map((f) => f.key), ['MP-10']);
    assert.deepEqual(report.notTried, ['MP-11', 'MP-15']);
    assert.match(report.stopped ?? '', /credential failure on MP-10/);
    assert.ok(lines.some((l) => l === 'Stopped: a credential failure. Not tried: MP-11, MP-15.'));
    assert.equal(w.writes.length, 0);
    assert.equal(w.opened.length, 0, 'nothing drafted, no branch head before: no pull request');
  }

  // A refusal that is not a credential (a 400) fails one entry and the run goes on.
  const w = world(findings);
  let first = true;
  const model = scriptedModel([reply(GOOD), reply({ ...GOOD, title: 'The third finding left a stale line on its page' })]);
  const report = await runFixLogBackfill(options(), {
    github: github(w),
    send: async (system, messages, opts) => {
      if (first) {
        first = false;
        throw ApplicationFailure.nonRetryable('The model refused the request (400): bad', 'ModelRequestRefused', { status: 400 });
      }
      return model.send(system, messages, opts);
    },
    review: acceptingReviewer().send,
    print: () => {},
  });
  assert.equal(report.stopped, undefined);
  assert.deepEqual(report.drafted.map((d) => d.key), ['MP-11', 'MP-15']);
});

test('a review note escapes its backslashes before its pipes, and keeps to one line', async () => {
  const { noteText } = await import('../../src/lib/fix-log-backfill.js');
  const bs = String.fromCharCode(92);
  assert.equal(noteText(`a${bs}|b`), `a${bs}${bs}${bs}|b`, 'the backslash is escaped, then the pipe');
  assert.equal(noteText(`x${bs}`), `x${bs}${bs}`, 'a trailing backslash cannot escape what follows');
  assert.equal(noteText('one\r\ntwo\nthree'), 'one two three');

  const w = world(THREE);
  const note = { quote: `C:${bs}path | piped`, rule: 'unsupported', reason: `no source holds ${bs}| here` };
  const review = scriptedModel([problems([note]), problems([note]), { text: JSON.stringify({ verdict: 'accept' }), usage: { inputTokens: 1, outputTokens: 1 } }]);
  const model = scriptedModel([reply(GOOD), reply(GOOD), reply({ ...GOOD, title: 'The second finding left a stale line on its page' })]);
  await runFixLogBackfill(options(), { github: github(w), send: model.send, review: review.send, print: () => {} });
  assert.ok(
    w.opened[0].body.includes(`1. "C:${bs}${bs}path ${bs}| piped" (unsupported): no source holds ${bs}${bs}${bs}| here`),
    w.opened[0].body,
  );
});
