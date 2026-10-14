import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import {
  readVerifyBlock,
  writeFindingVerification,
  type WriteFindingVerificationInput,
} from '../../src/activities/findings.js';
import { runFindingChecks } from '../../src/activities/verify-finding.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { verifyWorkflowId } from '../../src/lib/findings.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, FIXING_FINDING, FIX_PR, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * The verifier's activities: the two GitHub ones against the fake (the block
 * read, and the write back under the two-writer contract of design decision
 * 19), and the check run with a fetch in production's place.
 */

const REPO = 'mattpyle/argus';
const FINDING = `sites/mattpyle-com/findings/${DEFECT_KEY}.md`;
const INDEX = 'sites/mattpyle-com/findings/INDEX.md';
const HANDOFF = `sites/mattpyle-com/handoffs/${DEFECT_KEY}.md`;
const AT = '2026-10-13T04:12:33.527Z';
const FIXING = FIXING_FINDING;

const INDEX_TEXT = [
  '# Findings index',
  '',
  'One line per finding, maintained by Argus: `key | status | kind | scenario | title | verdict reason`.',
  '',
  `${DEFECT_KEY} | fixing | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt.`,
  '',
].join('\n');

const BLOCK = ['verify:', `  - url: ${ORIGIN}/scorecard/`, '    kind: text', '    expect: {count: 0, of: "100/100 (Fail)"}'].join('\n');

let fake: FakeGitHub | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function seed(files: { finding?: string; handoff?: string } = {}): FakeGitHub {
  fake = installFakeGitHub({
    defaultBranch: 'main',
    seed: { [FINDING]: files.finding ?? FIXING, [INDEX]: INDEX_TEXT, [HANDOFF]: files.handoff ?? DEFECT_HANDOFF },
  });
  return fake;
}

function input(status: 'resolved' | 'reopened', overrides: Partial<WriteFindingVerificationInput> = {}): WriteFindingVerificationInput {
  return {
    repo: REPO,
    site: 'mattpyle-com',
    key: DEFECT_KEY,
    findingPath: FINDING,
    indexPath: INDEX,
    verification: {
      status,
      at: AT,
      workflowId: verifyWorkflowId('mattpyle-com', DEFECT_KEY, AT),
      source: 'finding',
      rows: [
        {
          n: 1,
          url: `${ORIGIN}/scorecard/`,
          kind: 'text',
          pass: status === 'resolved',
          expected: '0 occurrences of "100/100 (Fail)"',
          measured: status === 'resolved' ? '0 occurrences' : '2 occurrences',
        },
      ],
    },
    ...overrides,
  };
}

