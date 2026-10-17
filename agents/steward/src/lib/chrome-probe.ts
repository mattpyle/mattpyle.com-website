import fs from 'node:fs/promises';
import path from 'node:path';
import { STEWARD_DIR } from '../config.js';
import { tempRunName } from './audit-engine.js';
import { killTree } from './proc.js';
import { CheckBroken, CheckUnavailable, VERCEL_BYPASS_HEADER, type PageProbe, type Viewport } from './verify-checks.js';

/**
 * The verifier's browser: the worker's Chromium, one page at a time, asked one
 * expression per page.
 *
 * Each page is sized before it navigates, with `Emulation.setDeviceMetricsOverride`
 * at the check's viewport, so a phone-only defect is measured at phone width.
 *
 * `chrome-launcher` finds the browser the way it does for Lighthouse, through
 * `CHROME_PATH` when it is set. The conversation with it is the DevTools
 * protocol over Node's own `WebSocket`: four commands, so no client library.
 *
 * The page is production or a preview, and the expression comes from a
 * validated `verify` block. It runs inside the page, in the browser's sandbox,
 * and its result comes back by value. Nothing here touches the worker's
 * filesystem or shell.
 *
 * **A preview's bypass secret** is added by the browser's own request
 * interception (the protocol's `Fetch` domain), to requests for the preview's
 * origin only. A page that loads anything from another origin sends it no
 * secret.
 */

const LOAD_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export interface ProbeBypass {
  /** The preview origin the secret is sent to. */
  origin: string;
  secret: string;
}

export async function openChromeProbe(options: {
  userAgent: string;
  bypass?: ProbeBypass;
}): Promise<PageProbe & { close(): Promise<void> }> {
  const { launch } = await import('chrome-launcher');
  const userDataDir = path.join(STEWARD_DIR, '.cache', tempRunName('chrome-verify'));
  await fs.mkdir(userDataDir, { recursive: true });
  const launched = await launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-agent=${options.userAgent}`],
    userDataDir,
  });

  let socket: WebSocket | undefined;
  const close = async () => {
    try {
      socket?.close();
    } catch {
      /* best-effort */
    }
    // The same three guarded steps as `runLighthouse`, for its reason: a
    // synchronous throw from `kill()` must not reach the worker.
    try {
      await launched.kill();
    } catch {
      /* best-effort */
    }
    try {
      killTree(launched.pid);
    } catch {
      /* best-effort */
    }
    // Retried: on Windows the profile stays locked for a moment after the kill.
    await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  };

  try {
    const version = (await (await fetch(`http://127.0.0.1:${launched.port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('the DevTools socket did not open')), { once: true });
    });

    let nextId = 1;
    const pending = new Map<number, Pending>();
    const listeners = new Set<(message: any) => void>();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    });
    ws.addEventListener('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('the DevTools socket closed'));
      pending.clear();
    });

    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    };

    const evaluate = async (url: string, expression: string, viewport: Viewport): Promise<unknown> => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      let onPaused: ((message: any) => void) | undefined;
      try {
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        await send('Page.enable', {}, sessionId);
        // Before the navigation, so the page lays out at this size from its first paint.
        await send(
          'Emulation.setDeviceMetricsOverride',
          { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        if (options.bypass) {
          const { origin, secret } = options.bypass;
          const allowed = new URL(origin).origin;
          onPaused = (message: any) => {
            if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
            const { requestId, request } = message.params;
            const headers = Object.entries(request.headers as Record<string, string>)
              .filter(([name]) => name.toLowerCase() !== VERCEL_BYPASS_HEADER)
              .map(([name, value]) => ({ name, value }));
            if (new URL(request.url).origin === allowed) headers.push({ name: VERCEL_BYPASS_HEADER, value: secret });
            send('Fetch.continueRequest', { requestId, headers }, sessionId).catch(() => {});
          };
          listeners.add(onPaused);
          await send('Fetch.enable', { patterns: [{ urlPattern: `${allowed}/*`, requestStage: 'Request' }] }, sessionId);
        }
        const loaded = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            listeners.delete(onEvent);
            reject(new CheckUnavailable(`${url} did not finish loading in ${LOAD_TIMEOUT_MS / 1000}s`));
          }, LOAD_TIMEOUT_MS);
          const onEvent = (message: any) => {
            if (message.sessionId !== sessionId || message.method !== 'Page.loadEventFired') return;
            clearTimeout(timer);
            listeners.delete(onEvent);
            resolve();
          };
          listeners.add(onEvent);
        });
        loaded.catch(() => {});
        const navigated = await send('Page.navigate', { url }, sessionId);
        if (navigated.errorText) throw new CheckUnavailable(`${url} did not load: ${navigated.errorText}`);
        await loaded;
        const outcome = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (outcome.exceptionDetails) {
          const thrown = outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text;
          throw new CheckBroken(`the expression threw on ${url}: ${String(thrown).split('\n')[0]}`);
        }
        return outcome.result?.value ?? null;
      } finally {
        if (onPaused) listeners.delete(onPaused);
        await send('Target.closeTarget', { targetId }).catch(() => {});
      }
    };

    return { evaluate, close };
  } catch (err) {
    await close();
    throw err;
  }
}
