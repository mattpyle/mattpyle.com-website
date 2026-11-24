// `npm run look` is on the fix Action's allowlist, so its argument rules are the fence between
// what a fixer types and what the browser loads. These pin them without a build or a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPattern, findRefusal, stripMarkup, labelRefusal, parseArgs, pathRefusal, readableHtml, slugFor } from '../scripts/look.mjs';

test('a site path is accepted, with or without a fragment or a query', () => {
  for (const path of ['/', '/steward/', '/agents.md', '/writing/x/#section', '/audit?url=x']) {
    assert.equal(pathRefusal(path), null, path);
  }
});

test('anything that could leave the local server is refused', () => {
  for (const path of [
    'https://example.com/',
    'http://127.0.0.1:9/x',
    '//example.com/x',
    '///example.com',
    '/\\example.com',
    'example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '/x\n/y',
    '',
  ]) {
    assert.notEqual(pathRefusal(path), null, JSON.stringify(path));
  }
  assert.notEqual(pathRefusal(undefined), null);
});

test('--find text is short visible prose: empty, over 200 characters or control characters are refused', () => {
  assert.equal(findRefusal('get_auditspends'), null);
  assert.equal(findRefusal('https://example.com/ is just text here'), null, 'a URL in the text is only matched, never loaded');
  assert.equal(findRefusal('x'.repeat(200)), null);
  assert.notEqual(findRefusal('x'.repeat(201)), null);
  assert.notEqual(findRefusal('   '), null);
  assert.notEqual(findRefusal('a\nb'), null);
  assert.notEqual(findRefusal(undefined), null);
});

test('a label is a folder-name word', () => {
  assert.equal(labelRefusal('before'), null);
  assert.equal(labelRefusal('after-2'), null);
  for (const label of ['', 'Before', '../x', 'a/b', '-x', 'x'.repeat(33), undefined]) {
    assert.notEqual(labelRefusal(label), null, String(label));
  }
});

test('--find belongs to the path before it, and the label to the run', () => {
  const parsed = parseArgs(['--label', 'before', '/steward/', '--find', 'get_auditspends', '/writing/', '/steward/', '--find', 'Contact']);
  assert.equal(parsed.label, 'before');
  assert.deepEqual(parsed.aims, [
    { path: '/steward/', find: 'get_auditspends' },
    { path: '/writing/', find: null },
    { path: '/steward/', find: 'Contact' },
  ]);
  assert.deepEqual(parsed.refusals, []);
});

test('a refused path, a stray --find and an unknown option are reported and the rest still run', () => {
  const parsed = parseArgs(['--find', 'x', 'https://evil.example', '--find', 'y', '/a/', '--find', 'z', '--find', 'w', '--eval', '/b/']);
  assert.deepEqual(parsed.aims, [
    { path: '/a/', find: 'z' },
    { path: '/b/', find: null },
  ]);
  assert.equal(parsed.refusals.length, 4);
  assert.match(parsed.refusals[0], /needs a path before it/);
  assert.match(parsed.refusals[1], /^https:\/\/evil\.example: refused/);
  assert.match(parsed.refusals[2], /one --find per path/);
  assert.match(parsed.refusals[3], /^--eval: refused/);
});

test('file names come from the path and its fragment', () => {
  assert.equal(slugFor('/'), 'index');
  assert.equal(slugFor('/steward/'), 'steward');
  assert.equal(slugFor('/writing/x/#webmcp-gotchas'), 'writing-x-webmcp-gotchas');
});

test('the saved HTML keeps inline whitespace exactly, so a joined word still shows', () => {
  for (const inline of [
    '<p>Read <code>get_audit</code>spends no allowance.</p>',
    '<p>Read <code>get_audit</code> spends no allowance.</p>',
    '<p><a href="/a">one</a><a href="/b">two</a></p>',
    '<p><a href="/a">one</a> <a href="/b">two</a></p>',
  ]) {
    assert.equal(readableHtml(inline), inline);
  }
  assert.notEqual(readableHtml('<p><a>x</a> <a>y</a></p>'), readableHtml('<p><a>x</a><a>y</a></p>'));
});

test('the saved HTML breaks lines only between block-level elements', () => {
  assert.equal(
    readableHtml('<html><head><meta charset="utf-8"><title>T</title></head><body><main><p>One <em>two</em></p> <p>Three</p></main></body></html>'),
    '<html>\n<head>\n<meta charset="utf-8">\n<title>T</title>\n</head>\n<body>\n<main>\n<p>One <em>two</em></p>\n<p>Three</p>\n</main>\n</body>\n</html>',
  );
  assert.equal(readableHtml('<div><span>a</span><span>b</span></div>'), '<div><span>a</span><span>b</span></div>', 'no break between two inline tags, even at a block edge with no gap');
  assert.equal(readableHtml('<div attr="a>b"><p>x</p></div>'), '<div attr="a>b">\n<p>x</p>\n</div>', 'a > inside an attribute value is not a tag end');
});

