import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { hostIsAllowed, LOOPBACK_HOSTS } from '../mcp/http.js';
import {
  CONSOLE_APPROVE_REASON,
  FindingVerdictError,
  type FindingVerdictRequest,
  type FindingVerdictResult,
} from '../lib/finding-verdict.js';
import { isFindingSlug } from '../lib/findings.js';
import type { FindingsModel } from './findings-model.js';
import { renderMessage, renderVerdictMessage } from './message-page.js';

/**
 * `steward console`: a page the Steward CLI serves on 127.0.0.1 while it runs.
 * `/findings` is the first page (findings-dashboard design, 2026-10-31).
 *
 * **The page.** `/findings` is static HTML with one stylesheet (`/findings.css`)
 * and one script (`/findings.js`) from `assets/`, read once at start. The script
 * reads `GET /api/findings` on load and on Refresh, renders the list and the
 * open finding, and posts a verdict to `POST /api/verdict`. The page names its
 * icons under `/icons/`, served from the same folder: nothing is fetched from
 * the network. The only server-rendered HTML is the message page: a refusal, an
 * error, or the answer to the verdict form, which stays for a browser with
 * scripts off.
 *
 * **Who can act.** The listener binds the loopback address only, and three
 * checks stand between another page in the operator's browser and a verdict:
 *
 * 1. Every request's Host must be a loopback name, the DNS-rebinding defence
 *    `src/mcp/http.ts` explains. It runs before the routing.
 * 2. A POST must carry an `Origin` equal to this server's own origin. A form
 *    on another site sends that site's origin, and a browser always sends one
 *    on a cross-origin POST. A missing or `null` Origin is refused. The page
 *    sends `referrer-policy: same-origin` so its own POST carries the real
 *    Origin: under `no-referrer` the browser sends `null` and the guard
 *    refuses the console's own form.
 * 3. A POST must carry the per-process random token, which only a page this
 *    process rendered holds.
 *
 * **The JSON routes.** `GET /api/findings` returns the loader's model, the footer's
 * `cost` included, and `POST /api/verdict` answers the verdict result as JSON. Both sit behind
 * the same Host check; the POST keeps the Origin and token checks of the form route, and a
 * refusal comes back as `{ error }` with the same status code.
 *
 * The page holds no credential of its own: the process reads the same `.env`
 * the CLI reads, and the browser sees only the page, the model and the token.
 */

export interface ConsoleServerOptions {
  port: number;
  loadFindings: () => Promise<FindingsModel>;
  sendVerdict: (request: FindingVerdictRequest) => Promise<FindingVerdictResult>;
  /** IANA zone the page shows its dates in. */
  timeZone: string;
  /** The site's `public/fonts`; the page falls back to the system stack when the files are absent. */
  fontsDir?: string | null;
}

export interface ConsoleServer {
  port: number;
  url: string;
  /** The per-process POST token. */
  token: string;
  close(): Promise<void>;
}

/** The only address the console listens on. */
export const CONSOLE_HOST = '127.0.0.1';

/** The two woff2 files the stylesheet names; nothing else is served from the fonts directory. */
export const CONSOLE_FONTS = ['ibm-plex-sans-latin.woff2', 'ibm-plex-sans-latin-ext.woff2'] as const;

/** The page, its stylesheet, its script and its icons, by URL path: the only files the console serves from `assets/`. */
const ASSETS: Record<string, { file: string; type: string; cache: string }> = {
  '/findings': { file: 'findings.html', type: 'text/html; charset=utf-8', cache: 'no-store' },
  '/findings.css': { file: 'findings.css', type: 'text/css; charset=utf-8', cache: 'no-store' },
  '/findings.js': { file: 'findings.js', type: 'text/javascript; charset=utf-8', cache: 'no-store' },
  '/icons/steward-console.svg': { file: 'icons/steward-console.svg', type: 'image/svg+xml', cache: 'max-age=86400' },
  '/icons/mattpyle-com-16.png': { file: 'icons/mattpyle-com-16.png', type: 'image/png', cache: 'max-age=86400' },
  '/icons/temporal-io.svg': { file: 'icons/temporal-io.svg', type: 'image/svg+xml', cache: 'max-age=86400' },
};
const ASSETS_DIR = new URL('./assets/', import.meta.url);

/** Paths that answer with a redirect to the findings page. */
const REDIRECTS = new Set(['/', '/finding', '/finding/', '/findings/']);

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REASON_CHARS = 2000;

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // Not `no-referrer`: under that policy a browser sends `Origin: null` on the page's own form POST,
  // and the same-origin guard below refuses it. `same-origin` sends no referrer to any other site.
  'referrer-policy': 'same-origin',
};

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Refused(413, 'The form is larger than the console accepts.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function fontsPresent(dir: string | null | undefined): Promise<boolean> {
  if (!dir) return false;
  try {
    await Promise.all(CONSOLE_FONTS.map((name) => fs.access(path.join(dir, name))));
    return true;
  } catch {
    return false;
  }
}

