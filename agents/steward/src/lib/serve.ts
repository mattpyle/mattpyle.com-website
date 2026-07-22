import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * A minimal static file server for the audited build output.
 *
 * **In-process, not a child process.** Spec §8.5 step 4 offered "`npm run
 * preview` or a tiny static server". `npm run preview` is not available here at
 * all — the `@astrojs/vercel` adapter rejects `astro preview` outright — so the
 * choice was between spawning a static server binary and running one in-process.
 * In-process wins for the property this leg actually cares about: **a server
 * that cannot be orphaned.** A spawned server survives a `SIGKILL`ed worker and
 * holds its port; an `http.Server` in the worker's own process dies with it.
 * That matters because the verification for this phase includes killing the
 * worker mid-build and confirming no stray processes remain.
 *
 * **Document root is `dist/client`, not `dist`.** The Vercel adapter emits the
 * static assets one level down. Serving `dist/` yields 404s for every page.
 *
 * Astro's build emits `/writing/<slug>/index.html` as a real directory, so
 * directory-index resolution is all that is needed — no cleanUrls or
 * trailing-slash rewriting has to be emulated.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.md': 'text/markdown; charset=utf-8',
};

export interface StaticServer {
  /** e.g. `http://127.0.0.1:53124` — no trailing slash. */
  origin: string;
  port: number;
  close(): Promise<void>;
}

/** Resolves a URL path to a file inside root, or null if it escapes/misses. */
async function resolveFile(root: string, urlPath: string): Promise<string | null> {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  // Path traversal guard: resolve, then require the result stay under root.
  const candidate = path.resolve(root, '.' + path.posix.normalize(decoded));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;

  for (const attempt of [candidate, path.join(candidate, 'index.html'), candidate + '.html']) {
    try {
      const st = await fs.stat(attempt);
      if (st.isFile()) return attempt;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/** Starts a static server on an ephemeral port (`:0` — the OS picks a free one). */
export async function serveStatic(rootDir: string): Promise<StaticServer> {
  const root = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    void (async () => {
      const file = await resolveFile(root, req.url ?? '/');
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      try {
        const body = await fs.readFile(file);
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': body.length,
        });
        res.end(body);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Read error');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1, not 0.0.0.0: this serves an unpublished draft. It should not be
    // reachable from the network even for the seconds the audit takes.
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Idle keep-alive sockets from Chrome would otherwise hold `close()` open
        // well past the activity's own lifetime.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
