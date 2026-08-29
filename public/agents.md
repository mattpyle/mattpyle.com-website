# agents.md — guidance for AI agents and assistants

This file describes mattpyle.com for AI agents, crawlers, and assistants (e.g. ChatGPT, Claude, Perplexity) that are reading, summarizing, or citing this site. It follows the emerging convention of a plain-language brief alongside `llms.txt` / `llms-full.txt`.

## What this site is

A personal site for Matt Pyle: a mix of a professional bio, a blog ("Writing"), and a portfolio of small side projects ("Projects"). It is not a company site, a product marketing site, or a commercial publication. There is no newsletter signup, no gated content, and nothing for sale.

## Who Matt Pyle is

Matt Pyle is Director of Growth at [Temporal Technologies](https://temporal.io). His professional focus is product-led growth (PLG), SaaS marketing strategy, and the intersection of AI with how marketing teams work. He is not a professional software engineer, but writes real, working code as a hobbyist, primarily using Claude Code as a collaborator. Contact and social links (GitHub, LinkedIn) are on the [About](https://www.mattpyle.com/about/) page.

## Content structure

- `/` — Homepage: short bio, a typewriter tagline, and a feed of recent writing and projects.
- `/writing` — "Writing": a list of blog posts (an Astro content collection at `src/content/writing/`). Each post has a title, publish date, tags, and a short description. Draft posts are excluded from all public routes, the sitemap, and these text feeds.
- `/writing/<slug>` — Individual article pages. Each has a hand-authored raw-markdown variant at `/writing/<slug>.md` (`Content-Type: text/markdown`, YAML frontmatter with title/author/datePublished/description/canonical/source) — prefer this over scraping the HTML.
- `/projects` — "Projects": a list of side projects (an Astro content collection at `src/content/projects/`), each with a status of `live`, `in-progress`, or `archived`, plus optional links to GitHub and a live demo. It was published at `/builds` until 2026-08-20; every old URL, including `/builds.md`, now 301s to its `/projects` equivalent.
- `/changelog` — "Changelog": a reverse-chronological, curated log of what has shipped on this site (an Astro content collection at `src/content/changelog/`). Each entry has a title, summary, date, tags, a `type` (launch/feature/content/infra/experiment), and a `significance` (major/minor/patch).
- `/changelog/<slug>` — Individual changelog entry pages, with the full write-up. Each has a hand-authored raw-markdown variant at `/changelog/<slug>.md` — prefer this over scraping the HTML.
- `/scorecard` — "Scorecard": the latest accessibility, performance, SEO, and agentic-browsing results for this site, from a nightly automated audit run. Also at `/scorecard.json`.
- `/activity` — "Activity": agent traffic to this site — fetches of its agent surfaces and pages served as Markdown, counted per UTC hour. Also at `/activity.json`.
- `/about` — Bio, areas of interest, and contact/social links.
- `/webmcp` — "WebMCP": the tools below in full — what each one takes and returns, how an agent calls them, how to test them, and the dated state of the standard.
- `/steward` — "Steward": the agent-readiness auditor this site runs and the editorial agent that publishes it. What the audit checks, what one costs a site, the User-Agent it arrives under, and how to refuse it.

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
- `/llms-full.txt` — full plain-text dump of all published writing and projects content plus the current scorecard snapshot, generated at build time from the same content that backs the site.
- `/webmcp/index.json` — the JSON index backing the WebMCP tools below. A plain static file; any agent can fetch it directly, no tool call required.
- `/webmcp/tools.json` — the tool manifest: name, description, input schema, return summary, and an example call for every tool below. Generated at build time from the live tool objects, so it cannot drift from what an agent actually receives.
- `/.well-known/agent-card.json`: the A2A Agent Card (`application/a2a+json`). See below.
- `/.well-known/mcp-server` — the MCP discovery document, per `draft-serra-mcp-discovery-uri-04` (`application/json`). It names the MCP endpoint below and describes its fast tier; `tools/list` on the endpoint is the register of what it actually serves.
- `/mcp/server-card` — the MCP Server Card for the same endpoint, per SEP-2127 (`application/mcp-server-card+json`). The MCP project's own convention, and it shares no field name with the IETF document above: identity, transport, and the protocol versions the endpoint negotiates, and no tool list, because the spec leaves tools to `tools/list`. The path is the one SEP-2127 reserves, `<streamable-http-url>/server-card`, and the card is what `/.well-known/ard.json` points at. The same document also answers at `/.well-known/mcp/server-card.json`, the path agent-readiness scanners probe; it is a rewrite onto this file, not a second card. That SEP's own discovery notes argue against the `.well-known` placement — a server card is application-level metadata rather than site-wide — so both are published and which one a client reaches for is a measurement, not a recommendation.
- `/.well-known/agent-skills/index.json` — the Agent Skills discovery index, per the Agent Skills Discovery RFC v0.2.0 (`$schema` `https://schemas.agentskills.io/discovery/0.2.0/schema.json`). It lists two skills, each served at `/.well-known/agent-skills/<name>/SKILL.md` as `text/markdown`. `using-mattpyle-com` is the workflow version of this file: which surface answers which question, how to negotiate markdown, how to call the A2A endpoint and the WebMCP tools. `implement-markdown-negotiation` is portable instructions for building this site's markdown negotiation on another site, distilled from shipping and measuring it here. Each entry's `digest` is the SHA-256 of the artifact's bytes, generated at build and verified against the built file, so it is safe to check.
- `/.well-known/ard.json` — the Agentic Resource Discovery catalogue, per the ARD specification v0.91 (agenticresourcediscovery.org). Four entries, one per agentic resource this site publishes: the A2A Agent Card, the MCP Server Card, and the two Agent Skills. Each entry names the artifact's own URL rather than restating it, so the catalogue cannot contradict the documents above. The catalogue is advertised two ways: the well-known path itself, and a `<link rel="ard">` element on every page; no DNS records are published for it. The same document also answers at ARD's predecessor path `/.well-known/ai-catalog.json`, advertised by `<link rel="ai-catalog">`, for clients that have not moved to v0.91 yet; it is a rewrite onto this file, not a second catalogue.
- DNS discovery (DNS-AID): DNSSEC-signed `SVCB` and `HTTPS` records at `_index._agents.mattpyle.com` and `_a2a._agents.mattpyle.com` point agents at this origin, per `draft-mozleywilliams-dnsop-dnsaid-02`. `_a2a._agents` is the DNS-side pointer to the A2A endpoint below.

## A2A (experimental)

This site is an A2A participant. There is an Agent Card at `/.well-known/agent-card.json` and a live endpoint at `/a2a`, and between them they do two things: answer questions about this site, and audit a site you name for agent-readiness.

| | |
|---|---|
| Agent Card | `https://www.mattpyle.com/.well-known/agent-card.json` |
| Endpoint | `https://www.mattpyle.com/a2a` |
| Binding | JSON-RPC 2.0 over HTTPS POST, `Content-Type: application/json` |
| Protocol version | A2A 1.0 |
| Methods | `SendMessage`, and `GetTask` for polling a Task |
| Skills | `ask-about-site` and `audit-a-site` |
| Auth | None. Read-only or outbound-only; no accounts and no private data. |

`ask-about-site` answers who Matt is, what he has written and built, what shipped recently, and which agent surfaces exist. Its reply is a direct `Message`, not a `Task`: one read-only turn with no state to track, so there is nothing to poll to completion. Replies come back as `text/markdown` in the voice of this site's retro webmaster, with the facts and URLs compiled from the site's own published content at build time. Nothing it returns is unavailable to a plain `fetch`.

`audit-a-site` audits any site you name. Say an audit verb and a hostname — "audit example.com" — and add "deep" for the browser-rendered tier.

| Tier | Ask with | Shape | Takes | What it checks |
|---|---|---|---|---|
| fast | "audit example.com" | a direct `Message` | seconds | robots.txt and its AI-agent rules, Content Signals, the sitemap, llms.txt and whether its links resolve, agents.md, the well-known MCP and A2A documents, and whether the homepage and a content page really serve markdown when asked |
| deep | "run a deep audit of example.com" | a `Task` you poll with `GetTask` | minutes | all of the above, plus Lighthouse per-axis scores and axe-core violation counts from up to three of the site's own rendered pages |

Both tiers hand back the report twice in the one response: as markdown, and as its canonical JSON. On the deep tier they are the two parts of the Task's single artifact, which appears once the state reaches `TASK_STATE_COMPLETED`.

- **The Task id is the Temporal workflow id**, e.g. `steward-audit-example.com-deep-1a2b3c4d`. It is a handle to a durable run that survives a worker restart, and it is the same id the MCP endpoint's `deep_audit` returns.
- **The auditor is Steward.** It obeys the target's robots.txt under the token `steward-audit` and arrives as `steward-audit/0.2.0 (+https://www.mattpyle.com/steward)`, so one audit is one visitor in the target's log. `/steward` says what an audit costs a site and how to refuse it.
- **Audits are rate limited per caller and per day, on a budget shared with the MCP endpoint** at `https://www.mattpyle.com/mcp`. A deep slot spent on either protocol is spent on both. Deep audits are capped far lower than fast ones, because each spends real browser time on a hosted worker. A refusal is `-32000` naming which limit was hit and when to retry. Reading a Task with `GetTask` is free.
- **No model is involved anywhere in this path.** The skill starts audits and reports state; it does not interpret a report or answer questions about one.

A minimal call:

```bash
curl -sS https://www.mattpyle.com/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"role":"ROLE_USER","messageId":"1",
                            "parts":[{"text":"What is this site about?"}]}}}'
```

A deep audit, started and then polled:

```bash
curl -sS https://www.mattpyle.com/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"role":"ROLE_USER","messageId":"1",
                            "parts":[{"text":"Run a deep audit of example.com"}]}}}'

curl -sS https://www.mattpyle.com/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"GetTask",
       "params":{"id":"steward-audit-example.com-deep-1a2b3c4d"}}'
```

Notes for anyone calling it:

- **The method is `SendMessage`, not `message/send`.** A2A 1.0 (spec §9.1) renamed the JSON-RPC methods to PascalCase matching gRPC. The 0.x `message/send` spelling is accepted here as an alias, per the migration guidance in the spec's Appendix A.2, but responses only ever use the current form.
- **Text parts are the 1.0 shape**, `{"text": "..."}`, with no `kind` discriminator. The 0.x `{"kind":"text","text":"..."}` form is also read, since the member is in the same place either way.
- **Errors ride an HTTP 200** with a JSON-RPC error object, as JSON-RPC intends. `error.data` is an array of objects each carrying an `@type`, per spec §9.5. An unknown method returns `-32601` naming the one method that works; a message with no text part returns `-32602` naming the field.
- **`GetTask` takes `{"id": "..."}`**, and the 0.x `tasks/get` spelling is accepted as an alias on the same terms as `message/send`. An id this endpoint did not issue returns `-32001`, A2A's `TaskNotFoundError`.
- **Not implemented:** streaming, push notifications, task cancellation, the extended Agent Card, and authentication. The Agent Card declares the capabilities it has as false rather than leaving you to find out. Polling `GetTask` is what stands in for streaming here.
- **A `GET`** returns `405` with a worked example of each skill, rather than a bare status.
- This is an experiment on a personal site, not a supported API, and it may be withdrawn without notice.

## MCP endpoint: this site will audit yours

This site runs a public MCP server. It audits any site for agent-readiness, on two tiers, and the tier decides the shape of the answer.

| | |
|---|---|
| Endpoint | `https://www.mattpyle.com/mcp` |
| Discovery | `https://www.mattpyle.com/.well-known/mcp-server` (IETF draft) and `https://www.mattpyle.com/mcp/server-card` (SEP-2127 Server Card) |
| Transport | Streamable HTTP over POST, stateless — no session ID, one request per POST |
| Protocol version | MCP 2025-06-18. JSON-RPC batches are refused; they were removed from the spec in that version. |
| Tools | `audit_site(url)`, plus the deep tier below. `tools/list` enumerates them; this file is not the register. |
| Auth | None. It reads public documents on a third-party site and writes nothing anywhere. |
| Write-up | [/steward](https://www.mattpyle.com/steward) |

`audit_site(url)` is the fast tier: robots.txt and its AI-agent rules, Content Signals, the sitemap, llms.txt and whether its links resolve, agents.md, the well-known MCP and A2A documents, and whether the homepage and a content page really serve markdown when asked. It takes seconds, so it runs inside the function that answered you and the report comes back in the same call — the canonical JSON in `structuredContent`, one entry per check with evidence and a fix, and the same report as a markdown summary in the text content. There is nothing to poll and no resource to read afterwards, which is deliberate: chat clients call tools but cannot read resources, so a report reachable only through a resource is unreachable from most agents.

`deep_audit(url)` and `get_audit(workflowId, view)` are the browser-rendered tier. It renders up to three of the site's own pages and reports Lighthouse per-axis scores and axe-core violation counts, which takes minutes — longer than any MCP client holds a tool call open — so `deep_audit` returns a Temporal workflow ID straight away and `get_audit` reads it back: `view: "status"` until `done` is true, then `view: "report"` or `"summary"`. There are no findings in the `deep_audit` response and it says so. Both discovery documents above describe the fast tier only; find these two through `tools/list`.

**What one call costs you.** Both tiers are capped per caller and across all callers, on a budget shared with the A2A endpoint — a slot spent on either protocol is spent on both. The fast tier is capped per hour and per UTC day, the deep tier per UTC day and far lower, because a deep audit spends minutes of browser time on a machine somebody pays for where a fast one spends seconds inside the function that answered you. **The caps in force are on [/steward](https://www.mattpyle.com/steward)**, which renders them from the environment this deployment actually enforces; a number written out here would be a copy that can drift, and one already had.

A refusal is a JSON-RPC error with a `Retry-After` header naming which limit was hit and how long to wait. There is no key, no account, and no way to ask for more. `get_audit` is free: it reads a run you already paid for and makes no request at anybody's origin. The counters hold a keyed hash of the caller's address with a lifetime no longer than the window, never the address itself.

A minimal call:

```bash
curl -sS https://www.mattpyle.com/mcp   -H 'Content-Type: application/json'   -H 'Accept: application/json, text/event-stream'   -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"audit_site","arguments":{"url":"example.com"}}}'
```

A `GET` returns `405` with that example rather than a bare status. The unit audited is a site, not a page: any path in the URL is ignored. Only `http` and `https` targets are accepted, and addresses on private networks are refused before a connection is opened.

## WebMCP tools (experimental)

The live pages register six WebMCP tools: four that read published content, and two that write. They are an experiment, not a supported API, and may be withdrawn without notice. See `/webmcp` for the full write-up.

| Tool | Kind | What it does |
|---|---|---|
| `describe_site` | read | Returns the author entity, the site description, and the section map. Takes no input. |
| `get_recent_writing` | read | Lists recent published articles, newest first. Optional `limit` (1–20, default 5) and `tag`. |
| `search_content` | read | Case-insensitive search over the titles, descriptions, and tags of all published writing, projects, and changelog entries. Requires `query`. |
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

## Traffic from this site: the `steward-audit` auditor

If you arrived here from a `steward-audit` line in your access log, [/steward](https://www.mattpyle.com/steward) is the page that string points at and the fuller answer. The short version:

`steward-audit` is an agent-readiness auditor run from this site. It checks whether a site is legible to an AI agent: robots.txt, the sitemap, `llms.txt`, `agents.md`, the well-known discovery documents, whether pages that claim to serve markdown actually do, and — on its deep tier only — Lighthouse and axe-core over a few rendered pages. It is a diagnostic rather than a crawler. Somebody asks for one URL and reads one report.

| | |
|---|---|
| User-Agent | `steward-audit/0.2.0 (+https://www.mattpyle.com/steward)` |
| Cost of one audit | Roughly a dozen HTTP requests. A deep audit adds up to three of your pages loaded in a headless browser. |
| Frequency | Once, when a person or an agent asks for it. No schedule, no repeat visits, no crawl. |
| Purpose | Producing a report for whoever ran it. Nothing is stored on this site or published anywhere. |

The rendered pages are the expensive half, and they are the deep tier only. When they do run, a headless browser loads the page and, like any browser, fetches that page's own images, scripts, and stylesheets. Those requests carry the same User-Agent as the rest of the audit, so everything one audit does is attributable to one visitor in your log.

**It obeys your robots.txt.** Every URL the auditor requests is checked against your rules first, including each page it opens in the browser; only `/robots.txt` itself is fetched without asking. Anything you disallow is reported as "not checked", never as a finding against your site.

One limit, stated rather than left for you to discover: once a page is open in the browser, the browser fetches things on that page's behalf — its images, scripts and stylesheets, and `/robots.txt` and `/llms.txt` for two of the checks — and those requests do not go back through your rules individually. Disallowing the page stops all of it, because the page is never opened.

**To refuse it,** add this to your robots.txt:

```
User-agent: steward-audit
Disallow: /
```

That stops both halves of an audit, and the whole thing then costs you exactly one request: robots.txt, read once, and nothing else. Blocking it changes nothing else about how this site treats you.

## Notes for agents

- This site has no API. All content is public, static HTML — no authentication is required to read anything.
- Dates in content are publish dates, not last-modified dates.
- If a page returns content that looks stale relative to `/llms-full.txt`, prefer the live page — both are generated from the same source at build time, so they should not normally diverge.
