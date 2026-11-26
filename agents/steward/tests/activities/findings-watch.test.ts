import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';
import { DEFECT_FINDING } from '../helpers/finding-fixtures.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { CheckBroken } from '../../src/lib/verify-checks.js';
import {
  WATCH_MIN_GAP_MS,
  WATCH_SPREAD_SECONDS,
  watchFinding as watchFindingActivity,
  watchOffsetSeconds,
  watchRetryDelay,
  type WatchFindingDeps,
  type WatchFindingInput,
} from '../../src/activities/findings-watch.js';

/**
 * `watchFinding` (stage 4) against the fake GitHub, with a fetch in
 * production's place: each of its outcomes, the daily window, the moved
 * branch retried inside the attempt, and the heartbeat over the whole body.
 */

const REPO = 'mattpyle/argus';
const SITE = 'temporal-io';
const KEY = 'watch-test--sitewide';
const WORKFLOW_ID = `finding/${SITE}/${KEY}`;
const FINDING = `sites/${SITE}/findings/${KEY}.md`;
const INDEX = `sites/${SITE}/findings/INDEX.md`;
const CONFIG = `sites/${SITE}/config.yaml`;
const WATCHING = ['site:', '  url: https://temporal.io', '  hosts:', '    - docs.temporal.io', '  stop_after: verdict', '  after_verdict: watch', ''].join('\n');
const STOPPING = ['site:', '  url: https://temporal.io', '  stop_after: verdict', ''].join('\n');
const INDEX_TEXT = ['# Findings index', '', `${KEY} | approved | defect | defect-hunt | A label | Approved.`, ''].join('\n');
const NOW = Date.UTC(2026, 10, 25, 8, 0, 0);

const BLOCK = ['verify:', '  - url: https://temporal.io/pricing', '    kind: text', '    expect: {count: 0, of: "Contact sales"}'].join('\n');

/** The defect fixture moved to temporal.io, with a block (or none) in its frontmatter. */
function finding(block: string | null = BLOCK, over: (text: string) => string = (t) => t): string {
  const text = DEFECT_FINDING.replace(/^key: .*$/m, `key: ${KEY}`);
  const withBlock = block ? text.replace('references: []\n---', `references: []\n${block}\n---`) : text;
  return over(withBlock);
}

let fake: FakeGitHub | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function seed(files: { config?: string | null; finding?: string | null } = {}): FakeGitHub {
  const seeded: Record<string, string> = { [INDEX]: INDEX_TEXT };
  const config = files.config === undefined ? WATCHING : files.config;
  const file = files.finding === undefined ? finding() : files.finding;
  if (config !== null) seeded[CONFIG] = config;
  if (file !== null) seeded[FINDING] = file;
  fake = installFakeGitHub({ defaultBranch: 'main', seed: seeded });
  return fake;
}

/** Production, answering every URL with this body. */
function production(body: string): WatchFindingDeps['runner'] {
  return { fetch: (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch };
}

const INPUT: WatchFindingInput = { repo: REPO, site: SITE, key: KEY, findingPath: FINDING };

function run(deps: WatchFindingDeps = {}, heartbeats: unknown[] = []) {
  const env = new MockActivityEnvironment({ workflowExecution: { workflowId: WORKFLOW_ID, runId: 'run-1' } });
  env.on('heartbeat', (details: unknown) => heartbeats.push(details));
  return env.run(() => watchFindingActivity(INPUT, { now: () => NOW, ...deps })) as ReturnType<typeof watchFindingActivity>;
}

async function failure(attempt: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await attempt;
  } catch (err) {
    assert.ok(err instanceof ApplicationFailure, `expected an ApplicationFailure, got ${String(err)}`);
    return err;
  }
  assert.fail('the attempt did not fail');
}

const frontmatter = (f: FakeGitHub) => parseFrontmatter(f.file('main', FINDING)!.text).data as Record<string, unknown>;

