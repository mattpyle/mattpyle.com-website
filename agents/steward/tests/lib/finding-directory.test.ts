import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { gh } from '../../src/lib/github.js';
import { createFindingDirectory, findingMeta } from '../../src/lib/finding-directory.js';
import { parseFindingRef, type FindingRef } from '../../src/lib/finding-ids.js';

/**
 * A short id to its site and key, read through Steward's own GitHub client
 * against the fake: what resolves, what does not, and what each lookup costs
 * in calls.
 */

const REPO = 'mattpyle/argus';

function finding(key: string, short: string | null, titleShort: string | null, h1 = 'The long title of the finding'): string {
  return [
    '---',
    `key: ${key}`,
    ...(short ? [`key_short: ${short}`] : []),
    ...(titleShort ? [`title_short: "${titleShort}"`] : []),
    'status: proposed',
    '---',
    '',
    `# ${h1}`,
    '',
    'Body.',
  ].join('\n');
}

const SEED: Record<string, string> = {
  'sites/mattpyle-com/config.yaml': 'auto_fix: true\n',
  'sites/mattpyle-com/findings/INDEX.md': '# Findings index\n',
  'sites/mattpyle-com/findings/README.md': '# Findings\n',
  'sites/mattpyle-com/findings/content-first-post--hello-world.md': finding('content-first-post--hello-world', 'MP-121', 'Hello World description calls it the first post'),
  'sites/mattpyle-com/findings/ux-rail-scrollbar--writing.md': finding('ux-rail-scrollbar--writing', 'MP-7', null, 'Sticky rail shows a phantom scrollbar'),
  'sites/mattpyle-com/findings/shared-key--home.md': finding('shared-key--home', 'MP-9', 'Shared on mattpyle.com'),
  'sites/temporal-io/config.yaml': 'stop_after: verdict\n',
  'sites/temporal-io/findings/INDEX.md': '# Findings index\n',
  'sites/temporal-io/findings/content-credit-amount--home.md': finding('content-credit-amount--home', 'TI-4', 'Homepage credit amount differs'),
  'sites/temporal-io/findings/shared-key--home.md': finding('shared-key--home', 'TI-5', 'Shared on temporal.io'),
  'sites/temporal-io/handoffs/content-credit-amount--home.md': 'not a finding',
  'runs/2026-11-21.md': 'not a finding',
};

let github: FakeGitHub | undefined;
afterEach(() => {
  github?.restore();
  github = undefined;
});

function setup(seed: Record<string, string> = SEED) {
  github = installFakeGitHub({ seed, defaultBranch: 'main' });
  return { github, directory: createFindingDirectory({ repo: REPO, ghJson: (pathname) => gh(pathname) }) };
}

const refs = (...typed: string[]): FindingRef[] => typed.map((each) => parseFindingRef(each) as FindingRef);
const blobReads = (g: FakeGitHub) => g.calls.filter((call) => call.startsWith('GET /git/blobs/')).length;
const treeReads = (g: FakeGitHub) => g.calls.filter((call) => call.startsWith('GET /git/trees/')).length;

test('a short id resolves to its site, key and short title, in any spelling', async () => {
  const { directory } = setup();
  const [upper, lower, other] = await directory.lookup(refs('MP-121', 'mp7', 'ti-4'));
  assert.deepEqual('found' in upper && upper.found, {
    site: 'mattpyle-com',
    key: 'content-first-post--hello-world',
    keyShort: 'MP-121',
    title: 'Hello World description calls it the first post',
    autoFix: true,
  });
  // No `title_short`: the file's H1 stands in.
  assert.deepEqual('found' in lower && lower.found, {
    site: 'mattpyle-com',
    key: 'ux-rail-scrollbar--writing',
    keyShort: 'MP-7',
    title: 'Sticky rail shows a phantom scrollbar',
    autoFix: true,
  });
  assert.equal('found' in other && other.found.site, 'temporal-io');
  // temporal-io's config.yaml sets no auto_fix.
  assert.equal('found' in other && other.found.autoFix, false);
});

test('an id no finding carries is missing', async () => {
  const { directory } = setup();
  const [short, key] = await directory.lookup(refs('MP-999', 'no-such-finding--page'));
  assert.ok('missing' in short);
  assert.ok('missing' in key);
});

test('a full key resolves; one two sites share is ambiguous until the site is named', async () => {
  const { directory } = setup();
  const [plain, shared, sited] = await directory.lookup(refs('content-credit-amount--home', 'shared-key--home', 'temporal-io/shared-key--home'));
  assert.equal('found' in plain && plain.found.keyShort, 'TI-4');
  assert.deepEqual('ambiguous' in shared && shared.ambiguous.map((entry) => entry.site).sort(), ['mattpyle-com', 'temporal-io']);
  assert.equal('found' in sited && sited.found.keyShort, 'TI-5');
});

test('a short id two files carry is ambiguous', async () => {
  const { directory } = setup({
    ...SEED,
    'sites/temporal-io/findings/duplicate--page.md': finding('duplicate--page', 'MP-121', 'A duplicate'),
  });
  const [lookup] = await directory.lookup(refs('MP-121'));
  assert.equal('ambiguous' in lookup && lookup.ambiguous.length, 2);
});

test('the first short-id lookup reads every finding file once; the next reads none', async () => {
  const { github: g, directory } = setup();
  await directory.lookup(refs('MP-121'));
  // Five finding files and the found finding's site config; INDEX.md, README.md, handoffs and runs are not read.
  assert.equal(treeReads(g), 1);
  assert.equal(blobReads(g), 6);
  await directory.lookup(refs('MP-121', 'MP-7'));
  assert.equal(treeReads(g), 2);
  assert.equal(blobReads(g), 6);
});

test('after a file changes, the next lookup reads that one file', async () => {
  const { github: g, directory } = setup();
  await directory.lookup(refs('MP-121'));
  const before = blobReads(g);
  // A new blob sha, as a commit to the file gives it.
  g.branches.get('main')?.set('sites/mattpyle-com/findings/ux-rail-scrollbar--writing.md', {
    text: finding('ux-rail-scrollbar--writing', 'MP-7', 'Rail scrollbar'),
    sha: 'rewritten-blob',
  });
  const [lookup] = await directory.lookup(refs('MP-7'));
  assert.equal(blobReads(g) - before, 1);
  assert.equal('found' in lookup && lookup.found.title, 'Rail scrollbar');
});

test("a lookup of full keys alone reads only the files they name, and their site's config", async () => {
  const { github: g, directory } = setup();
  await directory.lookup(refs('content-credit-amount--home'));
  assert.equal(blobReads(g), 2);
});

test('every read goes to the findings repository', async () => {
  const { github: g, directory } = setup();
  await directory.lookup(refs('MP-121'));
  assert.deepEqual([...new Set(g.repos)], [REPO]);
  assert.ok(g.calls.every((call) => call.startsWith('GET ')));
});

test('a truncated tree is an error, not a missing finding', async () => {
  const directory = createFindingDirectory({ repo: REPO, ghJson: async () => ({ truncated: true, tree: [] }) });
  await assert.rejects(directory.lookup(refs('MP-121')), /truncated/);
});

test('the short id in a file is normalized; a file with none has none', () => {
  assert.deepEqual(findingMeta(finding('a--b', 'mp-0012', 'T')), { keyShort: 'MP-12', title: 'T' });
  assert.deepEqual(findingMeta(finding('a--b', null, null, 'From the heading')), { keyShort: null, title: 'From the heading' });
});
