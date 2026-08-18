#!/usr/bin/env node
/**
 * Run the Nu HTML Checker over every route of a served production build.
 *
 * Nu is the engine behind validator.w3.org, so "zero errors here" is the same claim the W3C
 * service makes. It runs against a *served* build rather than against `dist/client` on its own
 * for two reasons: the dev server renders differently from a production build (CLAUDE.md), and
 * /scorecard has no file in `dist/client` at all — it renders per request, so the only way to
 * validate the markup it actually ships is to ask a server for it.
 *
 * Advisory, in the same spirit as spellcheck and the accessibility guard: never in the `build`
 * chain, red on a PR, deploys proceed. Malformed HTML degrades the accessibility tree that agents
 * read, which is why it is checked at all; it is not a reason to block a deploy.
 *
 * Usage:
 *   node scripts/serve-built-site.mjs --port 4321 &
 *   node scripts/validate-html.mjs [--base http://localhost:4321] [--transport jar|w3c]
 *
 * TWO TRANSPORTS, ONE ENGINE. Nu ships as a Java jar (`vnu-jar`, a devDependency here) and as the
 * public service at validator.w3.org, which runs the same checker. The jar is the default and the
 * one CI uses: it is pinned, offline, and fast enough to run every route in one JVM. The `w3c`
 * transport POSTs each document to the public service instead, and exists because a machine
 * without a JRE — Matt's, at the time of writing — would otherwise have no way to run this
 * locally at all. It is chosen automatically when `java` is absent. Both return Nu's own JSON
 * message format, so everything downstream of the transport is shared.
 *
 * Errors fail the run. Warnings and info messages are printed and do not, because Nu's warnings
 * are style advice as often as they are defects; anything deliberately left is recorded in
 * docs/reference/html-validity-and-llms-txt.md rather than silenced here.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, builtRoutes } from './lib/built-routes.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

const base = flag('base', 'http://localhost:4321').replace(/\/$/, '');
const W3C_ENDPOINT = 'https://validator.w3.org/nu/?out=json';

/** The User-Agent the public service sees, so an operator reading their logs knows who called. */
const W3C_USER_AGENT = 'mattpyle-com-html-validity (+https://www.mattpyle.com/)';

/**
 * Messages this check does not report, each with the reason it is not a defect here.
 *
 * A suppression list is how a validity gate stops being a gate, so it stays short, each entry is
 * a narrow literal match rather than a category, and each one says what would have to change for
 * the entry to go away. Anything not listed here is a finding.
 */
const EXCEPTIONS = [
  {
    id: 'origin-trial',
    // The WebMCP origin trial. Chrome's documented way to enrol a page is
    // `<meta http-equiv="origin-trial" content="…">`, and `origin-trial` is not a pragma directive
    // in the HTML spec's registry, so Nu is right and the tag is intentional anyway. The
    // alternative — Chrome's `Origin-Trial:` response header — would have to be set twice, in
    // vercel.json for the prerendered pages and in Astro for the on-demand render, which is
    // exactly the split that made the CSP a documented trap in this repo. Goes away when the
    // trial expires (2026-11-17, ORIGIN_TRIAL_EXPIRY in src/data/webmcp-catalog.mjs) and the
    // `<meta>` is deleted from src/layouts/Layout.astro.
    matches: (m) => m.message.includes('Bad value “origin-trial” for attribute “http-equiv”'),
    why: 'the WebMCP origin trial token, which Chrome only accepts in this shape',
  },
  {
    id: 'detached-csp',
    // Nu evaluates a page's `<meta>` CSP against the resources the page references. The site's
    // policy is `script-src 'self' <hashes>`, and `'self'` cannot resolve for a document Nu was
    // handed rather than fetched — POSTed to validator.w3.org it has no URL at all, and read off
    // disk by the jar its origin is a `file:` URL. Every one of these messages is Nu reporting
    // that it does not know where the document came from. The policy's real enforcement is
    // covered by scripts/validate-csp-hashes.mjs, which re-hashes the built bytes.
    matches: (m) => /violates Content Security Policy \(meta tag\)/.test(m.message),
    why: 'Nu cannot resolve “self” for a document it did not fetch from an origin',
  },
];

/** @returns {{ id: string, why: string } | undefined} the exception covering this message, if any */
function exceptionFor(message) {
  return EXCEPTIONS.find((exception) => exception.matches(message));
}

async function fetchDocument(path) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } });
  if (res.status !== 200) {
    throw new Error(`${path}: expected 200 from ${base}, got ${res.status}. Is the build served?`);
  }
  return await res.text();
}

