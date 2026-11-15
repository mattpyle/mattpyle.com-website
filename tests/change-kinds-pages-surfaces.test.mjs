import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { markdownSiblingFor } from '../src/lib/markdown-negotiation.mjs';
import { STATIC_ROUTE_LASTMOD } from '../src/data/sitemap-lastmod.mjs';
import { RETRO_ROUTES } from '../scripts/lib/retro-routes.mjs';
import { EXPERIMENT_PAGES } from '../scripts/generate-og-images.mjs';
import { ROOT, builtPages, canon, read } from './helpers/built-pages.mjs';

/**
 * Change kind "a new page", the four surfaces slice 1 did not cover. Every built page has to be on
 * each one or on that surface's exemption list, or the test fails naming the page and the surface.
 * See CHANGE-KINDS.md. The built pages are the .astro files under src/pages, as in
 * change-kinds-pages.test.mjs.
 *
 *   Link headers   vercel.json                    a pair per page: slash and no slash, the root once
 *   lastmod        src/data/sitemap-lastmod.mjs   a STATIC_ROUTE_LASTMOD key per page
 *   scan routes    scripts/lib/retro-routes.mjs   a route per page, and the list equals a11y.yml's
 *   share cards    scripts/generate-og-images.mjs a card per page, or the sitewide fallback
 *
 * Each exemption needs a reason; an empty one fails below.
 */

/** @type {Record<string, string>} */
const LINK_EXEMPT = {
  '/404': 'the error page; it has no markdown alternate and is not negotiable',
};
/** @type {Record<string, string>} */
const LASTMOD_EXEMPT = {
  '/404': 'the error page; the sitemap integration leaves it out',
};
/**
 * A page off the scan list names the listed page that shares its template. Empty today: every
 * built page is on the list.
 * @type {Record<string, string>}
 */
const SCAN_EXEMPT = {};
/** @type {Record<string, string>} */
const CARD_EXEMPT = {
  '/': 'uses the sitewide fallback card',
  '/about': 'uses the sitewide fallback card',
  '/projects': 'uses the sitewide fallback card',
  '/writing': 'uses the sitewide fallback card',
  '/changelog': 'uses the sitewide fallback card',
  '/fix-log': 'uses the sitewide fallback card',
  '/404': 'the error page; it uses the fallback',
};

const A11Y_WORKFLOW = '.github/workflows/a11y.yml';

/** The forms vercel.json lists: no slash and slash, or the root alone. @param {string} page */
const sourceForms = (page) => (page === '/' ? ['/'] : [page, `${page}/`]);

/** The .astro file that builds a page, or null. @param {string} page */
export function pageSource(page) {
  const route = page === '/' ? 'index' : page.slice(1);
  for (const file of [`src/pages/${route}.astro`, `src/pages/${route}/index.astro`]) {
    if (existsSync(fileURLToPath(new URL(file, ROOT)))) return { file, text: read(file) };
  }
  return null;
}