export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  const token = crypto.randomBytes(32).toString('base64url');
  const fonts = await fontsPresent(options.fontsDir);
  const assets = new Map<string, Buffer>();
  for (const [route, asset] of Object.entries(ASSETS)) {
    let bytes = await fs.readFile(new URL(asset.file, ASSETS_DIR));
    // The page's one server value: the zone its dates are shown in, as an attribute the script reads.
    if (route === '/findings') bytes = Buffer.from(bytes.toString('utf8').replace('{{TIME_ZONE}}', escapeAttribute(options.timeZone)));
    assets.set(route, bytes);
  }

  const send = (res: http.ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, ...extra });
    res.end(html);
  };
  const message = (res: http.ServerResponse, status: number, title: string, text: string) =>
    send(res, status, renderMessage(title, text));

  /**
   * The guards and the verdict, shared by the form route and the JSON route:
   * the Origin before the body is read, then the token, then the fields. The
   * form route reads a form; the JSON route reads a form or a JSON object with
   * the same four fields plus the token.
   */
  const decide = async (req: http.IncomingMessage, allowJson: boolean): Promise<FindingVerdictResult & { key: string }> => {
    // The same-origin rule before the body is read: a foreign form gets nothing parsed.
    if (req.headers.origin !== `http://${req.headers.host}`) {
      throw new Refused(403, `Refused: the request's Origin (${req.headers.origin ?? 'none'}) is not this console.`);
    }
    const type = String(req.headers['content-type'] ?? '');
    const isJson = allowJson && type.startsWith('application/json');
    if (!isJson && !type.startsWith('application/x-www-form-urlencoded')) {
      throw new Refused(
        415,
        allowJson
          ? 'Refused: the verdict posts application/json or application/x-www-form-urlencoded.'
          : 'Refused: the verdict form posts application/x-www-form-urlencoded.',
      );
    }
    const raw = await readBody(req);
    let fields: (name: string) => string;
    if (isJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Refused(400, 'Refused: the body is not JSON.');
      }
      const object = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      fields = (name) => (typeof object[name] === 'string' ? (object[name] as string) : '');
    } else {
      const form = new URLSearchParams(raw);
      fields = (name) => form.get(name) ?? '';
    }
    if (!tokensMatch(fields('token'), token)) {
      throw new Refused(403, "Refused: the request does not carry this console's token. Reload /findings and try again.");
    }
    const site = fields('site');
    const key = fields('key');
    const status = fields('verdict');
    if (!isFindingSlug(site) || !isFindingSlug(key)) throw new Refused(400, 'Refused: the site or key is not a finding slug.');
    if (status !== 'approved' && status !== 'rejected') throw new Refused(400, 'Refused: the verdict is approve or reject.');
    const typed = fields('reason').trim();
    if (typed.length > MAX_REASON_CHARS) throw new Refused(400, `Refused: the reason is over ${MAX_REASON_CHARS} characters.`);
    if (status === 'rejected' && !typed) throw new Refused(400, 'A reject needs a reason: say why.');
    const reason = typed || CONSOLE_APPROVE_REASON;

    try {
      return { ...(await options.sendVerdict({ site, key, status, reason })), key };
    } catch (err) {
      if (err instanceof FindingVerdictError) throw new Refused(409, err.message);
      throw err;
    }
  };

  const verdict = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const result = await decide(req, false);
    send(res, 200, renderVerdictMessage(result, result.key));
  };

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Before the routing, for every path: one rule, so a page added later cannot be the one that forgot it.
    if (!hostIsAllowed(req.headers.host, LOOPBACK_HOSTS)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Invalid Host: ${req.headers.host ?? '(missing)'}\n`);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (REDIRECTS.has(url.pathname) && method === 'GET') {
      res.writeHead(302, { location: '/findings', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const asset = ASSETS[url.pathname];
    if (asset && method === 'GET') {
      res.writeHead(200, { ...HEADERS, 'content-type': asset.type, 'cache-control': asset.cache });
      res.end(assets.get(url.pathname));
      return;
    }
    if (url.pathname === '/api/findings') {
      if (method !== 'GET') throw new Refused(405, 'The findings endpoint takes GET only.');
      // The token rides here for the client page to post a verdict. A page on another origin cannot read
      // this response (no CORS headers), and the Host check above stops a rebound name.
      sendJson(res, 200, { ...(await options.loadFindings()), token });
      return;
    }
    if (url.pathname === '/api/verdict') {
      if (method !== 'POST') throw new Refused(405, 'The verdict endpoint takes POST only.');
      const { key: _key, ...result } = await decide(req, true);
      sendJson(res, 200, result);
      return;
    }
    if (url.pathname === '/findings/verdict') {
      if (method !== 'POST') {
        message(res, 405, 'not allowed', 'The verdict endpoint takes the form POST only.');
        return;
      }
      await verdict(req, res);
      return;
    }
    const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname)?.[1];
    if (font && method === 'GET' && fonts && (CONSOLE_FONTS as readonly string[]).includes(font)) {
      const bytes = await fs.readFile(path.join(options.fontsDir as string, font));
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
      res.end(bytes);
      return;
    }
    message(res, 404, 'not found', `Nothing at ${url.pathname}. The findings page is /findings.`);
  };

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (req.url?.startsWith('/api/')) {
        sendJson(res, err instanceof Refused ? err.status : 502, { error: err instanceof Error ? err.message : String(err) });
      } else if (err instanceof Refused) message(res, err.status, 'refused', err.message);
      else message(res, 502, 'error', err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, CONSOLE_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    url: `http://${CONSOLE_HOST}:${port}/findings`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
