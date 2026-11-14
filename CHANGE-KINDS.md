# Change kinds

What a common change to this site touches, and what holds each surface. A surface is either generated from one source, checked by a test or validator that fails with the surface named, or left to a person. Built so far: the first two kinds. The rest are listed so the next build starts from the same table, and marked "not yet".

`llms.txt` and `agents.md` stay hand-written. They are checked, never generated.

## A new page

Add the page under `src/pages/`, then:

| Surface | File | Held by |
|---|---|---|
| Section and page registry | `src/data/site-sections.mjs` | `tests/change-kinds-pages.test.mjs` fails and names the page |
| WebMCP index | `src/pages/webmcp/index.json.ts` | Generated from the registry |
| A2A digest | `scripts/generate-a2a-digest.mjs` | Generated from the registry |
| `llms.txt` pages list | `src/pages/llms.txt.ts` | `tests/change-kinds-pages.test.mjs` fails and names the page |
| `agents.md` content structure | `public/agents.md` | `tests/change-kinds-pages.test.mjs` fails and names the page |
| Hit-counter page paths | `scripts/generate-page-paths.mjs` | Generated from `src/pages` |
| Markdown negotiation | `middleware.ts` | `tests/markdown-negotiation.test.mjs` |
| Markdown alternate `Link` headers | `vercel.json` | Not yet |
| Sitemap `lastmod` | `src/data/sitemap-lastmod.mjs` | `scripts/validate-sitemap.mjs` (not confirmed for a missing static entry) |
| Retro and axe route lists | `scripts/lib/retro-routes.mjs` | Not yet |
| Share cards | `scripts/generate-og-images.mjs` | Not yet |
| Header and footer | `src/components/SiteHeader.astro` | Not yet, by hand |

A page left out of a surface on purpose goes on the exemption list in `tests/change-kinds-pages.test.mjs`, with a reason.

## An agent endpoint method

Add the method name and its phrase in `src/lib/a2a-methods.mjs`, then:

| Surface | File | Held by |
|---|---|---|
| Method list the responder dispatches on | `src/lib/a2a-responder.mjs` | `tests/change-kinds-a2a-methods.test.mjs` ties the list to the constants |
| Endpoint description in the A2A digest | `scripts/generate-a2a-digest.mjs` | Generated from the list |
| Unknown-method error sentence | `src/lib/a2a-responder.mjs` | Generated from the list |
| Census legend | `src/lib/activity-summary.mjs` | Generated from the list |
| Census method list | `src/lib/agent-hits.mjs` | `tests/a2a-census.test.mjs` |
| Method prose in `agents.md` | `public/agents.md` | `tests/change-kinds-a2a-methods.test.mjs` fails and names the method |
| A2A line in `llms.txt` | `src/pages/llms.txt.ts` | `tests/change-kinds-a2a-methods.test.mjs` fails and names the method |

## A new skill

Not yet, apart from the rows below.

| Surface | File | Held by |
|---|---|---|
| Agent Card skills | `public/.well-known/agent-card.json` | `tests/a2a-card.test.mjs` |
| Discovery catalogue entry | `public/.well-known/ard.json` | `scripts/validate-ard-manifest.mjs` ties its A2A capabilities to the Agent Card |
| Skill prose in `llms.txt`, `agents.md` and the Steward page | `src/pages/llms.txt.ts` | Not yet |

## Other kinds

| Kind | Held by |
|---|---|
| A new on-demand route (`src/lib/on-demand-routes.mjs`, `middleware.ts`) | `tests/on-demand-routes.test.mjs` for the matcher; sitemap and sibling lists not yet |
| A changed fact about the site or its author | Not yet |
| A new content collection (`src/content.config.ts`) | `tests/frontmatter-readers.test.mjs` for the readers; the per-collection loops not yet |
| A new post or changelog entry | Generated from the collections; `updated:` by hand |
| A new feed or data endpoint | Not yet |
| A new well-known document | `scripts/validate-a2a-card.mjs`, `scripts/validate-ard-manifest.mjs` and `scripts/validate-mcp-discovery.mjs` for the current ones; the path list not yet |
