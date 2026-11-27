import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING } from '../helpers/finding-fixtures.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { hasRecheckSection, isArgusRunId, setFindingLookResolved } from '../../src/lib/finding-look.js';
import { writeFindingLook, type WriteFindingLookInput } from '../../src/activities/findings-look.js';
import { watchFinding } from '../../src/activities/findings-watch.js';

/**
 * The look's write (stage 5) against the fake GitHub: the five cases of the
 * design's section 5, the moved branch, and `watchFinding` reading
 * `looked_fixed` when the Update never came.
 */

const REPO = 'mattpyle/argus';
const SITE = 'temporal-io';
const KEY = 'look-test--sitewide';
const WORKFLOW_ID = `finding/${SITE}/${KEY}`;
const FINDING = `sites/${SITE}/findings/${KEY}.md`;
const INDEX = `sites/${SITE}/findings/INDEX.md`;
const CONFIG = `sites/${SITE}/config.yaml`;
const RUN = '2026-11-26T0830Z';
const WATCHING = ['site:', '  url: https://temporal.io', '  stop_after: verdict', '  after_verdict: watch', ''].join('\n');
const INDEX_TEXT = ['# Findings index', '', `${KEY} | approved | defect | defect-hunt | A label | Approved.`, ''].join('\n');
const RECHECK = [`## Re-check ${RUN}`, '', '- URL: https://temporal.io/pricing', '- Observed: the defect is gone.', ''].join('\n');

/** The defect fixture on temporal.io: no checks, Argus's body appended, `looked_fixed` when asked. */
function finding(opts: { recheck?: boolean; looked?: string | null; status?: string } = {}): string {
  let text = DEFECT_FINDING.replace(/^key: .*$/m, `key: ${KEY}`);
  if (opts.status) text = text.replace(/^status: .*$/m, `status: ${opts.status}`);
  if (opts.looked) text = text.replace('references: []\n---', `references: []\nlooked_fixed: ${opts.looked}\n---`);
  if (opts.recheck !== false) text = `${text.trimEnd()}\n\n${RECHECK}`;
  return text;
}

let fake: FakeGitHub | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function seed(file: string | null): FakeGitHub {
  const seeded: Record<string, string> = { [INDEX]: INDEX_TEXT, [CONFIG]: WATCHING };
  if (file !== null) seeded[FINDING] = file;
  fake = installFakeGitHub({ defaultBranch: 'main', seed: seeded });
  return fake;
}

const INPUT: WriteFindingLookInput = { repo: REPO, site: SITE, key: KEY, findingPath: FINDING, indexPath: INDEX, run: RUN, by: WORKFLOW_ID };
const data = (f: FakeGitHub) => parseFrontmatter(f.file('main', FINDING)!.text).data as Record<string, unknown>;

async function refusal(attempt: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await attempt;
  } catch (err) {
    assert.ok(err instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(err)}`);
    return err;
  }
  assert.fail('the write did not refuse');
}

test('an Argus run identifier is the UTC minute and nothing else', () => {
  assert.ok(isArgusRunId(RUN));
  for (const bad of ['2026-11-26', '2026-11-26T08:30Z', '2026-13-26T0830Z', '2026-11-26T2460Z', `${RUN}\nstatus: rejected`, ` ${RUN}`, 20261126, null]) {
    assert.equal(isArgusRunId(bad), false, `${JSON.stringify(bad)} is refused`);
  }
  assert.ok(hasRecheckSection(`x\n## Re-check ${RUN} (held finding, re-checked once)\n`, RUN), 'a note after the run is allowed');
  assert.equal(hasRecheckSection(`x\n## Re-check ${RUN}0\n`, RUN), false);
  assert.throws(() => setFindingLookResolved(finding(), 'not-a-run'));
});

test('approved with its Re-check section: status, resolved_run, resolved_by and the index line in one commit, with no workflow ID in the file', async () => {
  const f = seed(finding());
  const before = f.history('main').length;
  const out = await writeFindingLook(INPUT);
  assert.equal(out.by, 'look');
  assert.equal(out.resolvedRun, RUN);
  assert.ok(out.commitSha);
  const fm = data(f);
  assert.equal(fm.status, 'resolved');
  assert.equal(String(fm.resolved_run), RUN);
  assert.equal(fm.resolved_by, 'review');
  assert.match(f.file('main', INDEX)!.text, new RegExp(`${KEY} \\| resolved \\|`));
  assert.equal(f.history('main').length, before + 1, 'one commit for both files');
  assert.equal(f.history('main').at(-1), `look ${KEY}: resolved by Argus run ${RUN} (${WORKFLOW_ID})`);
  assert.equal(f.file('main', FINDING)!.text.includes(WORKFLOW_ID), false, 'the file names no workflow');
  assert.ok(f.file('main', FINDING)!.text.includes(RECHECK.trim()), "Argus's body is kept");
});

