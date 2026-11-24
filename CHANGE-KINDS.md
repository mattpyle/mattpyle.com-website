# Change kinds

What a common change to this site touches, and what holds each surface. A surface is either generated from one source, checked by a test or validator that fails with the surface named, or left to a person. Built so far: the first three kinds. The rest are listed so the next build starts from the same table, and marked "not yet".

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
| Markdown alternate `Link` headers | `vercel.json` | `tests/change-kinds-pages-surfaces.test.mjs` fails and names the page, from the built pages: a pair per page, slash and no slash, the root once. `tests/markdown-negotiation.test.mjs` also checks the fixed entries of the negotiation matcher |
| Sitemap `lastmod` | `src/data/sitemap-lastmod.mjs` | `tests/change-kinds-pages-surfaces.test.mjs` fails and names the page. The build also fails: `astro.config.mjs` throws "has no lastmod policy" naming the URL |
| Retro and axe route lists | `scripts/lib/retro-routes.mjs`, `.github/workflows/a11y.yml` | `tests/change-kinds-pages-surfaces.test.mjs` fails when the two lists differ, and names a built page that is on neither the list nor the exemption list. The lists sample templates, so a page that shares a template goes on the exemption list naming the listed page |
| Share cards | `scripts/generate-og-images.mjs` | `tests/change-kinds-pages-surfaces.test.mjs` fails and names the page: each built page has its own card in `EXPERIMENT_PAGES` or is on the fallback list. The generator makes no card for a page that has none |
| Header and footer | `src/components/SiteHeader.astro` | By hand, not checked |
| Surface probe sample | `scripts/agent-surface-parity.mjs` | By hand, a sample of three pages |

A page left out of a surface on purpose goes on the exemption list in `tests/change-kinds-pages.test.mjs` (registry, `llms.txt`, `agents.md`) or in `tests/change-kinds-pages-surfaces.test.mjs` (one list per surface), with a reason. The built-page list both tests read is `tests/helpers/built-pages.mjs`.

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
| Method list in the GET answer | `src/pages/a2a.ts` | Generated from the list |
| Census legend in the `/activity` golden | `tests/a11y/__snapshots__/activity.aria.yml` | `npm run a11y`, advisory: the legend's sentence is in the golden |
| Agent Card capability, for a method a capability announces | `public/.well-known/agent-card.json` | `scripts/validate-a2a-card.mjs` holds `streaming` true and the other capabilities false; `tests/a2a-card.test.mjs` |
| Method prose in the Agent Skill | `src/data/skills/using-mattpyle-com.md` | By hand, not checked |

## A new skill or tool

Four families, each with one source. Add the member there; the counts and lists that are data follow, and `tests/change-kinds-skills.test.mjs` fails with the family, the member or count, and the file for the prose that does not.

| Family | One source | Add it by |
|---|---|---|
| A2A skills | `SKILL_IDS` in `src/lib/a2a-audit-skill.mjs` | A new id and its skill module |
| Agent Skills | the files in `src/data/skills/`, read by `src/lib/agent-skills.mjs` | A new `.md` file named for the skill |
| MCP tools | `MCP_TOOL_NAMES` in `src/lib/mcp-audit-server.mjs` | A new `registerTool` call and its name in the list |
| WebMCP tools | `createTools()` in `src/lib/webmcp-tools.mjs` | A new tool object; `readOnlyHint` marks a read tool |

A2A skills:

| Surface | File | Held by |
|---|---|---|
| Agent Card skills | `public/.well-known/agent-card.json` | `tests/a2a-card.test.mjs` |
| Agent Card description count | `public/.well-known/agent-card.json` | `tests/change-kinds-skills.test.mjs` fails and names the count |
| Discovery catalogue entry | `public/.well-known/ard.json` | `scripts/validate-ard-manifest.mjs` ties its A2A capabilities to the Agent Card; `tests/change-kinds-skills.test.mjs` checks the description count |
| Census skill list | `src/lib/agent-hits.mjs` | `tests/a2a-census.test.mjs` |
| Skill prose in `llms.txt` | `src/pages/llms.txt.ts` | `tests/change-kinds-skills.test.mjs` fails and names the skill or count |
| Skill prose in `agents.md` | `public/agents.md` | `tests/change-kinds-skills.test.mjs` fails and names the skill or count |

Agent Skills:

| Surface | File | Held by |
|---|---|---|
| Skills index | `src/lib/agent-skills.mjs` | Generated; `scripts/validate-agent-skills-index.mjs` |
| Skill lines in `llms.txt` | `src/pages/llms.txt.ts` | Generated from the index |
| Skill count and URLs in the A2A digest | `scripts/generate-a2a-digest.mjs` | Generated from the skill files |
| Logged skill paths | `src/lib/agent-surfaces.mjs` | `tests/change-kinds-skills.test.mjs` fails when the list differs from the skill files. Hand-kept: the middleware bundle cannot read the disk |
| Count and names in `llms.txt` and `agents.md` | `src/pages/llms.txt.ts` | `tests/change-kinds-skills.test.mjs` fails and names the skill or count |

