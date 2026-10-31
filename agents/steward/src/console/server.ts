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
import { renderFindingsPage, renderMessagePage, renderVerdictResult, type PageOptions } from './findings-page.js';

/**
 * `steward console`: a page the Steward CLI serves on 127.0.0.1 while it runs.
 * `/findings` is the first page (findings-dashboard design, 2026-10-31).
 *
 * **Who can act.** The listener binds the loopback address only, and three
 * checks stand between another page in the operator's browser and a verdict:
 *
 * 1. Every request's Host must be a loopback name, the DNS-rebinding defence
 *    `src/mcp/http.ts` explains. It runs before the routing.
 * 2. A POST must carry an `Origin` equal to this server's own origin. A form
 *    on another site sends that site's origin, and a browser always sends one
 *    on a cross-origin POST.
 * 3. A POST must carry the per-process random token, which only a page this
 *    process rendered holds.
 *
 * The page holds no credential of its own: the process reads the same `.env`
 * the CLI reads, and the browser only ever sees HTML.
 */

export interface ConsoleServerOptions {
  port: number;
  loadFindings: () => Promise<FindingsModel>;
  sendVerdict: (request: FindingVerdictRequest) => Promise<FindingVerdictResult>;
  page: Omit<PageOptions, 'token' | 'fonts'>;
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

/** The four woff2 files the page names; nothing else is served from the fonts directory. */
export const CONSOLE_FONTS = [
  'jetbrains-mono-latin.woff2',
  'jetbrains-mono-latin-ext.woff2',
  'source-serif-4-latin.woff2',
  'source-serif-4-latin-ext.woff2',
] as const;

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REASON_CHARS = 2000;

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
  const page: PageOptions = { ...options.page, token, fonts };

  const send = (res: http.ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, ...extra });
    res.end(html);
  };
  const message = (res: http.ServerResponse, status: number, title: string, text: string) =>
    send(res, status, renderMessagePage(title, text, { fonts }));

  const verdict = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // The same-origin rule before the body is read: a foreign form gets nothing parsed.
    if (req.headers.origin !== `http://${req.headers.host}`) {
      throw new Refused(403, `Refused: the request's Origin (${req.headers.origin ?? 'none'}) is not this console.`);
    }
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('application/x-www-form-urlencoded')) {
      throw new Refused(415, 'Refused: the verdict form posts application/x-www-form-urlencoded.');
    }
    const form = new URLSearchParams(await readBody(req));
    if (!tokensMatch(form.get('token') ?? '', token)) {
      throw new Refused(403, 'Refused: the form does not carry this console\'s token. Reload /findings and try again.');
    }
    const site = form.get('site') ?? '';
    const key = form.get('key') ?? '';
    const status = form.get('verdict');
    if (!isFindingSlug(site) || !isFindingSlug(key)) throw new Refused(400, 'Refused: the site or key is not a finding slug.');
    if (status !== 'approved' && status !== 'rejected') throw new Refused(400, 'Refused: the verdict is approve or reject.');
    const typed = (form.get('reason') ?? '').trim();
    if (typed.length > MAX_REASON_CHARS) throw new Refused(400, `Refused: the reason is over ${MAX_REASON_CHARS} characters.`);
    if (status === 'rejected' && !typed) throw new Refused(400, 'A reject needs a reason: say why.');
    const reason = typed || CONSOLE_APPROVE_REASON;

    let result: FindingVerdictResult;
    try {
      result = await options.sendVerdict({ site, key, status, reason });
    } catch (err) {
      if (err instanceof FindingVerdictError) throw new Refused(409, err.message);
      throw err;
    }
    send(res, 200, renderVerdictResult(result, key, page));
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

    if (url.pathname === '/' && method === 'GET') {
      res.writeHead(302, { location: '/findings' });
      res.end();
      return;
    }
    if (url.pathname === '/findings' && method === 'GET') {
      send(res, 200, renderFindingsPage(await options.loadFindings(), page));
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
      if (err instanceof Refused) message(res, err.status, 'refused', err.message);
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