test('approved with no Re-check section for the run: refused LookBodyMissing, nothing written', async () => {
  const f = seed(finding({ recheck: false }));
  const before = f.history('main').length;
  const err = await refusal(writeFindingLook(INPUT));
  assert.equal(err.type, 'LookBodyMissing');
  assert.equal(err.nonRetryable, true);
  assert.match(err.message, /body must land before the look/);
  assert.equal(f.history('main').length, before);
});

test('a file this look already resolved: success, nothing written', async () => {
  const f = seed(finding());
  await writeFindingLook(INPUT);
  const before = f.history('main').length;
  const again = await writeFindingLook(INPUT);
  assert.deepEqual(again, { by: 'look', resolvedRun: RUN, commitSha: null });
  assert.equal(f.history('main').length, before);
});

test("a file the run's own watch resolved: success by watch; resolved by anyone else: success by elsewhere", async () => {
  const watched = finding({ status: 'resolved' }).replace('resolved_run:', 'resolved_run: 2026-11-26T1320Z') + `\n## Verification\n\nResolved by ${WORKFLOW_ID}.\n`;
  let f = seed(watched);
  assert.deepEqual(await writeFindingLook(INPUT), { by: 'watch', resolvedRun: '2026-11-26T1320Z', commitSha: null });
  f.restore();
  f = seed(finding({ status: 'resolved' }).replace('resolved_run:', 'resolved_run: 2026-11-20T0830Z'));
  assert.deepEqual(await writeFindingLook(INPUT), { by: 'elsewhere', resolvedRun: '2026-11-20T0830Z', commitSha: null });
});

test('any other status, or no file: refused as moved', async () => {
  seed(finding({ status: 'rejected' }));
  assert.equal((await refusal(writeFindingLook(INPUT))).type, 'FindingMoved');
  fake!.restore();
  seed(finding().replace('resolved_run:', 'resolved_run: 2026-11-20T0830Z'));
  assert.equal((await refusal(writeFindingLook(INPUT))).type, 'FindingMoved', 'approved with a resolved_run');
  fake!.restore();
  seed(null);
  assert.equal((await refusal(writeFindingLook(INPUT))).type, 'FindingMissing');
});

test('a run that is not an Argus run identifier is refused before any read', async () => {
  const f = seed(finding());
  const err = await refusal(writeFindingLook({ ...INPUT, run: `${RUN}\nstatus: rejected` }));
  assert.equal(err.type, 'BadInput');
  assert.equal(f.calls.length, 0);
});

test('a branch that moves under the write fails BranchMoved, retryable, and the next attempt builds on the new head', async () => {
  const f = seed(finding());
  const real = globalThis.fetch;
  let moved = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!moved && (init?.method ?? 'GET').toUpperCase() === 'PATCH' && String(url).includes('/git/refs/heads/main')) {
      moved = true;
      // The watch's live_on lands first, as order 3 of the design's table.
      f.push('main', FINDING, finding().replace('references: []', 'references: []\nlive_on: 2026-11-26'), 'watch: live on');
    }
    return real(url as string, init);
  }) as typeof fetch;
  try {
    const err = await refusal(writeFindingLook(INPUT));
    assert.equal(err.type, 'BranchMoved');
    assert.equal(err.nonRetryable, false);
    const out = await writeFindingLook(INPUT);
    assert.equal(out.by, 'look');
    assert.match(f.file('main', FINDING)!.text, /^live_on: 2026-11-26$/m, "the watch's write is kept");
    assert.equal(data(f).status, 'resolved');
  } finally {
    globalThis.fetch = real;
  }
});

function watch() {
  const env = new MockActivityEnvironment({ workflowExecution: { workflowId: WORKFLOW_ID, runId: 'run-1' } });
  return env.run(() => watchFinding({ repo: REPO, site: SITE, key: KEY, findingPath: FINDING })) as ReturnType<typeof watchFinding>;
}

test('watchFinding takes looked_fixed with its Re-check section as the look: it resolves the file and runs no check', async () => {
  // No verify block: without the field the attempt would fail NoChecks.
  const f = seed(finding({ looked: RUN }));
  const out = await watch();
  assert.equal(out.outcome, 'resolved');
  assert.ok(out.outcome === 'resolved' && out.look === RUN && out.commitSha);
  assert.equal(data(f).status, 'resolved');
  assert.equal(data(f).resolved_by, 'review');
  assert.equal(f.history('main').at(-1), `look ${KEY}: resolved by looked_fixed ${RUN} (${WORKFLOW_ID})`);
  // A result lost after the commit reads as the same look on the next attempt.
  const again = await watch();
  assert.deepEqual(again, { outcome: 'resolved', commitSha: null, rows: [], at: null, look: RUN });
});

test('watchFinding ignores a looked_fixed that is not a run identifier, or has no Re-check section', async () => {
  seed(finding({ looked: '"2026-11-26T0830Z extra"' }));
  assert.equal((await refusal(watch())).type, 'NoChecks');
  fake!.restore();
  const f = seed(finding({ looked: RUN, recheck: false }));
  assert.equal((await refusal(watch())).type, 'NoChecks');
  assert.equal(data(f).status, 'approved');
});
