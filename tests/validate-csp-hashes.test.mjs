import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  declaredScriptHashes,
  findUnhashedScripts,
  inlineScripts,
  sha256,
} from '../scripts/validate-csp-hashes.mjs';
import { PRE_PAINT_APPEARANCE_SCRIPT } from '../src/lib/pre-paint-appearance.mjs';

function distWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'validate-csp-hashes-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir + sep;
}

/** A page whose CSP meta declares exactly the hashes it is given. */
function page(scripts, { hashes = scripts.map((s) => sha256(s)), inHead = true, extra = '' } = {}) {
  const meta = `<meta http-equiv="content-security-policy" content="script-src 'self' ${hashes
    .map((h) => `'${h}'`)
    .join(' ')}${extra}; style-src 'self';">`;
  const body = scripts.map((s) => `<script>${s}</script>`).join('');
  return inHead
    ? `<!doctype html><html><head>${meta}${body}</head><body></body></html>`
    : `<!doctype html><html><head>${body}</head><body>${meta}</body></html>`;
}

test('a page whose inline scripts are all hashed passes', () => {
  const dist = distWith({ 'index.html': page(['alert(1)', 'alert(2)']) });
  const { failures, scriptCount } = findUnhashedScripts(dist);
  assert.deepEqual(failures, []);
  assert.equal(scriptCount, 2);
});

test('an inline script missing from script-src fails', () => {
  const dist = distWith({ 'index.html': page(['alert(1)'], { hashes: [] }) });
  const { failures } = findUnhashedScripts(dist);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /is not in script-src/);
});

test('a one-byte edit to a script invalidates its hash', () => {
  // The whole point of the check: byte-exactness, not resemblance.
  const dist = distWith({
    'index.html': page(['alert(1)'], { hashes: [sha256('alert(1) ')] }),
  });
  assert.equal(findUnhashedScripts(dist).failures.length, 1);
});

test('nested pages are walked, and each is checked against its own CSP', () => {
  const dist = distWith({
    'index.html': page(['alert(1)']),
    'writing/post/index.html': page(['alert(2)'], { hashes: [] }),
  });
  const { failures, pageCount } = findUnhashedScripts(dist);
  assert.equal(pageCount, 2);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /writing[/\\]post/);
});

test('ld+json is skipped — Chrome does not apply script-src to data blocks', () => {
  const html = page([]).replace(
    '</head>',
    '<script type="application/ld+json">{"@context":"https://schema.org"}</script></head>'
  );
  assert.deepEqual(findUnhashedScripts(distWith({ 'index.html': html })).failures, []);
  assert.equal(inlineScripts(html).length, 0);
});

test('external scripts are skipped — they are covered by the source list, not a hash', () => {
  const html = page([]).replace('</head>', '<script src="/_astro/app.js"></script></head>');
  assert.deepEqual(findUnhashedScripts(distWith({ 'index.html': html })).failures, []);
});

test("'unsafe-inline' is reported — it voids every hash in the directive", () => {
  const html = page(['alert(1)'], { extra: " 'unsafe-inline'" });
  const { failures } = findUnhashedScripts(distWith({ 'index.html': html }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /unsafe-inline/);
});

test('a CSP meta outside <head> is reported — Chrome ignores it there', () => {
  // The 2026-07-19 head trap: a custom element in <head> closed it early and
  // pushed the meta into the body, silently disabling script-src sitewide.
  const { failures } = findUnhashedScripts(
    distWith({ 'index.html': page(['alert(1)'], { inHead: false }) })
  );
  assert.ok(failures.some((f) => /outside <head>/.test(f)));
});

test('a page with no CSP meta at all is reported', () => {
  const dist = distWith({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
  const { failures } = findUnhashedScripts(dist);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no CSP <meta>/);
});

test("single quotes inside the content attribute do not truncate the hash list", () => {
  // A [^"'] character class stops at 'self' and reports every hash as missing.
  const { hashes } = declaredScriptHashes(page(['alert(1)', 'alert(2)']));
  assert.equal(hashes.size, 2);
});

test('script content comes back verbatim, with entities undecoded', () => {
  // The hashes are computed over the exact bytes Astro emitted between the tags, so the parser
  // must not normalise them. script is a rawtext element, so `&amp;` and a bare `<` stay as
  // written — this asserts that rather than trusting it, because a parser that decoded entities
  // would produce hashes that never match and a validator that fails every build.
  const source = 'const s = "&amp; &lt; &#39;"; if (1 < 2 && 3 > 2) go();';
  const [script] = inlineScripts(`<html><head><script>${source}</script></head></html>`);
  assert.equal(script.content, source);
  assert.equal(sha256(script.content), sha256(source));
});

test('a > inside an attribute value does not truncate the script', () => {
  // The case the regex got wrong: `<script([^>]*)>` ends the open tag at the first `>`, whatever
  // is quoting it, so the hash is taken over the tail of an attribute plus the code.
  const [script] = inlineScripts('<html><head><script data-note="a>b">alert(1)</script></head></html>');
  assert.equal(script.content, 'alert(1)');
});

test('a type with surrounding whitespace is still executable', () => {
  // How a browser compares it: trimmed and ASCII-case-insensitive.
  assert.equal(inlineScripts('<html><head><script type=" MODULE ">x()</script></head></html>').length, 1);
});

test('the pre-paint appearance script reads the storage key from appearance.mjs', () => {
  assert.match(PRE_PAINT_APPEARANCE_SCRIPT, /"mattpyle:appearance"/);
  assert.match(PRE_PAINT_APPEARANCE_SCRIPT, /\["retro"\]/);
});
