import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseFindingKey, resolveFinding, resolveFindingKey } from '../../src/lib/finding-key.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { FULL, SHORT, TWINS, findingStore } from '../helpers/finding-key-fixtures.js';

const REPO = 'mattpyle/argus';
const SITE = 'mattpyle-com';

let github: FakeGitHub | undefined;
afterEach(() => {
  github?.restore();
  github = undefined;
});

function install(): FakeGitHub {
  github = installFakeGitHub({ seed: findingStore(), defaultBranch: 'main' });
  return github;
}

const query = (key: string, site = SITE) => ({ repo: REPO, site, key });

test('a full key is returned as typed, with no read', async () => {
  const gh = install();
  assert.deepEqual(await resolveFindingKey(query(FULL)), { site: SITE, key: FULL });
  assert.deepEqual(gh.calls, []);
});

test('a short key is found in one read of the findings folder', async () => {
  const gh = install();
  assert.deepEqual(await resolveFindingKey(query(SHORT)), { site: SITE, key: FULL });
  assert.deepEqual(gh.calls, ['POST /graphql']);
});

test('a refused folder query falls back to the index and each file it lists', async () => {
  const gh = install();
  gh.tree.refuse = 'Resource not accessible by integration';
  assert.deepEqual(await resolveFindingKey(query(SHORT)), { site: SITE, key: FULL });
  assert.deepEqual(
    [...gh.calls].sort(),
    ['POST /graphql', ...['INDEX', FULL, ...TWINS].map((name) => `GET /contents/sites/${SITE}/findings/${name}.md`)].sort(),
  );
  await assert.rejects(resolveFindingKey(query('MP-902')), /MP-902 matches 2 findings/);
});

test('a truncated file is read on its own, and no other', async () => {
  const gh = install();
  const path = `sites/${SITE}/findings/${FULL}.md`;
  gh.tree.truncated.add(path);
  assert.deepEqual(await resolveFindingKey(query(SHORT)), { site: SITE, key: FULL });
  assert.deepEqual(gh.calls, ['POST /graphql', `GET /contents/${path}`]);
});

test('a short key resolves to its finding, in either case', async () => {
  install();
  assert.deepEqual(await resolveFindingKey(query(SHORT)), { site: SITE, key: FULL });
  assert.deepEqual(await resolveFindingKey(query(SHORT.toLowerCase())), { site: SITE, key: FULL });
  const found = await resolveFinding(query('mp-901'));
  assert.equal(found.keyShort, SHORT);
  assert.equal(found.findingPath, `sites/${SITE}/findings/${FULL}.md`);
  assert.equal(found.data.status, 'resolved');
});

test('a full key that also needs its short key costs the one read of its file', async () => {
  const gh = install();
  assert.equal((await resolveFinding(query(FULL))).keyShort, SHORT);
  assert.deepEqual(gh.calls, [`GET /contents/sites/${SITE}/findings/${FULL}.md`]);
});

test('an unknown short key names the key and the site searched', async () => {
  install();
  await assert.rejects(resolveFindingKey(query('mp-999')), /No finding with key MP-999 in site mattpyle-com\./);
  await assert.rejects(resolveFindingKey(query(SHORT, 'temporal-io')), /No finding with key MP-901 in site temporal-io\./);
});

test('a short key two findings hold is refused, naming both', async () => {
  install();
  await assert.rejects(
    resolveFindingKey(query('MP-902')),
    new RegExp(`MP-902 matches 2 findings in site ${SITE}: ${TWINS.join(', ')}`),
  );
});

test('only the two forms parse', () => {
  assert.deepEqual(parseFindingKey(' mp-187 '), { form: 'short', keyShort: 'MP-187' });
  assert.deepEqual(parseFindingKey(FULL), { form: 'full', key: FULL });
  for (const bad of ['', '../../etc', 'a/b', 'Not-A-Key', 'MP_187']) assert.equal(parseFindingKey(bad), undefined, bad);
});
