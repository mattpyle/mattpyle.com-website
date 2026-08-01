import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the deterministic accessibility suite (`npm run a11y`).
 *
 * Advisory, like spellcheck: never in the `build` chain, runnable on demand.
 *
 * The suite targets a SERVED PRODUCTION BUILD, not `astro dev`. Dev renders CSS,
 * fonts and images differently (see CLAUDE.md, Authoring content), and half of
 * what these checks assert — focus rings, reflow, reduced motion — is CSS.
 * `npm run a11y` builds first; `npm run a11y:run` reuses whatever is in
 * dist/client, which is the fast loop while iterating on a check.
 *
 * `npm run preview` is deliberately not used here: the Vercel adapter rejects
 * `astro preview`, so this serves dist/client statically the same way the
 * scoreboard's audit method does.
 */
const PORT = 4321;

export default defineConfig({
  testDir: './tests/a11y',
  // The aria goldens live next to the suite, one file per template, so a diff
  // shows up in review as a readable YAML change.
  snapshotPathTemplate: '{testDir}/__snapshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Zero retries on purpose: this is a spike measuring flake. A retry would
  // hide exactly the signal the card is asking for.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // A desktop viewport for everything except the reflow spec, which overrides it.
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `npx serve dist/client --listen ${PORT} --no-clipboard --no-port-switching`,
    url: `http://localhost:${PORT}`,
    // CI normally refuses to reuse a server, so a stale process cannot make a
    // run pass against yesterday's build. The a11y workflow is the deliberate
    // exception: it has already built once and served dist/client on this port
    // for the axe audit, and `--no-port-switching` means a second `serve` here
    // would not fall back to 4322, it would just fail. A11Y_REUSE_SERVER is the
    // workflow saying "that server is mine, and it is this commit's build".
    reuseExistingServer: !process.env.CI || process.env.A11Y_REUSE_SERVER === '1',
    timeout: 60_000,
  },
});
