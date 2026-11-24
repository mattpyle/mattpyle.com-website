// `npm run look` is on the fix Action's allowlist, so its argument rules are the fence between
// what a fixer types and what the browser loads. These pin them without a build or a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefusal, labelRefusal, parseArgs, pathRefusal, readableHtml, slugFor } from '../scripts/look.mjs';

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
