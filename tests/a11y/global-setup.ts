import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

/**
 * Refuses to run the suite against a server that is not this checkout's build, started with the
 * fixture environment.
 *
 * `reuseExistingServer` makes Playwright adopt whatever already listens on 4321. On Windows an
 * orphaned `scripts/serve-built-site.mjs` survives its npm parent, so the adopted server can be an
 * earlier build, or one started without `AGENT_TRAFFIC_FIXTURE=1`. Either way the suite then
 * reports on the wrong thing, and the report looks like a real one: a green run on yesterday's
 * build, or a red /activity golden that is really an unavailable-state page.
 *
 * Two checks, both before any spec:
 *
 * 1. /build-stamp.txt from the server must equal dist/client/build-stamp.txt on disk. The server
 *    serves the stamp it read when it started, so a server that predates a rebuild fails here even
 *    though it reads the new files from disk. A 404 fails too: that is a server serving something,
 *    not nothing.
 * 2. /activity must render the fixture rows. The traffic tables read a store at request time, and
 *    the fixture is the only thing that fills them on a laptop or a runner. (/scorecard used to
 *    carry them; it prerenders now and cannot tell a fixture server from any other.)
 *
 * CI is unaffected: the workflow builds once and starts its one server with the fixture variables,
 * so both checks pass there at the cost of two fetches.
 */

const STAMP_FILE = fileURLToPath(new URL('../../dist/client/build-stamp.txt', import.meta.url));

// A row only the fixture renders (src/lib/agent-traffic.mjs, fixtureDayHashes). A server with no
// store renders an empty-state sentence in its place.
const FIXTURE_MARKER = 'perplexitybot';

const PORT_HINT = 'Find the process with `netstat -ano | findstr 4321`, stop it with `taskkill /PID <pid> /F`, then run again.';

function excerpt(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > 120 ? `${flat.slice(0, 120)}...` : flat || '(empty)';
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('a11y global setup: no baseURL in playwright.config.ts');

  let expected: string;
  try {
    expected = readFileSync(STAMP_FILE, 'utf8').trim();
  } catch {
    throw new Error(
      'a11y global setup: dist/client/build-stamp.txt is missing. Run `npm run build` first (`npm run a11y` does).'
    );
  }

  const stampResponse = await fetch(new URL('/build-stamp.txt', baseURL));
  const found = (await stampResponse.text()).trim();
  if (stampResponse.status !== 200 || found !== expected) {
    const shown = stampResponse.status === 200 ? excerpt(found) : `HTTP ${stampResponse.status}, ${excerpt(found)}`;
    throw new Error(
      [
        `a11y global setup: the server on ${baseURL} is not serving this checkout's build.`,
        `  expected stamp: ${expected}`,
        `  found stamp:    ${shown}`,
        `A server left over from an earlier build was adopted. ${PORT_HINT}`,
      ].join('\n')
    );
  }

  const activity = await (await fetch(new URL('/activity', baseURL))).text();
  if (!activity.includes(FIXTURE_MARKER)) {
    throw new Error(
      [
        `a11y global setup: /activity on ${baseURL} does not show the traffic fixture rows.`,
        'The server was started without AGENT_TRAFFIC_FIXTURE=1, so every traffic table renders its unavailable state.',
        `A server left over from a manual \`npm run serve\` was adopted. ${PORT_HINT}`,
      ].join('\n')
    );
  }
}
