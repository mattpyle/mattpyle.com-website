#!/usr/bin/env node
/**
 * Look at built pages: `npm run look -- <path> [<path>...]`.
 *
 * Builds the site without drafts, serves the build on 127.0.0.1 with the two fixture variables the
 * audits use, and for each path leaves in one folder: the viewport at 390 and at 1280 pixels wide,
 * the page's visible text, and its markdown twin. The folder is the last line of the output.
 *
 * It exists so a fixer that edits a page can see the page before it pushes. The fixer runs it from
 * an allowlist, so the command is the fence and holds it here, not in the caller:
 *
 * - A path starts with a single `/` and is resolved against the local server only. A full URL, a
 *   protocol-relative `//host` or a backslash is refused.
 * - The browser aborts every request to any other origin, so a page cannot pull in, or send text
 *   to, anything outside the build.
 * - No drafts: SHOW_DRAFTS is removed before the build, so draft text cannot reach a picture, a
 *   text file or a public pull request body.
 * - The output folder, `.look/`, is inside the checkout and gitignored.
 *
 * A path that is served but is not an HTML page (`/agents.md`, `/llms.txt`) or has no twin is
 * reported and is not a failure. Exit 1 only when the build or the server fails, or a path is
 * refused or does not resolve.
 *
 * Usage: npm run look -- /steward/ /writing/ /agents.md
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { markdownSiblingFor } from '../src/lib/markdown-negotiation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Phone and laptop widths; the heights are the common viewport for each width. */
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

const CANNOT_SHOW = [
  'Not shown: the edge middleware (no Accept negotiation, no /builds redirect, no Link header, no trailing-slash 308).',
  'Not shown: the retro appearance; pictures are the modern appearance.',
];

/**
 * Why a path is refused, or null when it is a site path. Checked against a stand-in origin before
 * the build, so a bad argument fails in a second rather than after one.
 * @param {string} path
 */
function pathRefusal(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'a path must start with /';
  if (path.startsWith('//')) return 'a path must not start with //';
  if (path.includes('\\')) return 'a path must not hold a backslash';
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'a path must not hold control characters';
  const origin = 'http://127.0.0.1:9';
  let url;
  try {
    url = new URL(path, origin);
  } catch {
    return 'a path must parse as a URL path';
  }
  if (url.origin !== origin) return 'a path must stay on the local server';
  return null;
}

/** A file name for a path: `/` -> `index`, `/writing/foo/` -> `writing-foo`. */
function slugFor(path) {
  const { pathname } = new URL(path, 'http://127.0.0.1');
  const slug = pathname.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return slug || 'index';
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolvePort(port));
    });
  });
}

/** Run a command with its output in a log file. Resolves to the exit code. */
function run(command, args, env, logFile) {
  return new Promise((resolveRun) => {
    const log = createWriteStream(logFile);
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('close', (code) => log.end(() => resolveRun(code ?? 1)));
  });
}

function tail(file, lines = 30) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function waitForServer(origin, server, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;
    try {
      await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('Usage: npm run look -- <path> [<path>...], each path starting with /');
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  const folder = join(root, '.look', stamp);
  mkdirSync(folder, { recursive: true });

  let failed = false;
  /** @type {string[]} */
  const accepted = [];
  for (const path of paths) {
    const refusal = pathRefusal(path);
    if (refusal) {
      console.log(`${path}: refused, ${refusal}.`);
      failed = true;
    } else {
      accepted.push(path);
    }
  }

  const finish = (code) => {
    for (const line of CANNOT_SHOW) console.log(line);
    console.log(folder);
    return code;
  };

  if (accepted.length === 0) return finish(1);

  // No drafts, whatever the caller's shell holds.
  const env = { ...process.env };
  delete env.SHOW_DRAFTS;

  console.log('Building the site without drafts...');
  const buildLog = join(folder, 'build.log');
  if ((await run('npm', ['run', 'build'], env, buildLog)) !== 0) {
    console.log(`The build failed. Its last lines (all of it in ${buildLog}):\n${tail(buildLog)}`);
    return finish(1);
  }

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverLog = createWriteStream(join(folder, 'server.log'));
  const server = spawn(
    process.execPath,
    [resolve(root, 'scripts/serve-built-site.mjs'), '--port', String(port), '--host', '127.0.0.1'],
    {
      cwd: root,
      env: { ...env, AGENT_TRAFFIC_FIXTURE: '1', AUDIT_REPORT_FIXTURE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  const stopServer = () => {
    if (server.exitCode === null) server.kill();
  };
  process.once('SIGINT', () => {
    stopServer();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stopServer();
    process.exit(143);
  });

  let browser;
  try {
    if (!(await waitForServer(origin, server))) {
      console.log(`The server did not start. See ${join(folder, 'server.log')}.`);
      return finish(1);
    }

    // Playwright's own Chromium by default. CHROME_PATH, as Steward reads it, points at another
    // build for a machine whose browser does not match this Playwright release.
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    const used = new Set();

    for (const path of accepted) {
      let slug = slugFor(path);
      for (let n = 2; used.has(slug); n++) slug = `${slugFor(path)}-${n}`;
      used.add(slug);
      const url = new URL(path, origin);
      const notes = [];

      const context = await browser.newContext({ serviceWorkers: 'block' });
      // The fence: nothing leaves the local server.
      await context.route('**/*', (route) => {
        const target = new URL(route.request().url());
        if (target.origin === origin) return route.continue();
        return route.abort('blockedbyclient');
      });
      await context.routeWebSocket(/.*/, (ws) => ws.close());

      try {
        const page = await context.newPage();
        let response;
        try {
          response = await page.goto(url.href, { waitUntil: 'networkidle' });
        } catch (error) {
          console.log(`${path}: does not resolve (${error instanceof Error ? error.message.split('\n')[0] : error}).`);
          failed = true;
          continue;
        }
        const status = response?.status() ?? 0;
        if (status < 200 || status >= 400) {
          console.log(`${path}: does not resolve (HTTP ${status || 'no response'}).`);
          failed = true;
          continue;
        }

        const type = (response?.headers()['content-type'] ?? '').split(';')[0].trim();
        if (type !== 'text/html') {
          writeFileSync(join(folder, `${slug}.txt`), await response.text());
          console.log(`${path}: not an HTML page (${type || 'no content type'}): no pictures, no twin. Served text: ${slug}.txt`);
          continue;
        }

        const files = [];
        for (const size of WIDTHS) {
          await page.setViewportSize(size);
          await page.goto(url.href, { waitUntil: 'networkidle' });
          await page.evaluate(() => document.fonts.ready);
          const file = `${slug}-${size.width}.png`;
          await page.screenshot({ path: join(folder, file) });
          files.push(file);
        }
        // The text at the wider width, the last one loaded.
        writeFileSync(join(folder, `${slug}.txt`), `${await page.locator('body').innerText()}\n`);
        files.push(`${slug}.txt`);

        const twin = markdownSiblingFor(url.pathname);
        if (twin === null) {
          notes.push('no twin (the path has no markdown sibling)');
        } else {
          const twinResponse = await fetch(new URL(twin, origin));
          if (twinResponse.ok) {
            writeFileSync(join(folder, `${slug}.md`), await twinResponse.text());
            files.push(`${slug}.md`);
          } else {
            notes.push(`no twin (${twin} answered HTTP ${twinResponse.status})`);
          }
        }
        console.log(`${path}: ${files.join(', ')}${notes.length ? `; ${notes.join('; ')}` : ''}.`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    stopServer();
  }

  return finish(failed ? 1 : 0);
}

process.exitCode = await main();
