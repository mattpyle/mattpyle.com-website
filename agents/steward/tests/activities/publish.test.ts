import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flipDraftFrontmatter, buildPrBody } from '../../src/activities/publish.js';
import type { ReviewReport } from '../../src/lib/report.js';

/**
 * `publishPost`'s pure parts (spec §8.7 step 4 and step 6).
 *
 * The git/GitHub halves are exercised by the live dry-run against a throwaway
 * branch of the real repo, which is the only thing that proves the REST calls
 * and the push actually work. What is unit-tested here is the frontmatter
 * surgery — the part that edits the human's prose file and therefore has to be
 * exactly right.
 */

const TODAY = '2026-07-19';

function post(fm: string, body = '\n## A heading\n\nSome prose.\n'): string {
  return `---\n${fm}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// The draft flip.
// ---------------------------------------------------------------------------

test('flips draft: true to false', () => {
  const raw = post(`title: "A Post"\ndate: ${TODAY}\ndraft: true`);
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.match(result.content, /^draft: false$/m);
  assert.ok(!/draft:\s*true/.test(result.content));
  assert.equal(result.changed, true);
  assert.equal(result.title, 'A Post');
});

test('re-publishing an already-flipped post is a no-op — the idempotent path', () => {
  const raw = post(`title: "A Post"\ndate: ${TODAY}\ndraft: false`);
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.equal(result.changed, false);
  assert.equal(result.content, raw);
});

test('the body is untouched, byte for byte', () => {
  const body = '\n## Heading\n\nProse with `code`, an em—dash, and trailing space.  \n\n- a list\n';
  const raw = post(`title: "A Post"\ndate: ${TODAY}\ndraft: true`, body);
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.ok(result.content.endsWith(body), 'the body must survive the frontmatter edit intact');
});

test('unrelated frontmatter keys keep their formatting and order', () => {
  // Round-tripping through gray-matter's dump would reorder keys and normalise
  // quotes, producing a PR diff where every line changed for a one-word edit.
  const fm = [
    'title: "A Post"',
    "description: 'single quoted'",
    `date: ${TODAY}`,
    'tags: ["a", "b"]',
    'featured:   true',
    'draft: true',
  ].join('\n');
  const result = flipDraftFrontmatter(post(fm), TODAY);

  assert.match(result.content, /description: 'single quoted'/);
  assert.match(result.content, /tags: \["a", "b"\]/);
  assert.match(result.content, /featured:   true/, 'even odd whitespace is preserved');
  assert.ok(
    result.content.indexOf('title:') < result.content.indexOf('description:'),
    'key order must not change',
  );
});

// ---------------------------------------------------------------------------
// The date rule (§8.7 step 4).
// ---------------------------------------------------------------------------

test('a recent date is left alone — the human may have set it deliberately', () => {
  const raw = post(`title: "A Post"\ndate: 2026-07-10\ndraft: true`);
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.match(result.content, /^date: 2026-07-10$/m);
  assert.equal(result.dateAction, 'left');
});

test('a date more than 30 days stale is refreshed to today', () => {
  const raw = post(`title: "A Post"\ndate: 2026-01-01\ndraft: true`);
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.match(result.content, new RegExp(`^date: ${TODAY}$`, 'm'));
  assert.equal(result.dateAction, 'refreshed');
});

test('a date exactly at the boundary is left alone', () => {
  // 2026-06-20 is 29 days before 2026-07-19. The rule is "more than 30 days",
  // and a boundary that drifts is a boundary nobody can reason about.
  const raw = post(`title: "A Post"\ndate: 2026-06-20\ndraft: true`);
  assert.equal(flipDraftFrontmatter(raw, TODAY).dateAction, 'left');
});

test('a missing date is added', () => {
  const raw = post(`title: "A Post"\ndraft: true`);
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.match(result.content, new RegExp(`^date: ${TODAY}$`, 'm'));
  assert.equal(result.dateAction, 'added');
});

test('updated: is never touched on first publish', () => {
  // A spurious `updated` would feed a false modifiedTime into the freshness
  // signals. The post has not been updated; it has been published.
  const raw = post(`title: "A Post"\ndate: 2026-01-01\nupdated: 2026-01-02\ndraft: true`);
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.match(result.content, /^updated: 2026-01-02$/m);
});

// ---------------------------------------------------------------------------
// Refusals.
// ---------------------------------------------------------------------------

test('a post with no frontmatter is refused rather than guessed at', () => {
  assert.throws(
    () => flipDraftFrontmatter('# Just a heading\n\nProse.\n', TODAY),
    /no YAML frontmatter/i,
  );
});

test('a post with no title is refused — verifyDeploy needs it', () => {
  assert.throws(() => flipDraftFrontmatter(post(`date: ${TODAY}\ndraft: true`), TODAY), /no `title`/);
});

test('CRLF line endings survive the flip', () => {
  const raw = `---\r\ntitle: "A Post"\r\ndate: ${TODAY}\r\ndraft: true\r\n---\r\n\r\nProse.\r\n`;
  const result = flipDraftFrontmatter(raw, TODAY);

  assert.match(result.content, /draft: false/);
  assert.ok(result.content.includes('\r\n'), 'must not silently rewrite the file to LF');
  assert.ok(!/(?<!\r)\n/.test(result.content), 'must not produce mixed line endings');
});

// ---------------------------------------------------------------------------
// The PR body.
// ---------------------------------------------------------------------------

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    schemaVersion: 1,
    slug: 'a-post',
    collection: 'writing',
    mode: 'gate',
    file: 'src/content/writing/a-post.md',
    contentSha256: 'a'.repeat(64),
    reviewedAt: '2026-07-19T00:00:00.000Z',
    workflowId: 'steward-review-a-post',
    runId: 'run-1',
    passes: [
      {
        pass: 'cspell',
        verdict: 'pass',
        findings: [],
        patches: [],
        startedAt: '2026-07-19T00:00:00.000Z',
        durationMs: 1,
      },
      {
        pass: 'vale',
        verdict: 'flag',
        findings: [
          { id: 'v-1', pass: 'vale', severity: 'flag', message: 'wordy' },
          { id: 'v-2', pass: 'vale', severity: 'flag', message: 'passive' },
        ],
        patches: [],
        startedAt: '2026-07-19T00:00:00.000Z',
        durationMs: 1,
      },
    ],
    patches: [],
    overall: 'flag',
    summary: 'FLAG — two findings want a look.',
    human: { decision: 'approved' },
    publish: {},
    ...overrides,
  };
}

test('the PR body carries the summary, the per-pass counts, and the report path', () => {
  const body = buildPrBody(report(), 'agents/steward/reviews/writing/a-post/aaaa.json', false);

  assert.match(body, /FLAG — two findings want a look\./);
  assert.match(body, /\| `vale` \| flag \| 2 \|/);
  assert.match(body, /\| `cspell` \| pass \| 0 \|/);
  assert.match(body, /agents\/steward\/reviews\/writing\/a-post\/aaaa\.json/);
  assert.match(body, /aaaaaaaaaaaa/, 'the content pin must be visible to the reviewer');
  assert.match(body, /never merges/i);
});

test('the PR body keeps the blank lines markdown needs', () => {
  // Regression: an earlier version filtered out every empty string to drop the
  // absent dry-run banner, which also removed all seven intentional blank lines
  // and collapsed the body into one run-on block. GitHub will not render a table
  // that has no blank line before it. The original assertions all used regexes
  // that were blind to this, so it survived a green suite and was caught only by
  // reading the actual rendered PR.
  const body = buildPrBody(report(), 'p.json', false);
  const lines = body.split('\n');
  const tableStart = lines.findIndex((l) => l.startsWith('| Pass |'));

  assert.ok(tableStart > 0);
  assert.equal(lines[tableStart - 1], '', 'a markdown table needs a blank line before it');
  assert.ok(body.includes('\n\n'), 'the body must contain paragraph breaks');
  // The summary must be its own paragraph, not glued to the verdict line.
  const summaryLine = lines.findIndex((l) => l.startsWith('FLAG —'));
  assert.equal(lines[summaryLine - 1], '');
});

test('the dry-run banner is its own paragraph', () => {
  const lines = buildPrBody(report(), 'p.json', true).split('\n');
  assert.match(lines[0], /DRY RUN/);
  assert.equal(lines[1], '', 'the banner must not run into the verdict line');
});

test('a force-approved report says so in the PR body', () => {
  const body = buildPrBody(report({ human: { decision: 'approved_force' } }), 'p.json', false);
  assert.match(body, /--force/, 'a reviewer must be able to see the block was overridden');
});

test('a dry-run PR body is unmistakably marked', () => {
  const body = buildPrBody(report(), 'p.json', true);
  assert.match(body, /DRY RUN/);
  assert.match(body, /do not merge/i);
});