/** The URL paths the axe-cli step in the workflow audits. @param {string} workflow */
export function workflowRoutes(workflow) {
  const start = workflow.indexOf('npm run --silent a11y:axe --');
  const end = workflow.indexOf('\n\n', start);
  if (start === -1 || end === -1) return [];
  return [...workflow.slice(start, end).matchAll(/http:\/\/localhost:4321([^\s'"]*)/g)].map((match) => match[1]);
}

/**
 * @param {{built: Set<string>, vercel: {headers: {source: string, headers: {key: string, value: string}[]}[]}, exempt?: Record<string, string>}} input
 */
export function linkProblems({ built, vercel, exempt = LINK_EXEMPT }) {
  const rules = new Map(
    vercel.headers.map((rule) => [rule.source, rule.headers.find((header) => header.key === 'Link')?.value ?? ''])
  );
  const problems = [];
  for (const page of [...built].sort()) {
    if (page in exempt) continue;
    const sibling = markdownSiblingFor(page);
    for (const source of sourceForms(page)) {
      const value = rules.get(source);
      if (!value) problems.push(`${page} has no Link header for ${source} in vercel.json`);
      else if (!value.includes(`<${sibling}>; rel="alternate"; type="text/markdown"`)) {
        problems.push(`${page}: the Link header for ${source} in vercel.json does not advertise <${sibling}>`);
      }
    }
  }
  return problems;
}

/** @param {{built: Set<string>, lastmod: Record<string, string>, exempt?: Record<string, string>}} input */
export function lastmodProblems({ built, lastmod, exempt = LASTMOD_EXEMPT }) {
  return [...built]
    .sort()
    .filter((page) => !(page in exempt) && !((page === '/' ? '/' : `${page}/`) in lastmod))
    .map((page) => `${page} is built but has no STATIC_ROUTE_LASTMOD entry (src/data/sitemap-lastmod.mjs)`);
}

/**
 * @param {{built: Set<string>, routes: string[], workflowRoutes: string[], exempt?: Record<string, string>}} input
 */
export function scanProblems({ built, routes, workflowRoutes: fromWorkflow, exempt = SCAN_EXEMPT }) {
  const problems = [];
  if (fromWorkflow.length === 0) {
    problems.push(`${A11Y_WORKFLOW}: the parse found no URLs in the axe-core audit step; the step moved or was reformatted`);
  } else if (JSON.stringify(routes) !== JSON.stringify(fromWorkflow)) {
    const missing = routes.filter((route) => !fromWorkflow.includes(route));
    const extra = fromWorkflow.filter((route) => !routes.includes(route));
    problems.push(
      `scripts/lib/retro-routes.mjs and ${A11Y_WORKFLOW} differ` +
        (missing.length ? `; only in retro-routes.mjs: ${missing.join(', ')}` : '') +
        (extra.length ? `; only in ${A11Y_WORKFLOW}: ${extra.join(', ')}` : '') +
        (!missing.length && !extra.length ? '; same routes in a different order' : '')
    );
  }
  const listed = new Set(routes.map(canon));
  for (const page of [...built].sort()) {
    if (page in exempt || listed.has(page)) continue;
    problems.push(`${page} is built but is not on the scan route list (scripts/lib/retro-routes.mjs)`);
  }
  return problems;
}

/**
 * @param {{built: Set<string>, cards: Set<string>, usage: Map<string, string | null>, exempt?: Record<string, string>}} input
 *   cards: the slugs generate-og-images.mjs renders. usage: the card slug each page passes, or null.
 */
export function cardProblems({ built, cards, usage, exempt = CARD_EXEMPT }) {
  const problems = [];
  const used = new Set();
  for (const page of [...built].sort()) {
    const slug = usage.get(page) ?? null;
    if (slug) used.add(slug);
    if (slug && !cards.has(slug)) {
      problems.push(`${page} passes /og/pages/${slug}.png but EXPERIMENT_PAGES in scripts/generate-og-images.mjs has no ${slug}`);
    }
    if (slug && page in exempt) problems.push(`${page} has its own card but is on the fallback exemption list; remove the exemption`);
    if (!slug && !(page in exempt)) {
      problems.push(`${page} has no share card of its own and is not on the fallback exemption list (scripts/generate-og-images.mjs)`);
    }
  }
  for (const slug of [...cards].sort()) {
    if (!used.has(slug)) problems.push(`EXPERIMENT_PAGES in scripts/generate-og-images.mjs renders ${slug}, which no built page uses`);
  }
  return problems;
}

const built = builtPages();

test('every built page has its markdown Link header pair in vercel.json', () => {
  const problems = linkProblems({ built, vercel: JSON.parse(read('vercel.json')) });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('every built page has a sitemap lastmod entry', () => {
  const problems = lastmodProblems({ built, lastmod: STATIC_ROUTE_LASTMOD });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('the scan route list equals the workflow and covers every built page', () => {
  const problems = scanProblems({ built, routes: RETRO_ROUTES, workflowRoutes: workflowRoutes(read(A11Y_WORKFLOW)) });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('every built page has its own share card or is on the fallback list', () => {
  const usage = new Map();
  for (const page of built) {
    const match = /image=\{?["'`]\/og\/pages\/([^"'`.]+)\.png/.exec(pageSource(page)?.text ?? '');
    usage.set(page, match ? match[1] : null);
  }
  const problems = cardProblems({ built, cards: new Set(EXPERIMENT_PAGES.map(({ slug }) => slug)), usage });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('every exemption has a reason and names a page that is built', () => {
  const lists = { LINK_EXEMPT, LASTMOD_EXEMPT, SCAN_EXEMPT, CARD_EXEMPT };
  for (const [name, list] of Object.entries(lists)) {
    for (const [page, reason] of Object.entries(list)) {
      assert.ok(reason.trim().length > 0, `${name}: ${page} is exempt with no reason`);
      assert.ok(built.has(page), `${name}: ${page} is exempt but is not a built page; remove the exemption`);
    }
  }
});

test('the checks name the page and the surface when one is missing', () => {
  const vercel = { headers: [{ source: '/', headers: [{ key: 'Link', value: '</index.md>; rel="alternate"; type="text/markdown"' }] }] };
  const two = new Set(['/', '/new']);
  assert.match(linkProblems({ built: two, vercel }).join('\n'), /\/new has no Link header for \/new in vercel\.json/);
  assert.deepEqual(linkProblems({ built: two, vercel, exempt: { '/new': 'x' } }), []);
  assert.match(lastmodProblems({ built: two, lastmod: { '/': '2026-01-01' } }).join('\n'), /\/new .* STATIC_ROUTE_LASTMOD/);
  assert.match(scanProblems({ built: two, routes: ['/'], workflowRoutes: ['/'] }).join('\n'), /\/new .* scan route list/);
  assert.match(scanProblems({ built: two, routes: ['/', '/new'], workflowRoutes: ['/'] }).join('\n'), /only in retro-routes\.mjs: \/new/);
  assert.match(scanProblems({ built: two, routes: ['/'], workflowRoutes: [], exempt: { '/new': 'x' } }).join('\n'), /a11y\.yml.*found no URLs/);
  const usage = new Map([['/', null], ['/new', null]]);
  assert.match(cardProblems({ built: two, cards: new Set(), usage, exempt: { '/': 'x' } }).join('\n'), /\/new has no share card/);
  assert.match(cardProblems({ built: two, cards: new Set(['old']), usage, exempt: { '/': 'x', '/new': 'y' } }).join('\n'), /renders old, which no built page uses/);
});

test('the workflow parser reads quoted and shared-line URLs', () => {
  const text = "npm run --silent a11y:axe -- \\\n --exit \\\n http://localhost:4321/ \\\n 'http://localhost:4321/audit?url=https://example.com' \\\n http://localhost:4321/a/             http://localhost:4321/404\n\n- name: next";
  assert.deepEqual(workflowRoutes(text), ['/', '/audit?url=https://example.com', '/a/', '/404']);
});
