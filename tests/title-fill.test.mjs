import assert from 'node:assert/strict';
import test from 'node:test';
import { splitTitleFill } from '../src/lib/title-fill.mjs';
import { isRedesignedRoute } from '../src/lib/redesigned-routes.mjs';

/**
 * The post H1's fill phrase. Both guards in src/lib/title-fill.mjs answer to a
 * concrete failure, so both are asserted rather than described.
 */

test('the fill is the title\'s last word', () => {
  assert.deepEqual(splitTitleFill('How to implement WebMCP on a website'), {
    head: 'How to implement WebMCP on a',
    fill: 'website',
  });
});

test('a one- or two-letter last word takes the word before it with it', () => {
  assert.deepEqual(
    splitTitleFill('A deliberately broken draft that Steward is supposed to catch every single problem in'),
    {
      head: 'A deliberately broken draft that Steward is supposed to catch every single',
      fill: 'problem in',
    },
  );
});

test('punctuation counts toward the word, and a four-character word stands alone', () => {
  assert.deepEqual(splitTitleFill('Hello, World! Or, this post is a lie.'), {
    head: 'Hello, World! Or, this post is a',
    fill: 'lie.',
  });
});

// The fill span is `white-space: nowrap`, so a long phrase would push a 320px
// viewport sideways rather than wrap. Past the cap the title takes no fill.
test('a phrase too long to fit a narrow viewport takes no fill', () => {
  assert.deepEqual(splitTitleFill('On internationalization'), {
    head: 'On internationalization',
    fill: null,
  });
});

test('a single-word title takes no fill', () => {
  assert.deepEqual(splitTitleFill('Writing'), { head: 'Writing', fill: null });
});

test('extra whitespace does not become an empty fill', () => {
  assert.deepEqual(splitTitleFill('  Two   words  '), { head: 'Two', fill: 'words' });
});

/**
 * The redesign's route list. A prefix match is what converts the post template,
 * and the negative cases are the point: an unconverted route must stay
 * byte-identical to what it was before the branch.
 */
test('the redesigned routes are the homepage, /writing and the posts under it', () => {
  for (const path of ['/', '/writing', '/writing/', '/writing/hello-world', '/writing/hello-world/']) {
    assert.equal(isRedesignedRoute(path), true, path);
  }
  for (const path of ['/about/', '/projects/', '/changelog/', '/scorecard/', '/steward/', '/webmcp/']) {
    assert.equal(isRedesignedRoute(path), false, path);
  }
});
