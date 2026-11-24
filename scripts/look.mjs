#!/usr/bin/env node
/**
 * Look at built pages, aimed at the text that changed:
 *
 *   npm run look -- [--label <name>] <path> [--find "<text>"] [<path> [--find "<text>"] ...]
 *
 * Builds the site without drafts, serves the build on 127.0.0.1 with the two fixture variables the
 * audits use, and for each path leaves in one folder:
 *
 * - a phone (390 px) and a desktop (1280 px) picture, one screen each, scrolled so the `--find`
 *   text sits mid-screen, or to the path's `#fragment`, or at the top when neither is given;
 * - the page's visible text and its rendered HTML, both taken at desktop width, and its markdown
 *   twin. The HTML is the document as the browser holds it once the page has loaded and settled:
 *   attributes, meta tags, structured data and accessibility labels are in it and not in the text.
 *   Lines break only between block-level elements, where whitespace changes nothing on the page;
 *   inside a paragraph the markup is exactly the browser's, so `</code>spends` and
 *   `</code> spends` stay different.
 *
 * The folder is the last line of the output: `.look/<time>` or, with `--label`, `.look/<time>-<label>`,
 * so a look taken before an edit and one taken after can be told apart.
 *
 * It exists so a fixer that edits a page can see the change before it pushes. The fixer runs it
 * from an allowlist, so the browser's fence is held here, not in the caller:
 *
 * - A path starts with a single `/` and is resolved against the local server only. A full URL, a
 *   protocol-relative `//host` or a backslash is refused.
 * - `--find` text is only ever matched against the page's text (Playwright's `getByText`). It
 *   never becomes a URL, a selector source or a script, and it is refused if empty, over 200
 *   characters, or holding control characters.
 * - The browser aborts every request to any other origin, so a page cannot pull in, or send text
 *   to, anything outside the build.
 * - No drafts: SHOW_DRAFTS is removed before the build, so draft text cannot reach a picture, a
 *   text file or a public pull request body.
 * - The output folder, `.look/`, is inside the checkout and gitignored.
 *
 * The build itself runs the repository's code, as `npm test` does; the fence is the browser's.
 *
 * An aim that misses fails: `--find` text that is not on the page as written, or a `#fragment`
 * with no target, is reported, its pictures are of the top, the other paths still run, and the
 * command exits 1. A fixer that aims at the sentence it has just written learns this way that the
 * sentence did not render as written, the joined word a picture can hide. Text that is on the page
 * but hidden at one width is a note. So are a path that is not an HTML page (`/agents.md`) and one
 * with no twin. Exit 1 also when the build or the server fails, an argument is refused, or a path
 * does not resolve.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markdownSiblingFor } from '../src/lib/markdown-negotiation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Phone and desktop widths; each height is the common screen for its width. */
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

/** The width the text and HTML files are taken at. */
const TEXT_WIDTH = 1280;

const FIND_MAX = 200;

const USAGE =
  'Usage: npm run look -- [--label <name>] <path> [--find "<text>"] [<path> [--find "<text>"] ...], each path starting with /';

const CANNOT_SHOW = [
  'Not shown: the edge middleware (no Accept negotiation, no /builds redirect, no Link header, no trailing-slash 308).',
  'Not shown: the retro appearance; pictures are the modern appearance.',
  `Text and HTML: saved at desktop width (${TEXT_WIDTH} px) only, so text or markup only at phone width is in the pictures, not in the .txt or .html.`,
];

/**
 * Why a path is refused, or null when it is a site path. Checked against a stand-in origin before
 * the build, so a bad argument fails in a second rather than after one.
 * @param {unknown} path
 */