test('the daily window is 13:20 UTC plus a hashed offset of 0 to 20 minutes, at least an hour away', () => {
  const offset = watchOffsetSeconds(KEY);
  assert.ok(offset >= 0 && offset < WATCH_SPREAD_SECONDS);
  assert.equal(watchOffsetSeconds(KEY), offset, 'the same key gets the same offset every day');
  assert.notEqual(watchOffsetSeconds('another--key'), offset);
  const window = Date.UTC(2026, 10, 25, 13, 20) + offset * 1000;
  // Early in the day: today's window.
  assert.equal(NOW + watchRetryDelay(NOW, KEY), window);
  // An attempt that ends inside the hour before its window waits for tomorrow's.
  const late = window - WATCH_MIN_GAP_MS + 1;
  assert.equal(late + watchRetryDelay(late, KEY), window + 24 * 60 * 60 * 1000);
  // After the window: tomorrow's.
  assert.equal(window + 60_000 + watchRetryDelay(window + 60_000, KEY), window + 24 * 60 * 60 * 1000);
  // Never more than a day and an hour away, which the policy's two-day maximum covers.
  for (let at = NOW; at < NOW + 2 * 86_400_000; at += 7 * 60_000) {
    const delay = watchRetryDelay(at, KEY);
    assert.ok(delay >= WATCH_MIN_GAP_MS && delay <= 25 * 60 * 60 * 1000, `delay ${delay} at ${new Date(at).toISOString()}`);
  }
});

test('every check passes: the file, its Verification and its index line are resolved in one commit that names the run', async () => {
  const f = seed();
  const heartbeats: unknown[] = [];
  const result = await run({ runner: production('<h1>Pricing</h1>') }, heartbeats);
  assert.equal(result.outcome, 'resolved');
  assert.ok(result.outcome === 'resolved' && result.commitSha);
  assert.equal(frontmatter(f).status, 'resolved');
  assert.ok(f.file('main', FINDING)!.text.includes(WORKFLOW_ID), 'the Verification names the run');
  assert.match(f.file('main', INDEX)!.text, new RegExp(`${KEY} \\| resolved`));
  assert.deepEqual(f.history('main'), ['seed', `watch ${KEY}: resolved (${WORKFLOW_ID})`]);
  assert.ok(heartbeats.includes(`watching ${KEY}`), 'the attempt heartbeats under its own name');

  // A lost result: the next attempt reads the file this run resolved, and answers resolved again.
  const again = await run({ runner: production('<h1>Pricing</h1>') });
  assert.equal(again.outcome, 'resolved');
  assert.equal(f.history('main').length, 2, 'nothing written twice');
});

test('a check fails: live_on is written by a commit that names the run, and the attempt fails StillPresent, benign, until the window', async () => {
  const f = seed();
  const err = await failure(run({ runner: production('<a>Contact sales</a>') }));
  assert.equal(err.type, 'StillPresent');
  assert.equal(err.nonRetryable, false);
  assert.equal(err.category, 'BENIGN');
  assert.equal(err.nextRetryDelay, watchRetryDelay(NOW, KEY));
  assert.match(err.message, /^Still present on 2026-11-25: check 1:/);
  assert.match(f.file('main', FINDING)!.text, /^live_on: 2026-11-25$/m);
  assert.match(f.file('main', FINDING)!.text, /^live_by: check$/m);
  assert.equal(frontmatter(f).status, 'approved');
  assert.deepEqual(f.history('main'), ['seed', `watch ${KEY}: live on 2026-11-25 (${WORKFLOW_ID})`]);
});

test('no checks fails NoChecks, benign, until the window, and writes nothing', async () => {
  const f = seed({ finding: finding(null) });
  const err = await failure(run());
  assert.equal(err.type, 'NoChecks');
  assert.equal(err.category, 'BENIGN');
  assert.equal(err.nextRetryDelay, watchRetryDelay(NOW, KEY));
  assert.deepEqual(f.history('main'), ['seed', ]);
});

