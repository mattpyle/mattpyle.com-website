// Fails the build if any inline <script> in dist/ is missing from its own page's
// CSP script-src.
//
// Astro hashes the scripts it bundles and nothing else. An is:inline script is
// emitted untouched, hash list included, so it needs a hash declared by hand in
// astro.config.mjs. That contract is invisible at edit time: get it wrong and the
// build still succeeds, the page still renders, and Chrome silently refuses the
// script in production. That is exactly what happened to the pre-paint appearance
// script, which was dead on the live site from 0b9832a until 2026-08-01 without a
// single failing check.
//
// So this asserts the outcome rather than the mechanism: extract the executable
// inline scripts from the built HTML, hash the bytes as they were emitted, and
// require each hash to appear in that page's CSP meta. It holds whoever adds the
// next inline script, and whichever way Astro's CSP support changes underneath.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import domino from '@mixmark-io/domino';

const root = fileURLToPath(new URL('..', import.meta.url));
// Static output lands in dist/client/ because of the Vercel adapter (see
// assert-no-drafts.mjs); dist/ itself is the server bundle.
const distDir = `${root}dist/client/`;

// Only script types the browser executes are subject to script-src. Chrome does
// not apply the directive to data blocks, so the sitewide ld+json is unhashed
// and correctly unaffected — including it here would fail every page.
const EXECUTABLE_TYPES = new Set(['', 'text/javascript', 'module', 'application/javascript']);

/** Every .html file under a directory, as absolute paths. */
export function htmlFilesIn(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) found.push(...htmlFilesIn(`${path}/`));
    else if (entry.name.endsWith('.html')) found.push(path);
  }
  return found;
}

/** @param {string} content */
export function sha256(content) {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`;
}

/**
 * The inline scripts a browser would execute, as {type, content} pairs.
 * Scripts with a src are external and covered by script-src's source list, not
 * by a hash, so they are skipped.
 *
 * Parsed with domino rather than matched with a regex. A regex over HTML gets
 * the tag boundaries wrong on inputs a parser handles correctly — an attribute
 * value containing `>`, a `</script` inside a string — and every way it can be
 * wrong here is the same way: a script silently missing from the list, which is
 * this validator green-lighting a CSP that refuses the script in production.
 * The parser is the thing whose disagreement with the browser is worth ruling
 * out, not the thing whose speed matters.
 *
 * The hashes are computed over the exact bytes between the tags, so this relies
 * on domino returning script content verbatim. It does: script is a rawtext
 * element, so its text node carries `&amp;` and `<` as written, undecoded.
 * `tests/validate-csp-hashes.test.mjs` holds that as an assertion rather than
 * an assumption.
 *
 * @param {string} html
 */
export function inlineScripts(html) {
  const document = domino.createDocument(html, true);
  const scripts = [];
  for (const element of Array.from(document.querySelectorAll('script'))) {
    if (element.hasAttribute('src')) continue;
    // Trimmed and lowercased because that is how a browser compares the type
    // attribute; `type=" module "` is a module.
    const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) continue;
    scripts.push({ type, content: element.textContent });
  }
  return scripts;
}

/**
 * The hashes declared in a page's CSP meta script-src, as a Set. An empty Set
 * means no CSP meta was found, which is itself a failure worth reporting: the
 * head trap of 2026-07-19 pushed the meta into <body>, where Chrome ignores it.
 *
 * @param {string} html
 */
export function declaredScriptHashes(html) {
  const meta = html.match(/<meta[^>]*http-equiv=["']content-security-policy["'][^>]*>/i)?.[0];
  // Match the closing quote by backreference. The content attribute is double
  // quoted and every source inside it is single quoted, so a naive [^"'] class
  // stops dead at 'self' and reports the whole hash list as missing.
  const content = meta?.match(/content=(["'])([\s\S]*?)\1/i)?.[2];
  const scriptSrc = content?.split(';').find((directive) => directive.trim().startsWith('script-src'));
  return {
    hasMeta: Boolean(meta),
    inHead: Boolean(meta) && html.indexOf(meta) < html.indexOf('</head>'),
    unsafeInline: Boolean(scriptSrc?.includes("'unsafe-inline'")),
    hashes: new Set([...(scriptSrc ?? '').matchAll(/'(sha(?:256|384|512)-[^']+)'/g)].map((m) => m[1])),
  };
}

/**
 * Every problem found across the built pages, as human-readable strings.
 * Pure apart from reading the tree, so a test can point it at a fixture.
 */
export function findUnhashedScripts(dist = distDir) {
  const failures = [];
  const files = htmlFilesIn(dist);
  let scriptCount = 0;

  for (const file of files) {
    const page = file.slice(dist.length);
    const html = readFileSync(file, 'utf-8');
    const { hasMeta, inHead, unsafeInline, hashes } = declaredScriptHashes(html);

    if (!hasMeta) {
      failures.push(`${page}: no CSP <meta> in the page at all`);
      continue;
    }
    if (!inHead) {
      failures.push(`${page}: CSP <meta> is outside <head>, so Chrome ignores it`);
    }
    if (unsafeInline) {
      failures.push(`${page}: script-src contains 'unsafe-inline', which voids every hash`);
    }

    for (const { content } of inlineScripts(html)) {
      scriptCount += 1;
      const hash = sha256(content);
      if (!hashes.has(hash)) {
        const preview = content.trim().slice(0, 60).replace(/\s+/g, ' ');
        failures.push(`${page}: inline script ${hash} is not in script-src — "${preview}…"`);
      }
    }
  }

  return { failures, pageCount: files.length, scriptCount };
}

export function main() {
  const { failures, pageCount, scriptCount } = findUnhashedScripts();

  if (failures.length > 0) {
    console.error('validate-csp-hashes: the CSP would refuse script(s) in this build:\n');
    // One line per distinct problem: an unhashed sitewide script otherwise
    // repeats itself once per page and buries anything else.
    for (const failure of [...new Set(failures.map((f) => f.replace(/^[^:]*: /, '')))]) {
      console.error(`  - ${failure}`);
    }
    console.error('\nAdd the hash to security.csp.scriptDirective.hashes in astro.config.mjs,');
    console.error('derived from the same constant the template renders. Never paste a literal.');
    return 1;
  }

  console.log(
    `validate-csp-hashes: ${scriptCount} inline script(s) across ${pageCount} page(s) are hashed in script-src.`
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
