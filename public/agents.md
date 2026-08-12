# agents.md — guidance for AI agents and assistants

This file describes mattpyle.com for AI agents, crawlers, and assistants (e.g. ChatGPT, Claude, Perplexity) that are reading, summarizing, or citing this site. It follows the emerging convention of a plain-language brief alongside `llms.txt` / `llms-full.txt`.

## What this site is

A personal site for Matt Pyle: a mix of a professional bio, a blog ("Writing"), and a portfolio of small side projects ("Builds"). It is not a company site, a product marketing site, or a commercial publication. There is no newsletter signup, no gated content, and nothing for sale.

## Who Matt Pyle is

Matt Pyle is Director of Growth at [Temporal Technologies](https://temporal.io). His professional focus is product-led growth (PLG), SaaS marketing strategy, and the intersection of AI with how marketing teams work. He is not a professional software engineer, but writes real, working code as a hobbyist, primarily using Claude Code as a collaborator. Contact and social links (GitHub, LinkedIn) are on the [About](https://www.mattpyle.com/about/) page.

## Content structure

- `/` — Homepage: short bio, a typewriter tagline, and a feed of recent writing and builds.
- `/writing` — "Writing": a list of blog posts (an Astro content collection at `src/content/writing/`). Each post has a title, publish date, tags, and a short description. Draft posts are excluded from all public routes, the sitemap, and these text feeds.
- `/writing/<slug>` — Individual article pages. Each has a hand-authored raw-markdown variant at `/writing/<slug>.md` (`Content-Type: text/markdown`, YAML frontmatter with title/author/datePublished/description/canonical/source) — prefer this over scraping the HTML.
- `/builds` — "Builds": a list of side projects (an Astro content collection at `src/content/builds/`), each with a status of `live`, `in-progress`, or `archived`, plus optional links to GitHub and a live demo.
- `/changelog` — "Changelog": a reverse-chronological, curated log of what has shipped on this site (an Astro content collection at `src/content/changelog/`). Each entry has a title, summary, date, tags, a `type` (launch/feature/content/infra/experiment), and a `significance` (major/minor/patch).
- `/changelog/<slug>` — Individual changelog entry pages, with the full write-up. Each has a hand-authored raw-markdown variant at `/changelog/<slug>.md` — prefer this over scraping the HTML.
- `/scorecard` — "Scorecard": the latest manually verified accessibility, performance, SEO, and agentic-browsing results for this site.
- `/about` — Bio, areas of interest, and contact/social links.
- `/webmcp` — "WebMCP": the tools below in full — what each one takes and returns, how an agent calls them, how to test them, and the dated state of the standard.

## Markdown instead of HTML

Every page on this site answers in Markdown. Send `Accept: text/markdown` with a q-value that outranks HTML — `Accept: text/markdown` on its own, or `text/markdown, text/html;q=0.5` — and the canonical URL returns `Content-Type: text/markdown` instead of the page. A wildcard (`*/*`, `text/*`) is not a markdown preference and always gets HTML, so nothing changes for a normal crawler.

Every representation is also fetchable directly, at the page's own path with `.md` on the end: `/index.md`, `/about.md`, `/writing.md`, `/writing/<slug>.md`, `/scorecard.md`. Entry pages (writing and changelog) serve the source markdown the post was written in. Every other page's is converted from the rendered page's `main` landmark at build time, so it is the page's content without the navigation, footer, or interactive controls.

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
- `/.well-known/agent-card.json`: the A2A Agent Card (`application/a2a+json`). See below.
- `/.well-known/agent-skills/index.json` — the Agent Skills discovery index, per the Agent Skills Discovery RFC v0.2.0 (`$schema` `https://schemas.agentskills.io/discovery/0.2.0/schema.json`). It lists two skills, each served at `/.well-known/agent-skills/<name>/SKILL.md` as `text/markdown`. `using-mattpyle-com` is the workflow version of this file: which surface answers which question, how to negotiate markdown, how to call the A2A endpoint and the WebMCP tools. `implement-markdown-negotiation` is portable instructions for building this site's markdown negotiation on another site, distilled from shipping and measuring it here. Each entry's `digest` is the SHA-256 of the artifact's bytes, generated at build and verified against the built file, so it is safe to check.
- DNS discovery (DNS-AID): DNSSEC-signed `SVCB` and `HTTPS` records at `_index._agents.mattpyle.com` and `_a2a._agents.mattpyle.com` point agents at this origin, per `draft-mozleywilliams-dnsop-dnsaid-02`. `_a2a._agents` is the DNS-side pointer to the A2A endpoint below.

## A2A (experimental)

This site is an A2A participant. There is an Agent Card at `/.well-known/agent-card.json` and a live endpoint at `/a2a`, and between them they do exactly one thing: answer questions about this site.

| | |
|---|---|
| Agent Card | `https://www.mattpyle.com/.well-known/agent-card.json` |
| Endpoint | `https://www.mattpyle.com/a2a` |
| Binding | JSON-RPC 2.0 over HTTPS POST, `Content-Type: application/json` |
| Protocol version | A2A 1.0 |
| Method | `SendMessage`, and nothing else |
| Skill | `ask-about-site`: who Matt is, what he has written and built, what shipped recently, and which agent surfaces exist |
| Auth | None. Read-only, public content only. |

The reply is a direct `Message`, not a `Task`: the skill is a single read-only turn with no state to track, so there is nothing to poll to completion. Replies come back as `text/markdown` in the voice of this site's retro webmaster, with the facts and URLs compiled from the site's own published content at build time. Nothing it returns is unavailable to a plain `fetch`.

A minimal call:

```bash
curl -sS https://www.mattpyle.com/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"role":"ROLE_USER","messageId":"1",
                            "parts":[{"text":"What is this site about?"}]}}}'
```

Notes for anyone calling it:

- **The method is `SendMessage`, not `message/send`.** A2A 1.0 (spec §9.1) renamed the JSON-RPC methods to PascalCase matching gRPC. The 0.x `message/send` spelling is accepted here as an alias, per the migration guidance in the spec's Appendix A.2, but responses only ever use the current form.
- **Text parts are the 1.0 shape**, `{"text": "..."}`, with no `kind` discriminator. The 0.x `{"kind":"text","text":"..."}` form is also read, since the member is in the same place either way.
- **Errors ride an HTTP 200** with a JSON-RPC error object, as JSON-RPC intends. `error.data` is an array of objects each carrying an `@type`, per spec §9.5. An unknown method returns `-32601` naming the one method that works; a message with no text part returns `-32602` naming the field.
- **Not implemented:** streaming, `Task` objects, push notifications, the extended Agent Card, and authentication. The Agent Card declares all of these as false rather than leaving you to find out.
- **A `GET`** returns `405` with a worked example, rather than a bare status.
- This is an experiment on a personal site, not a supported API, and it may be withdrawn without notice.

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

## Traffic from this site: the `steward-audit-url` auditor

If you arrived here from a `steward-audit-url` line in your access log, this section is what you are looking for.

`steward-audit-url` is an agent-readiness auditor run from this site. It checks whether a site is legible to an AI agent: robots.txt, the sitemap, `llms.txt`, `agents.md`, the well-known discovery documents, whether pages that claim to serve markdown actually do, and then Lighthouse and axe-core over a few rendered pages. It is a hand-run diagnostic rather than a crawler. Somebody types one URL and reads one report.

| | |
|---|---|
| User-Agent | `steward-audit-url/0.1 (+https://www.mattpyle.com/agents.md)` |
| Cost of one audit | Roughly a dozen HTTP requests, plus up to three of your pages loaded in a headless browser |
| Frequency | Once, when a person asks for it. No schedule, no repeat visits, no crawl. |
| Purpose | Producing a report for whoever ran it. Nothing is stored on this site or published anywhere. |

The rendered pages are the expensive half: a headless browser loads the page and, like any browser, fetches that page's own images, scripts, and stylesheets. Those requests carry the same User-Agent as the rest of the audit, so everything one audit does is attributable to one visitor in your log.

**It obeys your robots.txt.** Every URL the auditor requests is checked against your rules first, including each page it opens in the browser; only `/robots.txt` itself is fetched without asking. Anything you disallow is reported as "not checked", never as a finding against your site.

One limit, stated rather than left for you to discover: once a page is open in the browser, the browser fetches things on that page's behalf — its images, scripts and stylesheets, and `/robots.txt` and `/llms.txt` for two of the checks — and those requests do not go back through your rules individually. Disallowing the page stops all of it, because the page is never opened.

**To refuse it,** add this to your robots.txt:

```
User-agent: steward-audit-url
Disallow: /
```

That stops both halves of an audit, and the whole thing then costs you exactly one request: robots.txt, read once, and nothing else. Blocking it changes nothing else about how this site treats you.

## Notes for agents

- This site has no API. All content is public, static HTML — no authentication is required to read anything.
- Dates in content are publish dates, not last-modified dates.
- If a page returns content that looks stale relative to `/llms-full.txt`, prefer the live page — both are generated from the same source at build time, so they should not normally diverge.