/** Is there a JRE on PATH? The jar transport needs one; the fallback exists because often there is not. */
function hasJava() {
  const probe = spawnSync('java', ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Validate every document in one JVM.
 *
 * Nu takes a directory and checks every file in it, which matters: a JVM start costs about a
 * second, and paying that per route would make a full run slower than the build it is checking.
 * The fetched bodies are written to a temp tree whose relative paths mirror the routes, so a
 * message's file URL maps straight back to the route it came from.
 */
function validateWithJar(documents) {
  const require = createRequire(import.meta.url);
  let jarPath;
  try {
    // vnu-jar's module export is the absolute path to the jar it ships — as a boxed String
    // carrying extra properties, which child_process rejects, hence the coercion.
    jarPath = String(require('vnu-jar'));
  } catch {
    throw new Error('vnu-jar is not installed. Run `npm ci`, or pass --transport w3c.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'vnu-'));
  const fileToRoute = new Map();
  try {
    for (const [path, html] of documents) {
      const rel = path === '/' ? 'index.html' : `${path.replace(/^\/|\/$/g, '')}/index.html`;
      const file = join(dir, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, html, 'utf8');
      fileToRoute.set(file, path);
    }

    const run = spawnSync(
      'java',
      ['-jar', jarPath, '--format', 'json', '--exit-zero-always', '--skip-non-html', dir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (run.error) throw run.error;
    // Nu writes its JSON report to stderr, not stdout.
    const report = (run.stderr || run.stdout || '').trim();
    if (!report) return [];
    const parsed = JSON.parse(report);
    return (parsed.messages ?? []).map((message) => ({
      ...message,
      route: routeForFileUrl(message.url, fileToRoute),
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function routeForFileUrl(url, fileToRoute) {
  if (!url) return '(unknown)';
  let file;
  try {
    file = fileURLToPath(url);
  } catch {
    return url;
  }
  return fileToRoute.get(file) ?? url;
}

/**
 * Validate each document by POSTing it to validator.w3.org.
 *
 * Sequential and unhurried on purpose: this is somebody else's free service, and a full run here
 * is around two dozen documents. Nothing about the site is sent that is not already public — every
 * route validated is a page the site serves to anyone.
 */
async function validateWithW3C(documents) {
  const messages = [];
  for (const [path, html] of documents) {
    // A second between documents, and a backoff on 429 — the service rate-limits, and a full run
    // here hit it around the eighth document with no pause at all. This is the reason the jar is
    // the default transport and the one CI uses: a check whose result depends on somebody else's
    // rate limiter is not a check.
    let parsed;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(W3C_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'User-Agent': W3C_USER_AGENT },
        body: html,
      });
      if (res.status === 429 && attempt < 4) {
        const wait = 5000 * 2 ** attempt;
        console.log(`  rate-limited on ${path}; waiting ${wait / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (!res.ok) throw new Error(`validator.w3.org answered ${res.status} for ${path}`);
      parsed = await res.json();
      break;
    }
    for (const message of parsed.messages ?? []) messages.push({ ...message, route: path });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return messages;
}

function describe(message) {
  const where = message.lastLine ? ` line ${message.lastLine}` : '';
  const extract = message.extract ? `\n      ${message.extract.replace(/\s+/g, ' ').trim()}` : '';
  return `  ${message.route}${where}: ${message.message}${extract}`;
}

const chosen = flag('transport', hasJava() ? 'jar' : 'w3c');
if (!['jar', 'w3c'].includes(chosen)) {
  console.error(`validate-html: unknown transport "${chosen}" (expected "jar" or "w3c")`);
  process.exit(2);
}

if (!existsSync(DIST)) {
  console.error('validate-html: no dist/client. Run `npm run build` first.');
  process.exit(2);
}

// `--routes /a,/b` narrows the run to named paths. For the jar that saves nothing worth having;
// it exists for the w3c transport, whose rate limiter makes a full run of two dozen documents a
// slow and sometimes impossible thing to repeat while iterating on one page's markup.
const only = flag('routes', '')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);
const all = builtRoutes();
const unknown = only.filter((path) => !all.includes(path));
if (unknown.length > 0) {
  console.error(`validate-html: no such route(s): ${unknown.join(', ')}`);
  process.exit(2);
}
const paths = only.length > 0 ? only : all;
if (paths.length === 0) {
  console.error(`validate-html: no HTML found under ${relative(root, DIST)}. Run \`npm run build\` first.`);
  process.exit(2);
}

console.log(`validate-html: ${paths.length} route(s) from ${base} via the ${chosen} transport`);
if (chosen === 'w3c') {
  console.log('  (no JRE found, or --transport w3c: each document is POSTed to validator.w3.org)');
}

const documents = [];
for (const path of paths) documents.push([path, await fetchDocument(path)]);

const allMessages = chosen === 'jar' ? validateWithJar(documents) : await validateWithW3C(documents);

const excepted = new Map();
const messages = allMessages.filter((message) => {
  const exception = exceptionFor(message);
  if (!exception) return true;
  const seen = excepted.get(exception.id) ?? { why: exception.why, count: 0 };
  seen.count++;
  excepted.set(exception.id, seen);
  return false;
});

const errors = messages.filter((m) => m.type === 'error');
const warnings = messages.filter((m) => m.type !== 'error');

if (excepted.size > 0) {
  console.log('\nsuppressed by an explicit exception:');
  for (const [id, { why, count }] of excepted) console.log(`  ${id}: ${count} message(s) — ${why}`);
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} warning/info message(s):`);
  for (const message of warnings) console.log(describe(message));
}

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):`);
  for (const message of errors) console.error(describe(message));
  console.error(`\nvalidate-html: FAILED — ${errors.length} error(s) across ${paths.length} route(s).`);
  process.exit(1);
}

console.log(`\nvalidate-html: ${paths.length} route(s) valid, 0 errors, ${warnings.length} warning(s).`);
