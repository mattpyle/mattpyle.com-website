import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';

import { readPublishedScorecard, resolveAuditUrls, resolveRunStamp } from '../../src/activities/scorecard.js';
import { SCORECARD_RUNS_PATH } from '../../src/config.js';
import { installFakeGitHub, type FakeGitHub } from '../helpers/fake-github.js';

/**
 * The failures of the scorecard's reads that no retry mends (STW-680). The
 * workflow retries these reads through an outage, so each of these must be
 * non-retryable, and a 5xx or a network failure on the same read must not be.
 */

const INDEX = 'https://example.test/sitemap-index.xml';
const CHILD = 'https://example.test/sitemap-0.xml';

const realFetch = globalThis.fetch;
let hub: FakeGitHub | undefined;

afterEach(() => {
  globalThis.fetch = realFetch;
  hub?.restore();
  hub = undefined;
});

/** Answers each URL with its status and body; a URL not named is a network failure. */
function answers(map: Record<string, { status: number; body?: string }>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const answer = map[String(input)];
    if (!answer) throw new TypeError('fetch failed');
    return new Response(answer.body ?? '', { status: answer.status });
  }) as typeof fetch;
}

const index = { status: 200, body: `<sitemapindex><sitemap><loc>${CHILD}</loc></sitemap></sitemapindex>` };

function permanent(type: string) {
  return (err: unknown) => {
    assert.ok(err instanceof ApplicationFailure, String(err));
    assert.equal(err.type, type);
    assert.equal(err.nonRetryable, true);
    return true;
  };
}

function retryable(err: unknown): boolean {
  assert.ok(!(err instanceof ApplicationFailure) || !err.nonRetryable, String(err));
  return true;
}

test('a sitemap index that answers 404 is permanent', async () => {
  answers({ [INDEX]: { status: 404 } });
  await assert.rejects(resolveAuditUrls(INDEX), permanent('SitemapNotFound'));
});

test('a sitemap the index names that answers 404 is permanent', async () => {
  answers({ [INDEX]: index, [CHILD]: { status: 404 } });
  await assert.rejects(resolveAuditUrls(INDEX), permanent('SitemapNotFound'));
});

test('a sitemap index that names no sitemap is permanent', async () => {
  answers({ [INDEX]: { status: 200, body: '<sitemapindex></sitemapindex>' } });
  await assert.rejects(resolveAuditUrls(INDEX), permanent('SitemapEmpty'));
});

test('a 5xx or a network failure on either sitemap read stays retryable', async () => {
  const outages: Array<Parameters<typeof answers>[0]> = [{ [INDEX]: { status: 503 } }, {}, { [INDEX]: index, [CHILD]: { status: 500 } }, { [INDEX]: index }];
  for (const map of outages) {
    answers(map);
    await assert.rejects(resolveAuditUrls(INDEX), retryable);
  }
});

test('a run-log that does not parse is permanent', async () => {
  hub = installFakeGitHub({ seed: { [SCORECARD_RUNS_PATH]: '[{"iso": \n' } });
  await assert.rejects(readPublishedScorecard(), permanent('ScorecardRunsMalformed'));
});

test('a 5xx or a network failure on the run-log read stays retryable', async () => {
  hub = installFakeGitHub({ seed: { [SCORECARD_RUNS_PATH]: '[]' } });
  const github = globalThis.fetch;
  const onContents = (fail: () => Promise<Response>) => {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/contents/') ? fail() : github(input, init)) as typeof fetch;
  };
  onContents(async () => new Response('{"message":"Server Error"}', { status: 502 }));
  await assert.rejects(readPublishedScorecard(), /502/);
  await assert.rejects(readPublishedScorecard(), retryable);
  onContents(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(readPublishedScorecard(), /fetch failed/);
  await assert.rejects(readPublishedScorecard(), retryable);
});

test('a time zone that does not exist is permanent', async () => {
  await assert.rejects(resolveRunStamp('Mars/Olympus_Mons'), permanent('BadTimeZone'));
});