export function pathRefusal(path) {
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

/**
 * Why `--find` text is refused, or null. The text is only matched against the page's own text,
 * so the rule is about keeping it a short piece of visible prose.
 * @param {unknown} text
 */
export function findRefusal(text) {
  if (typeof text !== 'string' || text.trim() === '') return '--find needs some text';
  if (text.length > FIND_MAX) return `--find text must be at most ${FIND_MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(text)) return '--find text must not hold control characters';
  return null;
}

/**
 * Why a label is refused, or null. It becomes part of a folder name, so letters, digits and
 * hyphens only.
 * @param {unknown} label
 */
export function labelRefusal(label) {
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) {
    return '--label must be 1 to 32 lower-case letters, digits or hyphens, starting with a letter or digit';
  }
  return null;
}

/**
 * The arguments as a label and a list of aims, each a path with its optional `--find` text, and
 * the refusals, each a line to print. `--find` belongs to the path before it; to aim at two
 * places on one page, name the page twice.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ path: string, find: string | null }[]} */
  const aims = [];
  /** @type {string[]} */
  const refusals = [];
  /** @type {string | null} */
  let label = null;
  /** @type {{ path: string, find: string | null } | null} */
  let last = null;
  let lastRefused = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') {
      const value = argv[++i];
      const refusal = labelRefusal(value);
      if (refusal) refusals.push(`--label ${value ?? ''}: refused, ${refusal}.`);
      else if (label !== null) refusals.push('--label: refused, give it once.');
      else label = value;
    } else if (arg === '--find') {
      const value = argv[++i];
      const refusal = findRefusal(value);
      if (refusal) refusals.push(`--find ${JSON.stringify(value ?? '')}: refused, ${refusal}.`);
      else if (lastRefused) continue;
      else if (!last) refusals.push(`--find ${JSON.stringify(value)}: refused, it needs a path before it.`);
      else if (last.find !== null) refusals.push(`--find ${JSON.stringify(value)}: refused, one --find per path; name the path again.`);
      else last.find = value;
    } else if (arg.startsWith('--')) {
      refusals.push(`${arg}: refused, the options are --label and --find.`);
    } else {
      const refusal = pathRefusal(arg);
      if (refusal) {
        refusals.push(`${arg}: refused, ${refusal}.`);
        last = null;
        lastRefused = true;
      } else {
        last = { path: arg, find: null };
        lastRefused = false;
        aims.push(last);
      }
    }
  }
  return { label, aims, refusals };
}

/** A file name for a path: `/` -> `index`, `/writing/foo/#bar` -> `writing-foo-bar`. */
export function slugFor(path) {
  const { pathname, hash } = new URL(path, 'http://127.0.0.1');
  const slug = `${pathname}${hash ? `-${hash.slice(1)}` : ''}`
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+$/, '');
  return slug || 'index';
}

/**
 * Elements whose edges are block boundaries in the site's layout, document-level elements and
 * table parts included. Whitespace beside one of these renders as nothing, so a line break there
 * changes nothing on the page.
 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'blockquote', 'body', 'caption', 'col', 'colgroup', 'dd',
  'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'li', 'link',
  'main', 'meta', 'nav', 'noscript', 'ol', 'p', 'pre', 'script', 'section', 'style', 'summary',
  'table', 'tbody', 'td', 'template', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul',
]);

/** Elements whose content is copied as it is: code, scripts and styles. */
const RAW_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

/** A tag, with quoted attribute values that may hold `>`. */
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/**
 * The rendered HTML with line breaks between block-level elements, so a search for an attribute
 * or a label lands on a short line. A gap between two tags gets a line break only where it changes
 * nothing on the page: an empty gap between two block tags, or a whitespace gap beside one. Every
 * other byte is the browser's, so inline markup keeps its whitespace exactly (`</a> <a>` against
 * `</a><a>`, `</code> spends` against `</code>spends`), and `pre`, `script`, `style` and
 * `textarea` content is copied untouched.
 * @param {string} html
 */
export function readableHtml(html) {
  let out = '';
  let at = 0;
  let afterTag = false;
  let afterBlock = false;
  const lower = html.toLowerCase();
  TAG.lastIndex = 0;
  for (let match = TAG.exec(html); match; match = TAG.exec(html)) {
    const tag = match[0];
    const gap = html.slice(at, match.index);
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1].toLowerCase() ?? null;
    const block = name ? BLOCK_TAGS.has(name) : /^<!doctype/i.test(tag);
    const breakable = afterTag && /^\s*$/.test(gap) && (gap === '' ? afterBlock && block : afterBlock || block);
    out += breakable ? '\n' : gap;
    out += tag;
    at = TAG.lastIndex;
    afterTag = true;
    afterBlock = block;
    if (name && RAW_TAGS.has(name) && !tag.startsWith('</') && !tag.endsWith('/>')) {
      const close = lower.indexOf(`</${name}`, at);
      const end = close < 0 ? html.length : close;
      out += html.slice(at, end);
      at = end;
      TAG.lastIndex = end;
      afterTag = false;
    }
  }
  return out + html.slice(at);
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

/** A browser context that reaches only `origin`. */
async function fencedContext(browser, origin, options) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...options });
  await context.route('**/*', (route) => {
    const target = new URL(route.request().url());
    if (target.origin === origin) return route.continue();
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  return context;
}

/** Two frames for layout and paint, then any image now in view, lazy ones included. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const inView = [...document.images].filter((img) => {
      if (img.complete) return false;
      const box = img.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight;
    });
    await Promise.race([
      Promise.all(inView.map((img) => img.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, 3_000)),
    ]);
  });
}

/**
 * Scroll the page to what the aim names. Returns null when it got there, `{ miss }` when the aim is
 * not on the page at all (a failure), or `{ note }` when it is there but hidden at this width.
 * Either way the picture is then of the top.
 */
async function aimPage(page, url, find, width) {
  if (find !== null) {
    const visible = page.getByText(find).filter({ visible: true }).first();
    if ((await visible.count()) === 0) {
      const anywhere = await page.getByText(find).count();
      return anywhere > 0
        ? { note: `--find text is on the page but not visible at ${width} px; picture of the top` }
        : {
            miss: 'the --find text is not on the page as written. If you wrote it, check for a joined word or a part that did not render.',
          };
    }
    await visible.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    return null;
  }
  if (url.hash) {
    const found = await page.evaluate((hash) => {
      const id = decodeURIComponent(hash.slice(1));
      const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
      if (!target) return false;
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      return true;
    }, url.hash);
    return found ? null : { miss: `${url.hash} has no target on the page. Check the id it points at.` };
  }
  return null;
}

async function main() {
  const { label, aims, refusals } = parseArgs(process.argv.slice(2));
  if (aims.length === 0 && refusals.length === 0) {
    console.error(USAGE);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  const folder = join(root, '.look', label ? `${stamp}-${label}` : stamp);
  mkdirSync(folder, { recursive: true });

  let failed = refusals.length > 0;
  for (const line of refusals) console.log(line);

  const finish = (code) => {
    for (const line of CANNOT_SHOW) console.log(line);
    console.log(folder);
    return code;
  };

  if (aims.length === 0) return finish(1);

  // No drafts, whatever the caller's shell holds.
  const env = { ...process.env };
  delete env.SHOW_DRAFTS;

  console.log(`Building the site without drafts${label ? ` (look labelled "${label}")` : ''}...`);
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

    const { chromium } = await import('@playwright/test');
    // Playwright's own Chromium by default. CHROME_PATH, as Steward reads it, points at another
    // build for a machine whose browser does not match this Playwright release.
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    const used = new Set();

    for (const { path, find } of aims) {
      let slug = slugFor(path);
      for (let n = 2; used.has(slug); n++) slug = `${slugFor(path)}-${n}`;
      used.add(slug);
      const url = new URL(path, origin);
      const heading = find === null ? path : `${path} --find ${JSON.stringify(find)}`;

      // The first width answers whether the path is a page at all.
      const probe = await fencedContext(browser, origin, {});
      let response;
      try {
        const page = await probe.newPage();
        response = await page.goto(url.href, { waitUntil: 'networkidle' });
      } catch (error) {
        console.log(`${heading}: does not resolve (${error instanceof Error ? error.message.split('\n')[0] : error}).`);
        failed = true;
        await probe.close();
        continue;
      }
      const status = response?.status() ?? 0;
      if (status < 200 || status >= 400) {
        console.log(`${heading}: does not resolve (HTTP ${status || 'no response'}).`);
        failed = true;
        await probe.close();
        continue;
      }
      const type = (response?.headers()['content-type'] ?? '').split(';')[0].trim();
      if (type !== 'text/html') {
        writeFileSync(join(folder, `${slug}.txt`), await response.text());
        console.log(`${heading}: not an HTML page (${type || 'no content type'}): no pictures, no twin. Served text: ${slug}.txt`);
        await probe.close();
        continue;
      }
      await probe.close();

      const aimed = [];
      const notes = new Set();
      /** Why the aim failed, when it is not on the page at all. */
      let miss = null;
      /** The widths whose picture is of the top because the aim was not found there. */
      const missed = [];
      for (const size of WIDTHS) {
        const viewport = { width: size.width, height: size.height };

        const context = await fencedContext(browser, origin, { viewport });
        try {
          const page = await context.newPage();
          await page.goto(url.href, { waitUntil: 'networkidle' });
          await settle(page);
          const aim = await aimPage(page, url, find, size.width);
          if (aim) {
            if (aim.miss) miss = aim.miss;
            else notes.add(aim.note);
            missed.push(size.width);
          }
          await settle(page);
          const file = `${slug}-${size.width}.png`;
          await page.screenshot({ path: join(folder, file) });
          aimed.push(file);
          if (size.width === TEXT_WIDTH) {
            writeFileSync(join(folder, `${slug}.txt`), `${await page.locator('body').innerText()}\n`);
            writeFileSync(join(folder, `${slug}.html`), `${readableHtml(await page.content())}\n`);
          }
        } finally {
          await context.close();
        }
      }

      const aimedAt = find !== null ? 'at the --find text' : url.hash ? `at ${url.hash}` : 'at the top';
      const where =
        missed.length === 0 ? aimedAt
        : missed.length === WIDTHS.length ? 'at the top'
        : `${aimedAt}, except at ${missed.join(' and ')} px, at the top`;
      const parts = [
        `${aimed.join(', ')} (one screen each, ${where})`,
        `${slug}.txt and ${slug}.html (visible text and rendered HTML, at desktop width, ${TEXT_WIDTH} px)`,
      ];
      const twin = markdownSiblingFor(url.pathname);
      if (twin === null) {
        notes.add('no twin (the path has no markdown sibling)');
      } else {
        const twinResponse = await fetch(new URL(twin, origin));
        if (twinResponse.ok) {
          writeFileSync(join(folder, `${slug}.md`), await twinResponse.text());
          parts.push(`${slug}.md (twin)`);
        } else {
          notes.add(`no twin (${twin} answered HTTP ${twinResponse.status})`);
        }
      }
      console.log(`${heading}: ${parts.join('; ')}${notes.size ? `. Note: ${[...notes].join('; ')}` : ''}.`);
      if (miss) {
        console.log(`${heading}: FAILED, ${miss}`);
        failed = true;
      }
    }
  } finally {
    await browser?.close();
    stopServer();
  }

  return finish(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
