# agents.md — guidance for AI agents and assistants

This file describes mattpyle.com for AI agents, crawlers, and assistants (e.g. ChatGPT, Claude, Perplexity) that are reading, summarizing, or citing this site. It follows the emerging convention of a plain-language brief alongside `llms.txt` / `llms-full.txt`.

## What this site is

A personal site for Matt Pyle: a mix of a professional bio, a blog ("Writing"), and a portfolio of small side projects ("Builds"). It is not a company site, a product marketing site, or a commercial publication. There is no newsletter signup, no gated content, and nothing for sale.

## Who Matt Pyle is

Matt Pyle is Director of Growth at [Temporal Technologies](https://temporal.io). His professional focus is product-led growth (PLG), SaaS marketing strategy, and the intersection of AI with how marketing teams work. He is not a professional software engineer, but writes real, working code as a hobbyist, primarily using Claude Code as a collaborator. Contact and social links (GitHub, LinkedIn) are on the [About](https://www.mattpyle.com/about) page.

## Content structure

- `/` — Homepage: short bio, a typewriter tagline, and a feed of recent writing and builds.
- `/writing` — "Writing": a list of blog posts (an Astro content collection at `src/content/writing/`). Each post has a title, publish date, tags, and a short description. Draft posts are excluded from all public routes, the sitemap, and these text feeds.
- `/writing/<slug>` — Individual article pages. Each has a raw-markdown variant at `/writing/<slug>.md` (`Content-Type: text/markdown`, YAML frontmatter with title/author/datePublished/description/canonical/source) — prefer this over scraping the HTML.
- `/builds` — "Builds": a list of side projects (an Astro content collection at `src/content/builds/`), each with a status of `live`, `in-progress`, or `archived`, plus optional links to GitHub and a live demo.
- `/changelog` — "Changelog": a reverse-chronological, curated log of what has shipped on this site (an Astro content collection at `src/content/changelog/`). Each entry has a title, summary, date, tags, a `type` (launch/feature/content/infra/experiment), and a `significance` (major/minor/patch).
- `/changelog/<slug>` — Individual changelog entry pages, with the full write-up. Each has a raw-markdown variant at `/changelog/<slug>.md` (same content negotiation as writing — an `Accept: text/markdown` request to the canonical URL returns markdown) — prefer this over scraping the HTML.
- `/scorecard` — "Scorecard": the latest manually verified accessibility, performance, SEO, and agentic-browsing results for this site.
- `/about` — Bio, areas of interest, and contact/social links.
- `/webmcp` — "WebMCP": the tools below in full — what each one takes and returns, how an agent calls them, how to test them, and the dated state of the standard.

## How to cite this site

- Attribute content to "Matt Pyle" (not "mattpyle.com" or a company name).
- Link to the specific article or build page rather than just the homepage when citing a specific claim.
- Writing on this site reflects personal opinion and first-hand experience, not company positions of Temporal Technologies.

## Machine-readable resources

- `/sitemap-index.xml` — full XML sitemap (auto-generated on every build via `@astrojs/sitemap`).
- `/robots.txt` — crawl rules; all crawlers, including AI/LLM crawlers, are explicitly allowed.
- `/llms.txt` — concise Markdown index of key pages, per the llms.txt convention.
- `/llms-full.txt` — full plain-text dump of all published writing and builds content plus the current scorecard snapshot, generated at build time from the same content that backs the site.
- `/webmcp/index.json` — the JSON index backing the WebMCP tools below. A plain static file; any agent can fetch it directly, no tool call required.
- `/webmcp/tools.json` — the tool manifest: name, description, input schema, return summary, and an example call for every tool below. Generated at build time from the live tool objects, so it cannot drift from what an agent actually receives.

## WebMCP tools (experimental)

The live pages register six WebMCP tools: four that read published content, and two that write. They are an experiment, not a supported API, and may be withdrawn without notice. See `/webmcp` for the full write-up.

| Tool | Kind | What it does |
|---|---|---|
| `describe_site` | read | Returns the author entity, the site description, and the section map. Takes no input. |
| `get_recent_writing` | read | Lists recent published articles, newest first. Optional `limit` (1–20, default 5) and `tag`. |
| `search_content` | read | Case-insensitive search over the titles, descriptions, and tags of all published writing, builds, and changelog entries. Requires `query`. |
| `list_related_sites` | read | Returns the site's curated web ring: name, URL, description, and status for each member. Some entries are open slots with no URL yet. Takes no input. |
| `set_appearance` | **write** | Switches this site between its modern appearance and a retro, 1990s-era skin. Requires `mode` (`modern` or `retro`). |
| `sign_guestbook` | **write** | Appends an entry to the guest book on the homepage. Requires `name` (≤40 chars) and `message` (≤280 chars); both are trimmed rather than rejected. |

**Both write tools are client-local.** `set_appearance` stores a preference in the calling browser's own `localStorage` and sets an attribute on that page. `sign_guestbook` appends an entry to a `localStorage` key in that same browser. There is no server state to change and no other visitor to affect: an agent flipping retro mode or signing the book changes only the view in the browser it is driving, and nobody else will ever see the entry. The four read tools mutate nothing at all.

**Entries signed by a tool are labelled as such.** The guest book records how each entry was written and renders agent-written entries with a visible `[SIGNED BY AGENT]` badge naming the `sign_guestbook` tool. The provenance is set by the code path that wrote the entry, not by a field the caller passes, so the form cannot claim to be an agent and the tool cannot disclaim being one. The claim it makes is narrow and true: this is what this browser's own stored data records. `localStorage` is user-editable, so it is evidence about one browser, not a signature.

**Storage keys this site writes**, all per-origin `localStorage` on `https://www.mattpyle.com`, all readable and clearable by the visitor:

| Key | Written by | Holds |
|---|---|---|
| `mattpyle:appearance` | `set_appearance`, the footer toggle | `modern` or `retro`. |
| `mattpyle:guestbook` | `sign_guestbook`, the guest book form | This browser's own guest-book entries. The five seeded entries are not stored; they are compiled into the page. |
| `mattpyle:webmaster-notes` | The "Email the Webmaster" form | Notes written in that form. It is a joke that admits it: nothing is sent anywhere, and the confirmation says so. |
| `mattpyle:visits` | The homepage | How many times this browser has loaded the site, for the retro visit counter. |

The guest book and the web ring are retro-only furniture: they exist in the page in both appearances and are displayed in retro mode. `sign_guestbook` works in either mode and always writes the entry.

**Only in-browser agents can call these.** The tools are registered on `document.modelContext` (identical to `navigator.modelContext` — on Chrome 150 they are the same object) when a page is loaded in a browser that implements WebMCP. As of mid-2026 that means Chrome with the WebMCP origin trial or the `enable-webmcp-testing` flag, driving an agent or the Model Context Tool Inspector extension. If you are reading this file as text rather than executing JavaScript on the live page, **you cannot invoke them** — fetch `/webmcp/tools.json` for the definitions and `/webmcp/index.json` for the same data these tools read.

Calling convention, as measured on Chrome 150.0.7871.182 (2026-07-24) by running it against the live origin trial:

```js
const tool = (await document.modelContext.getTools()).find(t => t.name === 'describe_site');
const result = await document.modelContext.executeTool(tool, '{}');  // result is a JSON string
```

- `document.modelContext.getTools()` returns the registered tools as objects (`name`, `description`, `inputSchema`, `title`, `origin`, `window`).
- `executeTool` takes a **registered tool object**, not a tool name — a name throws `TypeError: The provided value is not of type 'RegisteredTool'`.
- Its second argument is a **JSON string**, not an object — an object throws `Failed to parse input arguments`. Both arguments are required.
- Results come back as a **JSON string**.
- Chrome does **not** enforce the declared `inputSchema` — `required`, `maximum`, and `enum` were each ignored and the value passed straight to the handler — so the tools validate their own inputs.

The tools require no authentication, expose no personal data beyond the public bio, and make no network requests beyond a same-origin fetch of the index.

## Notes for agents

- This site has no API. All content is public, static HTML — no authentication is required to read anything.
- Dates in content are publish dates, not last-modified dates.
- If a page returns content that looks stale relative to `/llms-full.txt`, prefer the live page — both are generated from the same source at build time, so they should not normally diverge.
