#!/usr/bin/env node
/**
 * Serve a production build locally, including the routes that render on demand.
 *
 * `npx serve dist/client` was enough while every page prerendered to a file. /scorecard no longer
 * does — its Agent traffic section reads the hit store at request time — so a static server
 * answers 404 for one of the seven routes the accessibility audits cover, and for its `.md`
 * sibling. This serves dist/client exactly as before and falls back to the adapter's own render
 * function for anything not on disk, which is the same ordering Vercel uses (`handle: filesystem`
 * first, then the function routes).
 *
 * Deliberately not `vercel dev`: that wants the CLI, a linked project and a login, and this has to
 * run on a CI runner and on Matt's machine with neither. Deliberately not `astro preview` either:
 * the Vercel adapter rejects it outright (see playwright.config.ts).
 *
 * RESTART IT AFTER A REBUILD. Static files are read from disk per request, but the adapter's
 * render function is imported once and held in memory, so a rebuild mid-session leaves this
 * serving the previous build's HTML against the new build's asset hashes — which looks like the
 * page lost its stylesheet, not like a stale server.
 *
 * Usage:
 *   node scripts/serve-built-site.mjs [--port 4321] [--root dist/client] [--host 127.0.0.1]
 *
 * AGENT_TRAFFIC_FIXTURE=1 makes the traffic section render canned numbers instead of its
 * unavailable state, so the audits see the tables. See src/lib/agent-traffic.mjs.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);

/** @param {string} flag @param {string} fallback */
function option(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const port = Number(option('--port', option('-l', '4321')));
const host = option('--host', '127.0.0.1');
const root = resolve(option('--root', join('dist', 'client')));
const renderEntry = resolve('.vercel/output/functions/_render.func/dist/server/entry.mjs');

if (!existsSync(root)) {
  console.error(`serve-built-site: no build at ${root} — run \`npm run build\` first.`);
  process.exit(1);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * The file a URL path maps to, or null. Mirrors `serve`'s resolution order, which is what the
 * audits have been reading all along: exact file, then `.html`, then `index.html`.
 *
 * @param {string} pathname
 */
function staticFileFor(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = resolve(root, relative);

  // Path traversal: a request for /../.env must not escape the build directory.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  for (const path of [candidate, `${candidate}.html`, join(candidate, 'index.html')]) {
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not there; try the next shape.
    }
  }
  return null;
}

/** The adapter's fetch handler, imported once, lazily: a static-only build has none. */
let renderer;
async function render(request) {
  if (!renderer) {
    if (!existsSync(renderEntry)) return new Response('Not found', { status: 404 });
    renderer = (await import(pathToFileURL(renderEntry).href)).default;
  }
  return renderer.fetch(request);
}

/** A Node request as a web Request, so the adapter entry can be called directly. */
function toWebRequest(nodeRequest, origin) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = !['GET', 'HEAD'].includes(nodeRequest.method ?? 'GET');
  return new Request(new URL(nodeRequest.url ?? '/', origin), {
    method: nodeRequest.method,
    headers,
    ...(hasBody ? { body: nodeRequest, duplex: 'half' } : {}),
  });
}

const server = createServer(async (request, response) => {
  const origin = `http://localhost:${port}`;
  const { pathname } = new URL(request.url ?? '/', origin);

  const file = staticFileFor(pathname);
  if (file) {
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(response);
    return;
  }

  try {
    const rendered = await render(toWebRequest(request, origin));
    const headers = Object.fromEntries(rendered.headers.entries());
    response.writeHead(rendered.status, headers);
    if (rendered.body) {
      for await (const chunk of rendered.body) response.write(chunk);
    }
    response.end();
  } catch (error) {
    console.error(`serve-built-site: render failed for ${pathname}:`, error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('render failed');
  }
});

// 127.0.0.1, not the wildcard bind, for the same reason agents/steward/src/lib/serve.ts:99 gives:
// "this serves an unpublished draft. It should not be reachable from the network even for the
// seconds the audit takes." Here it is a SHOW_DRAFTS build, whose index pages enumerate every
// draft, so the wildcard bind hands the whole set to anyone scanning the subnet for the port.
// --host exists for the rare case where a LAN device (a phone on the same wifi) must reach it.
server.listen(port, host, () => {
  console.log(`serve-built-site: ${root} on http://${host}:${port} (on-demand routes rendered)`);
});
