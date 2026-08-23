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
test('every page surface is redesigned, and an unknown path still is not', () => {
  for (const path of [
    '/',
    '/writing', '/writing/', '/writing/hello-world', '/writing/hello-world/',
    '/projects', '/projects/',
    // The index, its paginated pages and its entries convert together.
    '/changelog', '/changelog/', '/changelog/2/', '/changelog/public-scorecard/',
    '/about', '/about/',
    '/steward', '/steward/',
    '/scorecard', '/scorecard/',
    '/activity', '/activity/',
    '/webmcp', '/webmcp/',
  ]) {
    assert.equal(isRedesignedRoute(path), true, path);
  }
  // /webmcp was the last surface on the legacy design, so the flag is now true for every page the
  // site renders. src/lib/redesigned-routes.mjs says to DELETE the module at that point rather
  // than leave a permanently-true flag; that removal is its own change, and until it lands this
  // negative case is what keeps the function a function rather than a `return true`.
  for (const path of ['/not-a-page/']) {
    assert.equal(isRedesignedRoute(path), false, path);
  }
});