test('a refused block, a broken check or a broken config fails ChecksUnreadable, not benign, until the window', async () => {
  seed({ finding: finding(BLOCK.replace('https://temporal.io/pricing', 'https://example.com/pricing')) });
  const refused = await failure(run());
  assert.equal(refused.type, 'ChecksUnreadable');
  assert.equal(refused.category, undefined);
  assert.equal(refused.nonRetryable, false);
  assert.equal(refused.nextRetryDelay, watchRetryDelay(NOW, KEY));
  assert.match(refused.message, /^The verify block was refused:/);

  fake?.restore();
  seed({ finding: finding(['verify:', '  - url: https://temporal.io/pricing', '    kind: js', '    expect: {js: "document.title", equals: "x"}'].join('\n')) });
  const broken = await failure(
    run({
      runner: {
        openProbe: async () => {
          throw new CheckBroken('the expression does not run');
        },
      },
    }),
  );
  assert.equal(broken.type, 'ChecksUnreadable', broken.message);
  assert.equal(broken.nonRetryable, false, 'nothing permanent leaves the attempt');

  fake?.restore();
  seed({ config: 'site:\n  stop_after: verdict\n  after_verdict: watch\n' });
  const config = await failure(run());
  assert.equal(config.type, 'ChecksUnreadable');
  assert.match(config.message, /^The site config does not read:/);
});

test('a site that no longer watches answers stopped, and so does a site with no config', async () => {
  seed({ config: STOPPING });
  assert.deepEqual(await run(), { outcome: 'stopped' });
  fake?.restore();
  seed({ config: null });
  assert.deepEqual(await run(), { outcome: 'stopped' });
});

test('a file decided elsewhere answers decided with its status, a missing file included', async () => {
  seed({ finding: finding(BLOCK, (t) => t.replace('status: approved', 'status: reopened')) });
  assert.deepEqual(await run(), { outcome: 'decided', status: 'reopened' });
  fake?.restore();
  seed({ finding: finding(BLOCK, (t) => t.replace('status: approved', 'status: resolved')) });
  assert.deepEqual(await run(), { outcome: 'decided', status: 'resolved' }, 'resolved by someone else: its file does not name this run');
  fake?.restore();
  seed({ finding: finding(BLOCK, (t) => t.replace('resolved_run:', 'resolved_run: 2026-11-20T0100Z')) });
  assert.deepEqual(await run(), { outcome: 'decided', status: 'approved' });
  fake?.restore();
  seed({ finding: null });
  assert.deepEqual(await run(), { outcome: 'decided', status: null });
});

test('production not answering is thrown as it is, so the policy retries it in 15 minutes', async () => {
  seed();
  let thrown: unknown;
  try {
    await run({ runner: { fetch: (async () => new Response('down', { status: 503 })) as typeof fetch } });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'the attempt failed');
  const delay = thrown instanceof ApplicationFailure ? thrown.nextRetryDelay : undefined;
  assert.equal(delay ?? undefined, undefined, 'no delay to the window');
  assert.ok(!(thrown instanceof ApplicationFailure && thrown.nonRetryable));
});

test('a branch that moves under the commit is retried inside the attempt', async () => {
  const f = seed();
  const fakeFetch = globalThis.fetch;
  let moved = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!moved && (init?.method ?? 'GET').toUpperCase() === 'PATCH' && url.includes('/git/refs/heads/main')) {
      moved = true;
      f.push('main', 'sites/temporal-io/findings/other.md', 'another writer\n', 'argus: another finding');
    }
    return fakeFetch(input, init);
  }) as typeof fetch;
  try {
    const result = await run({ runner: production('<h1>Pricing</h1>') });
    assert.equal(result.outcome, 'resolved');
  } finally {
    globalThis.fetch = fakeFetch;
  }
  assert.ok(moved);
  assert.deepEqual(f.history('main'), ['seed', 'argus: another finding', `watch ${KEY}: resolved (${WORKFLOW_ID})`]);
});
