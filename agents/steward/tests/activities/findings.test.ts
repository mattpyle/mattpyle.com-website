import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import {
  listSites,
  readFinding,
  readFindingsIndex,
  writeFindingVerdict,
  type WriteFindingVerdictInput,
} from '../../src/activities/findings.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';

/**
 * The findings activities against the fake GitHub, seeded with the findings
 * store's layout on `main`. What is asserted is the two-writer contract
 * (design decision 19): the write changes the four verdict fields and the
 * index line and nothing else, a concurrent push surfaces as a retryable
 * failure, and a missing file as a permanent one.
 */

const REPO = 'mattpyle/argus';
const KEY = 'ux-portrait-tucks-under-sticky-header--about';
const FINDING = `sites/mattpyle-com/findings/${KEY}.md`;
const INDEX = 'sites/mattpyle-com/findings/INDEX.md';

const FINDING_TEXT = [
  '---',
  `key: ${KEY}`,
  'status: proposed',
  'type: ux',
  'priority: low',
  'source: argus',
  'last_run: 2026-09-12T0559Z',
  'verdict_reason:',
  'verdict_at:',
  'verdict_source:',
  'resolved_run:',
  '---',
  '',
  '# On /about, the sticky portrait rail sits 32px behind the sticky header',
  '',
  'Body text | with a pipe, owned by Argus.',
  '',
].join('\n');

const INDEX_TEXT = [
  '# Findings index',
  '',
  'One line per finding, maintained by Argus: `key | status | title | verdict reason`.',
  '',
  'ux-no-direct-contact-or-resume--about | approved | /about has no direct contact method | Fair finding.',
  `${KEY} | proposed | On /about, the sticky portrait rail sits 32px behind the sticky header | `,
  '',
].join('\n');

let fake: FakeGitHub | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function seed(extra: Record<string, string> = {}): FakeGitHub {
  fake = installFakeGitHub({
    defaultBranch: 'main',
    seed: {
      [FINDING]: FINDING_TEXT,
      [INDEX]: INDEX_TEXT,
      'sites/temporal-io/config.yaml': 'site: {}\n',
      'sites/README.md': 'not a site\n',
      ...extra,
    },
  });
  return fake;
}

function input(overrides: Partial<WriteFindingVerdictInput> = {}): WriteFindingVerdictInput {
  return {
    repo: REPO,
    site: 'mattpyle-com',
    key: KEY,
    findingPath: FINDING,
    indexPath: INDEX,
    status: 'rejected',
    reason: 'Intended: the rail sits under the header by design: see the 2026-08 note.',
    at: '2026-09-12T18:00:00.000Z',
    source: 'cli',
    ...overrides,
  };
}

test('listSites names the site folders and skips files', async () => {
  const gh = seed();
  assert.deepEqual(await listSites(REPO), ['mattpyle-com', 'temporal-io']);
  assert.ok(gh.repos.every((repo) => repo === REPO), 'every read addressed the findings repository');
});

test('readFindingsIndex parses key and status by position, and a skeleton site has none', async () => {
  seed();
  const lines = await readFindingsIndex(REPO, 'mattpyle-com');
  assert.deepEqual(
    lines.map((l) => [l.key, l.status, l.reason]),
    [
      ['ux-no-direct-contact-or-resume--about', 'approved', 'Fair finding.'],
      [KEY, 'proposed', ''],
    ],
  );
  assert.deepEqual(await readFindingsIndex(REPO, 'temporal-io'), []);
});

test('readFinding returns the text, the blob sha and the parsed frontmatter', async () => {
  seed();
  const file = await readFinding(REPO, FINDING);
  assert.equal(file.data.status, 'proposed');
  assert.equal(file.text, FINDING_TEXT);
  assert.match(file.sha, /^sha-/);
});

