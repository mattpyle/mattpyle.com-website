import assert from 'node:assert/strict';
import test from 'node:test';

import { describeCoverageGap, runPageCount } from '../src/lib/scorecard-coverage.mjs';
import { livePagePaths } from '../src/data/live-pages.mjs';
import { STATIC_ROUTE_LASTMOD } from '../src/data/sitemap-lastmod.mjs';

const scorecardRuns = await import('../src/data/scorecard-runs.json', { with: { type: 'json' } })
  .then((module) => module.default);

test('runPageCount reads the page count out of a run scope', () => {
  assert.equal(runPageCount('22 live pages'), 22);
  assert.equal(runPageCount('1 live page'), 1);
  assert.equal(runPageCount('  19 live pages, excluding drafts  '), 19);
});

test('runPageCount refuses a scope that does not count pages', () => {
  // Runs before 2026-07-23 counted page *types*, which is a different measurement.
  assert.equal(runPageCount('5 live page types'), null);
  assert.equal(runPageCount('the whole site'), null);
  assert.equal(runPageCount(undefined), null);
});

test('a run that covers fewer pages than the site states the gap', () => {
  assert.equal(
    describeCoverageGap('22 live pages', 23),
    "Covers 22 of the site's 23 current pages; 1 page has shipped since this run."
  );
  assert.equal(
    describeCoverageGap('18 live pages', 22),
    "Covers 18 of the site's 22 current pages; 4 pages have shipped since this run."
  );
});

test('a run that covers the site says nothing extra', () => {
  assert.equal(describeCoverageGap('22 live pages', 22), null);
});

test('a run broader than the current site says nothing extra', () => {
  // A removed page leaves the run covering more than the site publishes. That is not the failure
  // the line exists to name, and inventing a sentence for it would be a second, untested claim.
  assert.equal(describeCoverageGap('22 live pages', 21), null);
});

test('an uncountable scope makes no claim at all', () => {
  assert.equal(describeCoverageGap('5 live page types', 22), null);
  assert.equal(describeCoverageGap('22 live pages', Number.NaN), null);
});

test('livePagePaths joins the static routes with the published entries', () => {
  const paths = livePagePaths({
    writingSlugs: ['first-post'],
    changelogSlugs: ['a-change', 'another-change'],
  });

  assert.equal(paths.length, Object.keys(STATIC_ROUTE_LASTMOD).length + 3);
  assert.ok(paths.includes('/writing/first-post/'));
  assert.ok(paths.includes('/changelog/another-change/'));
  assert.ok(paths.every((path) => path.startsWith('/') && path.endsWith('/')));
  assert.equal(new Set(paths).size, paths.length, 'expected no duplicate page paths');
});

test('the published run and the current site are compared in the same unit', () => {
  // Not an assertion about today's numbers — an assertion that the newest run's scope is the
  // shape describeCoverageGap can read. A run whose scope stops saying "N live pages" would
  // silently disable the guard, and this is what notices.
  assert.equal(typeof runPageCount(scorecardRuns[0].scope), 'number');
});
