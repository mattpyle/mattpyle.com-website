#!/usr/bin/env node
/**
 * Assert that the /llms.txt this build generates still conforms to llmstxt.org (v2).
 *
 * The file is generated from the content collections by `src/pages/llms.txt.ts`, so a change to
 * the generator, or to a post's frontmatter, can break the format without breaking the build. This
 * is the check that would notice.
 *
 * WHAT ALREADY COVERED THIS, AND WHAT DID NOT. Three things watch llms.txt today and none of them
 * closes this gap:
 *
 *   - The nightly scorecard audit (`steward scorecard`) runs Lighthouse's `llms-txt` audit on each
 *     tested page and folds the result into the Agentic Browsing axis. It runs unattended, but
 *     against **production**, a day late, and it degrades a metric from Pass to Partial rather than
 *     failing anything — a broken file would be live for a day and then appear as a number on a
 *     public page. It also needs Temporal Cloud and a worker, so it is not a signal a PR can carry.
 *   - Steward's `llms-txt`, `llms-txt-links` and `llms-txt-list-items` checks grade any site over
 *     HTTP, including this one, but only when somebody runs an audit.
 *   - `verify-deploy.ts` checks, after a Steward publish, that /llms.txt returns 200 and mentions
 *     the slug just published. Nothing about its shape.
 *
 * So this runs in CI against a served build of the commit, before it can deploy. It reuses
 * Steward's parser and rules through the `agent-audit/fast` entry rather than growing a second
 * implementation that drifts from the one the public audit uses — which is why the npm script runs
 * it under `tsx`: Steward ships TypeScript source with no build step, and Node's own type
 * stripping does not resolve the `.js` specifiers that source uses.
 *
 * Usage:
 *   node scripts/serve-built-site.mjs --port 4321 &
 *   npm run validate:llms-txt [-- --base http://localhost:4321]
 */

import { checkLlmsTxtConformance } from '@mattpyle/steward/agent-audit/fast';
import { builtRoutes } from './lib/built-routes.mjs';
import { SITE_ORIGIN } from '../src/data/site-origin.mjs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

const base = flag('base', 'http://localhost:4321').replace(/\/$/, '');
const url = `${base}/llms.txt`;

const res = await fetch(url);
if (res.status !== 200) {
  console.error(`validate-llms-txt: ${url} answered ${res.status}, expected 200. Is the build served?`);
  process.exit(1);
}

// A path that answers 200 with the site's HTML 404 page is the failure a presence-only checker
// misses, and the one Steward's public check was written around — so what is asserted is that the
// response is not HTML, by type and then by body.
//
// Not `text/markdown`, which is what `src/pages/llms.txt.ts` sets on its Response: the route
// prerenders to a file, and a prerendered API route's headers are discarded. Production serves
// `text/plain; charset=utf-8` (checked 2026-08-17) and so does the local server, from its own MIME
// map. Asserting the type the generator writes would fail in every environment the file is
// actually served in.
const contentType = res.headers.get('content-type') ?? '';
if (!/^text\/(plain|markdown)\b/.test(contentType)) {
  console.error(`validate-llms-txt: ${url} served "${contentType}", expected text/plain or text/markdown.`);
  process.exit(1);
}

const body = await res.text();
if (/^\s*<(!doctype|html)/i.test(body)) {
  console.error(`validate-llms-txt: ${url} returned HTML, so the file does not really exist.`);
  process.exit(1);
}

const { ok, violations, parsed } = checkLlmsTxtConformance(body);

if (!ok) {
  console.error(`validate-llms-txt: ${violations.length} violation(s) of llmstxt.org in ${url}:`);
  for (const violation of violations) {
    console.error(`  ${violation.rule}${violation.required ? ' (required)' : ''}: ${violation.detail}`);
  }
  process.exit(1);
}

console.log(
  `validate-llms-txt: ${url} conforms — "${parsed.title}", ` +
    `${parsed.sections.length} section(s), ${parsed.links.length} link(s).`,
);

/*
 * The other half of v2: discovery.
 *
 * The spec now recommends advertising llms.txt through the `alternate` and `describedby` link
 * relations, as `<link>` elements or an HTTP `Link:` header. The site emits a `describedby`
 * `<link>` from Layout.astro on every page, so every page is where it is checked — a rule that
 * holds on the homepage and silently stops holding on posts is the failure mode worth catching,
 * and it is the one a spot check would miss.
 *
 * The per-page `rel="alternate" type="text/markdown"` sibling link is asserted here too, in the
 * same pass: it is the relation the two recommendations share, it predates this check, and a
 * regression in it would otherwise be invisible until an agent went looking for a markdown copy.
 */
const describedby = `<link rel="describedby" type="text/markdown" href="${SITE_ORIGIN}/llms.txt">`;
const failures = [];
let withSibling = 0;

for (const path of builtRoutes()) {
  const page = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } });
  if (page.status !== 200) {
    failures.push(`${path}: expected 200, got ${page.status}`);
    continue;
  }
  const html = await page.text();
  const found = [...html.matchAll(/<link[^>]*rel="describedby"[^>]*>/g)];
  if (found.length !== 1) {
    failures.push(`${path}: expected exactly one describedby link, found ${found.length}`);
  } else if (found[0][0] !== describedby) {
    failures.push(`${path}: describedby link is ${found[0][0]}, expected ${describedby}`);
  }
  if (/<link[^>]*rel="alternate"[^>]*type="text\/markdown"[^>]*>/.test(html)) withSibling++;
}

if (failures.length > 0) {
  console.error(`validate-llms-txt: ${failures.length} page(s) do not advertise llms.txt correctly:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

if (withSibling === 0) {
  console.error('validate-llms-txt: no page carries a rel="alternate" type="text/markdown" link.');
  process.exit(1);
}

console.log(
  `validate-llms-txt: every page advertises it (rel="describedby"), ` +
    `${withSibling} also link a markdown sibling (rel="alternate").`,
);