test('the write changes the four verdict fields and the index line, and nothing else', async () => {
  const gh = seed();
  const result = await writeFindingVerdict(input());

  const written = gh.file('main', FINDING)!.text;
  const { data, content } = parseFrontmatter(written);
  assert.equal(data.status, 'rejected');
  assert.equal(data.verdict_reason, input().reason);
  assert.equal(data.verdict_source, 'cli');
  assert.ok(data.verdict_at, 'verdict_at is set');
  assert.equal(content, parseFrontmatter(FINDING_TEXT).content, 'the body is untouched');

  // Every line that is not one of the four is byte-identical.
  const before = FINDING_TEXT.split('\n');
  const after = written.split('\n');
  assert.equal(after.length, before.length);
  const changed = before
    .map((line, i) => (line === after[i] ? null : line.split(':')[0]))
    .filter(Boolean);
  assert.deepEqual(changed, ['status', 'verdict_reason', 'verdict_at', 'verdict_source']);

  const index = gh.file('main', INDEX)!.text.split('\n');
  assert.equal(
    index[5],
    `${KEY} | rejected | On /about, the sticky portrait rail sits 32px behind the sticky header | ${input().reason}`,
  );
  assert.equal(index[4], INDEX_TEXT.split('\n')[4], 'the other finding line is untouched');

  assert.ok(result.findingCommitSha && result.indexCommitSha);
  assert.equal(result.commitSha, result.indexCommitSha);
  assert.ok(gh.repos.every((repo) => repo === REPO));
});

test('a second write of the same verdict makes no commit', async () => {
  const gh = seed();
  await writeFindingVerdict(input());
  const puts = () => gh.calls.filter((c) => c.startsWith('PUT')).length;
  const afterFirst = puts();
  const again = await writeFindingVerdict(input());
  assert.equal(puts(), afterFirst);
  assert.equal(again.commitSha, null);
});

test('a concurrent push between read and write is a retryable failure', async () => {
  const gh = seed();
  const fetchWithPush = globalThis.fetch;
  // Argus pushes to the finding right after the activity reads it.
  globalThis.fetch = (async (req: any, init?: RequestInit) => {
    const res = await fetchWithPush(req, init);
    const url = String(typeof req === 'string' ? req : req.url);
    if ((init?.method ?? 'GET') === 'GET' && url.includes(encodeURI(FINDING))) {
      const tree = gh.branches.get('main')!;
      const text = FINDING_TEXT.replace('last_run: 2026-09-12T0559Z', 'last_run: 2026-09-12T0730Z');
      tree.set(FINDING, { text, sha: 'sha-argus-push' });
    }
    return res;
  }) as typeof fetch;

  await assert.rejects(writeFindingVerdict(input()), (err: unknown) => {
    assert.ok(err instanceof Error);
    const nonRetryable = err instanceof ApplicationFailure && err.nonRetryable;
    assert.equal(nonRetryable, false, 'a sha mismatch must be retried from a fresh read');
    assert.match(err.message, /409/);
    return true;
  });
  // Argus's change survived.
  assert.match(gh.file('main', FINDING)!.text, /last_run: 2026-09-12T0730Z/);
});

test('the retry after a concurrent push applies the verdict on top of Argus', async () => {
  const gh = seed();
  const tree = gh.branches.get('main')!;
  const pushed = FINDING_TEXT.replace('last_run: 2026-09-12T0559Z', 'last_run: 2026-09-12T0730Z');
  tree.set(FINDING, { text: pushed, sha: 'sha-argus-push' });
  await writeFindingVerdict(input({ status: 'approved', reason: 'Real.' }));
  const text = gh.file('main', FINDING)!.text;
  assert.match(text, /last_run: 2026-09-12T0730Z/);
  assert.match(text, /^status: approved$/m);
});

test('a missing finding file is a non-retryable failure', async () => {
  seed();
  await assert.rejects(
    writeFindingVerdict(input({ findingPath: 'sites/mattpyle-com/findings/gone.md', key: 'gone' })),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationFailure);
      assert.equal(err.nonRetryable, true);
      assert.equal(err.type, 'FindingMissing');
      return true;
    },
  );
});

test('an index with no line for the key is a non-retryable failure', async () => {
  seed({ [INDEX]: '# Findings index\n' });
  await assert.rejects(writeFindingVerdict(input()), (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure);
    assert.equal(err.nonRetryable, true);
    assert.equal(err.type, 'FindingMissing');
    return true;
  });
});