MCP tools:

| Surface | File | Held by |
|---|---|---|
| Tool names | `src/lib/mcp-audit-server.mjs` | `tests/change-kinds-skills.test.mjs` fails when `MCP_TOOL_NAMES` differs from the registered names |
| Tool list in the GET answer | `src/pages/mcp.ts` | Generated from `MCP_TOOL_NAMES` |
| Tool prose in `agents.md` and the Steward page | `public/agents.md` | `tests/change-kinds-skills.test.mjs` fails and names the tool |
| Tool count on the Steward page | `src/components/steward/StewardBody.astro` | `tests/change-kinds-skills.test.mjs` fails and names the count |
| Discovery document, Server Card and `llms.txt` | `public/.well-known/mcp-server` | Describe the fast tool only, on purpose: `scripts/validate-mcp-discovery.mjs`. The exemption list in the test names each |

WebMCP tools:

| Surface | File | Held by |
|---|---|---|
| Tool manifest | `src/pages/webmcp/tools.json.ts` | Generated from `createTools()` |
| Tool counts in the A2A digest | `scripts/generate-a2a-digest.mjs` | Generated from `createTools()` |
| Counts in `llms.txt` | `src/pages/llms.txt.ts` | `tests/change-kinds-skills.test.mjs` fails and names the count |
| Counts and names in `llms-full.txt` and `agents.md` | `src/pages/llms-full.txt.ts` | `tests/change-kinds-skills.test.mjs` fails and names the tool or count |
| Counts on the `/webmcp` page | `src/pages/webmcp/index.astro` | `tests/change-kinds-skills.test.mjs` fails and names the count |
| Editorial notes per tool | `src/data/webmcp-catalog.mjs` | `tests/webmcp-catalog.test.mjs` |

A surface left out of a family on purpose goes on the exemption list in `tests/change-kinds-skills.test.mjs`, with a reason. Not held: the "Four entries" count of catalogue entries in `llms.txt` and `agents.md`.

## Other kinds

| Kind | Held by |
|---|---|
| A new on-demand route (`src/lib/on-demand-routes.mjs`, `middleware.ts`) | `tests/on-demand-routes.test.mjs` for the matcher; sitemap and sibling lists not yet |
| A changed fact about the site or its author | Not held by a test. A fact can be stated in several places; a change covers each that states it. Where facts hide, a list to start from and not the whole set, so search the whole tree for the old words too: `public/agents.md`; `src/pages/llms.txt.ts`; `src/pages/llms-full.txt.ts`; `src/data/site-sections.mjs`; the A2A digest, whose `surfaces` are written in `scripts/generate-a2a-digest.mjs`; `src/lib/a2a-responder.mjs`; the structured data (JSON-LD) in `src/layouts/Layout.astro`; the feed routes `src/pages/rss.xml.ts` and `src/pages/changelog/rss.xml.ts`; `public/site.webmanifest`; the about page, `src/pages/about.astro` with `src/components/about/AboutHero.astro` and `AboutBody.astro`; a project's `description:` in `src/content/projects/`; `updated:` on a post in `src/content/writing/` and on a changelog entry in `src/content/changelog/`; the examples in `src/data/skills/*.md` |
| A new content collection (`src/content.config.ts`) | `tests/frontmatter-readers.test.mjs` for the readers; the per-collection loops not yet |
| A new post or changelog entry, or an edit to one | Generated from the collections; `updated:` by hand. `scripts/check-updated-date.mjs`, run by `npm test` as `posttest`, warns and names the file when a body changed and `updated:` did not: an annotation on the pull request in CI, a plain line locally. It never fails: whether an edit is substantive is the author's call. A body image is a relative path into `src/assets/`: `tests/markdown-images.test.mjs` fails and names an entry whose image is not on disk, and the build fails when `llms-full.txt` carries an image address that is not in the output (`scripts/validate-markdown-siblings.mjs`) |
| Prose in an `.astro` template | `tests/inline-tag-wrapping-tree.test.mjs` fails and names the file and line when a source line break sits against an inline tag (`a`, `code`, `strong`, `em`, `abbr`, `span`) and would join two words in the built HTML. The rule is in `scripts/check-inline-tag-wrapping.mjs`. Not held: the same seam beside a `{…}` expression; `npm run look -- <path> --find "<text>"` shows the built page at that text, at phone and desktop width, to read it by eye |
| A new hover style (a `:hover` rule in an `.astro` style block or a file under `src/styles/`) | `tests/hover-guard.test.mjs` fails and names the rule unless it is inside `@media (hover: hover)`; `tests/a11y/touch-hover.spec.ts` taps a row of each kind on an emulated phone, in both appearances |
| A new feed or data endpoint | Not yet |
| A new well-known document | `scripts/validate-a2a-card.mjs`, `scripts/validate-ard-manifest.mjs` and `scripts/validate-mcp-discovery.mjs` for the current ones; the path list not yet |
