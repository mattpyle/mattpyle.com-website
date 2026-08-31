// @ts-check
//
// DEV-ONLY Astro config: the production config plus the Keystatic admin UI.
//
// The gate, and why it holds at the artifact level rather than by promise:
//
//   - `astro.config.mjs` is the config every build loads (`npm run build` runs a
//     bare `astro build`, and Vercel runs `npm run build`). It does not import
//     @keystatic/astro, @astrojs/react, or this file. A module the config graph
//     never reaches cannot put a chunk in `dist/client`, a hash in the CSP, or a
//     route in `.vercel/output/config.json`.
//   - This file is loaded only by `astro dev --config astro.config.dev.mjs`, the
//     `dev` script in package.json. `--config` is per-invocation; there is no
//     spelling of `astro build` in this repo or on Vercel that picks it up.
//   - Keystatic and React are devDependencies, so nothing in the production
//     dependency tree can pull them in either.
//
// Everything else is the production config verbatim, spread below, so the dev
// server keeps the site's real CSP, sitemap, adapter and build settings. Editing
// astro.config.mjs is still the only way to change any of them.
import base from './astro.config.mjs';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';

export default {
  ...base,
  integrations: [react(), keystatic(), ...(base.integrations ?? [])],
};