async function failure(run: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(err)}`);
    return err;
  }
  assert.fail('the call did not fail');
}

// ---------------------------------------------------------------------------
// readVerifyBlock
// ---------------------------------------------------------------------------

test('a handoff with a block is read as its checks, and an empty block is a block', async () => {
  seed({ handoff: DEFECT_HANDOFF.replace('verify: []', BLOCK) });
  const read = await readVerifyBlock({ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN });
  assert.equal(read.hasBlock, true);
  assert.deepEqual(read.checks, [{ url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { count: 0, of: '100/100 (Fail)' } }]);

  fake!.restore();
  seed();
  assert.deepEqual(await readVerifyBlock({ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN }), {
    handoff: DEFECT_HANDOFF,
    hasBlock: true,
    checks: [],
    source: 'handoff',
  });
});

test('a handoff that predates the block is a result, not a failure', async () => {
  const bare = DEFECT_HANDOFF.replace('---\nverify: []\n---\n\n', '');
  seed({ handoff: bare });
  assert.deepEqual(await readVerifyBlock({ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN }), {
    handoff: bare,
    hasBlock: false,
    checks: [],
    source: 'generated',
  });
});

test('a block Steward would not have written is refused, and a missing handoff too', async () => {
  seed({ handoff: DEFECT_HANDOFF.replace('verify: []', BLOCK.replace(ORIGIN, 'https://example.com')) });
  const invalid = await failure(readVerifyBlock({ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN }));
  assert.equal(invalid.type, 'VerifyBlockInvalid');
  assert.equal(invalid.nonRetryable, true);
  assert.match(invalid.message, /not the production origin/);

  const missing = await failure(readVerifyBlock({ ...{ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN }, handoffPath: 'sites/mattpyle-com/handoffs/none.md' }));
  assert.equal(missing.type, 'HandoffMissing');
});

/** The finding with a `verify` key of its own, set after its `status`. */
const withOwnBlock = (block: string) => FIXING.replace('status: fixing', `status: fixing\n${block}`);

test("the finding's own block wins: its checks run, and the handoff is not read", async () => {
  const two = [BLOCK, `  - url: ${ORIGIN}/scorecard/`, '    kind: status', '    expect: 200'].join('\n');
  // The handoff's block would be refused, and the path given is not even there.
  seed({ handoff: DEFECT_HANDOFF.replace('verify: []', BLOCK.replace(ORIGIN, 'https://example.com')) });
  const read = await readVerifyBlock({ ...{ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN }, findingText: withOwnBlock(two), handoffPath: 'sites/mattpyle-com/handoffs/none.md' });
  assert.deepEqual(read, {
    handoff: null,
    hasBlock: true,
    checks: [
      { url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { count: 0, of: '100/100 (Fail)' } },
      { url: `${ORIGIN}/scorecard/`, kind: 'status', expect: 200 },
    ],
    source: 'finding',
  });
});

test("a finding's empty block is the finder's verdict: no checks, and no fallback to the handoff", async () => {
  seed({ handoff: DEFECT_HANDOFF.replace('verify: []', BLOCK) });
  assert.deepEqual(await readVerifyBlock({ ...{ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN }, findingText: withOwnBlock('verify: []') }), {
    handoff: null,
    hasBlock: true,
    checks: [],
    source: 'finding',
  });
});

test("an invalid block on the finding fails naming the finding, and never falls back to the handoff's", async () => {
  seed({ handoff: DEFECT_HANDOFF.replace('verify: []', BLOCK) });
  for (const bad of [BLOCK.replace('kind: text', 'kind: grep'), 'verify:', 'verify: {url: x}']) {
    const invalid = await failure(readVerifyBlock({ ...{ repo: REPO, findingPath: FINDING, findingText: FIXING, handoffPath: HANDOFF, origin: ORIGIN }, findingText: withOwnBlock(bad) }));
    assert.equal(invalid.type, 'VerifyBlockInvalid');
    assert.equal(invalid.nonRetryable, true);
    assert.ok(invalid.message.startsWith(`The verify block in ${FINDING} was refused: `), invalid.message);
  }
});

// ---------------------------------------------------------------------------
// writeFindingVerification
// ---------------------------------------------------------------------------

test('a pass writes resolved, resolved_run and the section into the file, and resolved into the index line', async () => {
  const gh = seed();
  const result = await writeFindingVerification(input('resolved'));

  const text = gh.file('main', FINDING)!.text;
  const { data } = parseFrontmatter(text);
  assert.equal(data.status, 'resolved');
  assert.equal(data.resolved_run, '2026-10-13T0412Z');
  assert.equal(data.verdict_source, 'cli', 'the verdict fields are untouched');
  assert.match(text, /## Verification\n\nSteward ran this finding's checks against production at 2026-10-13T04:12:33\.527Z\. Outcome: resolved\./);
  assert.match(text, /Measured: 0 occurrences\./);
  assert.equal(
    gh.file('main', INDEX)!.text.split('\n')[4],
    `${DEFECT_KEY} | resolved | defect | defect-hunt | A row reads "100/100 (Fail)" | Approved by Matt.`,
  );
  assert.ok(result.findingCommitSha && result.indexCommitSha);
  assert.equal(result.commitSha, result.indexCommitSha);
});

test('a fail writes reopened with both values, and no resolved_run', async () => {
  const gh = seed();
  await writeFindingVerification(input('reopened'));
  const text = gh.file('main', FINDING)!.text;
  const { data } = parseFrontmatter(text);
  assert.equal(data.status, 'reopened');
  assert.equal(data.resolved_run, null);
  assert.match(text, /1\. Fail, `text` on https:\/\/www\.mattpyle\.com\/scorecard\/\. Expected: 0 occurrences of "100\/100 \(Fail\)"\. Measured: 2 occurrences\./);
  assert.match(gh.file('main', INDEX)!.text, new RegExp(`${DEFECT_KEY} \\| reopened \\|`));
});

test('a second write of the same result makes no commit', async () => {
  const gh = seed();
  await writeFindingVerification(input('resolved'));
  const puts = gh.calls.filter((call) => call.startsWith('PUT')).length;
  const again = await writeFindingVerification(input('resolved'));
  assert.deepEqual(again, { findingCommitSha: null, indexCommitSha: null, commitSha: null });
  assert.equal(gh.calls.filter((call) => call.startsWith('PUT')).length, puts);
});

test('a finding that is not fixing is not overruled', async () => {
  for (const status of ['approved', 'rejected', 'resolved']) {
    const gh = seed({ finding: FIXING_FINDING.replace('status: fixing', `status: ${status}`) });
    const err = await failure(writeFindingVerification(input('reopened')));
    assert.equal(err.type, 'FindingMoved');
    assert.equal(err.nonRetryable, true);
    assert.equal(gh.calls.filter((call) => call.startsWith('PUT')).length, 0, status);
    gh.restore();
  }
  // A finding another run resolved is not this run's retry either.
  const gh = seed();
  await writeFindingVerification(input('resolved'));
  const other = input('resolved');
  other.verification.workflowId = verifyWorkflowId('mattpyle-com', DEFECT_KEY, '2026-10-14T00:00:00.000Z');
  assert.equal((await failure(writeFindingVerification(other))).type, 'FindingMoved');
  gh.restore();
  fake = undefined;
});

test('a missing finding file is a non-retryable failure', async () => {
  seed();
  const err = await failure(writeFindingVerification(input('resolved', { findingPath: 'sites/mattpyle-com/findings/none.md' })));
  assert.equal(err.type, 'FindingMissing');
});

// ---------------------------------------------------------------------------
// runFindingChecks
// ---------------------------------------------------------------------------

test('the check run reports each row and whether all passed, and a failed row is not a failure', async () => {
  const pages: Record<string, string> = {
    [`${ORIGIN}/scorecard/`]: '<p>Accessibility: 100/100, 1 axe violation (Fail)</p>',
    [`${ORIGIN}/about/`]: '<p>100/100 (Fail)</p>',
  };
  const runner = {
    fetch: (async (url: string | URL | Request) =>
      new Response(pages[String(url)] ?? 'gone', { status: pages[String(url)] ? 200 : 404 })) as typeof fetch,
  };
  const pass = await runFindingChecks(
    { key: DEFECT_KEY, checks: [{ url: `${ORIGIN}/scorecard/`, kind: 'text', expect: { count: 0, of: '100/100 (Fail)' } }] },
    runner,
  );
  assert.equal(pass.passed, true);
  assert.equal(pass.results[0].measured, '0 occurrences');
  assert.match(pass.ranAt, /^\d{4}-\d{2}-\d{2}T/);

  const fail = await runFindingChecks(
    {
      key: DEFECT_KEY,
      checks: [
        { url: `${ORIGIN}/scorecard/`, kind: 'status', expect: 200 },
        { url: `${ORIGIN}/about/`, kind: 'text', expect: { count: 0, of: '100/100 (Fail)' } },
      ],
    },
    runner,
  );
  assert.equal(fail.passed, false);
  assert.deepEqual(fail.results.map((row) => [row.n, row.pass, row.measured]), [
    [1, true, 'status 200'],
    [2, false, '1 occurrences'],
  ]);
});

test('production answering 5xx is a retryable failure, never a reopened finding', async () => {
  const runner = { fetch: (async () => new Response('deploying', { status: 503 })) as typeof fetch };
  await assert.rejects(
    runFindingChecks({ key: DEFECT_KEY, checks: [{ url: `${ORIGIN}/`, kind: 'text', expect: { contains: 'Matt' } }] }, runner),
    (err: Error) => err.name === 'CheckUnavailable' && !(err instanceof ApplicationFailure),
  );
});