test('pre, script and style content is copied untouched', () => {
  const pre = '<pre><code><span>a</span>\n  <span>b</span></code></pre>';
  assert.equal(readableHtml(`<div>${pre}</div>`), `<div>\n${pre}\n</div>`);
  const script = '<script>if (a>b) x = "<p></p><div>";</script>';
  assert.equal(readableHtml(script), script);
});

test('--find matches the text as a reader types it: quotes, dashes and ellipses in either form', () => {
  // What this site's markdown renders from the source a fixer types.
  assert.match('but it\u2019d happily pass', findPattern("but it'd happily pass"), 'apostrophe');
  assert.match("but it'd happily pass", findPattern('but it\u2019d happily pass'), 'and back');
  assert.match('the \u201cdouble\u201d word', findPattern('the "double" word'), 'quote');
  assert.match('the \u2018single\u2019 word', findPattern("the 'single' word"), 'single quotes');
  assert.match('two\u2013hyphens', findPattern('two--hyphens'), '-- and an en dash');
  assert.match('three\u2014hyphens', findPattern('three---hyphens'), '--- and an em dash');
  assert.match('a\u2014b', findPattern('a-b'), 'a hyphen and an em dash');
  assert.match('a-b', findPattern('a\u2013b'), 'an en dash and a hyphen');
  assert.match('dots\u2026 here', findPattern('dots... here'), 'ellipsis');
  assert.match('dots... here', findPattern('dots\u2026 here'), 'and back');
  assert.match('one \n  two', findPattern(' one two '), 'whitespace runs match as one');
});

test('--find never matches across a joined word, and its text is never a pattern', () => {
  assert.doesNotMatch('get_auditspends no audit allowance', findPattern('get_audit spends no audit allowance'));
  assert.match('get_audit spends no audit allowance', findPattern('get_audit spends no audit allowance'));
  assert.doesNotMatch('anything at all', findPattern('.*'));
  assert.match('a .* b', findPattern('.*'));
  assert.doesNotMatch('call x)', findPattern('call (x)'));
  assert.match('call (x)', findPattern('call (x)'));
  assert.doesNotMatch('a', findPattern('[a]'));
  assert.match('$1 or ^x|y\\z', findPattern('$1 or ^x|y\\z'));
});

test('a straight apostrophe in the aim matches a straight one on the page, as a template writes it', () => {
  assert.match("but it'd be capped", findPattern("but it'd be capped"));
});

test('the second try removes source markup from an aim and leaves the page text', () => {
  const page = 'Read get_audit spends no audit allowance, but it\u2019d be capped. Use the A2A endpoint.';
  for (const [aim, plain] of [
    ['`get_audit` spends no audit allowance', 'get_audit spends no audit allowance'],
    ['<code>get_audit</code> spends no audit allowance', 'get_audit spends no audit allowance'],
    ['Use the [A2A endpoint](/a2a/).', 'Use the A2A endpoint.'],
    ['Read **get_audit** spends', 'Read get_audit spends'],
  ]) {
    assert.equal(stripMarkup(aim), plain, aim);
    assert.doesNotMatch(page, findPattern(aim), `${aim} does not match as written`);
    assert.match(page, findPattern(stripMarkup(aim)), `${aim} matches without its markup`);
  }
  assert.equal(stripMarkup('Read *get_audit* spends'), 'Read get_audit spends', 'single-asterisk emphasis');
});

test('an aim with no markup is unchanged, underscores survive, and a join stays a join', () => {
  for (const aim of ["but it'd be capped", 'get_audit spends', 'snake_case_name and __init__', '4 * 5 = 20']) {
    assert.equal(stripMarkup(aim), aim);
  }
  assert.doesNotMatch('get_auditspends no audit allowance', findPattern(stripMarkup('`get_audit` spends no audit allowance')));
});

test('stripMarkup leaves no tag, link or emphasis behind, however the input nests them', () => {
  assert.equal(stripMarkup('<scr<b>ipt>x</scr</b>ipt>'), 'x');
  assert.equal(stripMarkup('<<b>b>bold<</b>/b>'), 'bold');
  assert.equal(stripMarkup('[[A2A](/x)](/a2a/)'), 'A2A');
  assert.equal(stripMarkup('****x****'), 'x');
  for (const aim of ['<scr<b>ipt>x</scr</b>ipt>', '<<i>i>a<</i>/i> and [[b](c)](d) and `e`']) {
    const out = stripMarkup(aim);
    assert.equal(stripMarkup(out), out, `${aim} is stable after one call`);
    assert.doesNotMatch(out, /<\/?[A-Za-z][^<>]*>/, `${aim} keeps no tag`);
  }
});

test('stripMarkup keeps what only looks like the start of a tag', () => {
  for (const aim of ['an unclosed <b tag', 'a lone < here', 'a lone > here', '1 < 2 and 3 > 2', 'a < b> spaced', '<>', '</>', '<1a>']) {
    assert.equal(stripMarkup(aim), aim, aim);
  }
  assert.equal(stripMarkup('x <b and <i>y</i>'), 'x <b and y', 'an unclosed tag before a real one');
});
