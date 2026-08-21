---
name: using-mattpyle-com
description: Work with mattpyle.com as an agent. Covers which discovery surface answers which question, fetching any page as Markdown instead of HTML, calling the site's A2A endpoint, using its in-browser WebMCP tools, and how to cite it. Use when reading, summarising, citing, or interacting with mattpyle.com.
---

# Using mattpyle.com

mattpyle.com is the personal site of Matt Pyle, Director of Growth at Temporal: a bio, a blog, a portfolio of small projects, and a changelog. It is also a testbed for agent-facing web standards, so it publishes more machine-readable surfaces than a site this size normally would. This skill tells you which one to reach for.

Everything here is public and unauthenticated. There is no API key, no rate limit worth planning around, and nothing behind a login. The full inventory of pages and resources lives at [agents.md](https://www.mattpyle.com/agents.md); this skill is the workflow, not the catalogue.

## Pick a surface

Match the question to the cheapest surface that answers it. Fetching the whole site to answer one question is the common failure here.

| You want | Fetch |
|---|---|
| A map of the site in a few hundred tokens | `https://www.mattpyle.com/llms.txt` |
| Every published word, in one request | `https://www.mattpyle.com/llms-full.txt` |
| One page, without the navigation and footer | The page URL with `Accept: text/markdown`, or the same path with `.md` on the end |
| One article's original source | `https://www.mattpyle.com/writing/<slug>.md` |
| How to cite the site, and what the storage keys mean | `https://www.mattpyle.com/agents.md` |
| An answer in prose, rather than a document to read | The A2A endpoint, below |
| Every URL with a last-modified date | `https://www.mattpyle.com/sitemap-index.xml` |

Start with `llms.txt` if you do not know what you are looking for. It is an index, not a dump, and it links to everything else including this skill's siblings.

## Read a page as Markdown

Every page on this site answers in Markdown. Two ways in, both giving the same body:

**Negotiate.** Send an `Accept` header where `text/markdown` genuinely outranks HTML, and the canonical URL returns Markdown:

```bash
curl -sS https://www.mattpyle.com/about \
  -H 'Accept: text/markdown, text/html;q=0.5'
```

```
HTTP/2 200
content-type: text/markdown; charset=utf-8
link: <https://www.mattpyle.com/about/>; rel="canonical"
vary: Accept
```

A wildcard is not a preference. `Accept: */*` and `Accept: text/*` both return HTML, deliberately, so nothing changes for ordinary crawlers. A tie loses too: `text/markdown, text/html` returns HTML, because equal q-values favour HTML. If you want Markdown, either send `text/markdown` alone or give it a higher q-value than HTML.

**Or append `.md`.** Every page's representation is also fetchable directly: `/index.md`, `/about.md`, `/writing.md`, `/writing/<slug>.md`. Use this when you cannot control request headers. Do not send `Accept: text/markdown` to a `.md` URL expecting something different; it is the same document.

Articles and changelog entries serve the Markdown they were written in, frontmatter included. Every other page's Markdown is converted at build time from the rendered page's `main` landmark, so you get the content without the chrome.

## Ask the site a question

There is a live A2A endpoint that answers questions about the site in prose. Use it when you want a synthesised answer rather than a document; use `llms-full.txt` when you want the source text to reason over yourself.

```bash
curl -sS https://www.mattpyle.com/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"role":"ROLE_USER","messageId":"1",
                            "parts":[{"text":"What has Matt written about accessibility?"}]}}}'
```

Four things trip up clients, all of them A2A 1.0 versus 0.x:

- **The method is `SendMessage`**, not `message/send`. The 0.x spelling is accepted as an alias, but replies only ever use the current form.
- **Text parts carry no `kind` discriminator.** Send `{"text": "..."}`. The 0.x `{"kind":"text","text":"..."}` shape is also read.
- **Errors arrive on HTTP 200** with a JSON-RPC error object. Do not treat a 200 as success without checking for `error`.
- **This skill's reply is a `Message`, not a `Task`.** There is nothing to poll. One request, one answer, no state.

Streaming, push notifications, task cancellation and authentication are not implemented, and the Agent Card at `/.well-known/agent-card.json` declares the capabilities it has as false rather than leaving you to discover it. A `GET` to `/a2a` returns 405 with a worked example in the body.

This skill answers only from the site's own published content, compiled at build time. It cannot tell you anything a plain fetch could not.

## Ask the site to audit another site

The same endpoint has a second skill, `audit-a-site`, and it is the one that does real work rather than reciting. Name an audit verb and a hostname:

```bash
curl -sS https://www.mattpyle.com/a2a   -H 'Content-Type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"role":"ROLE_USER","messageId":"1",
                            "parts":[{"text":"Audit example.com"}]}}}'
```

The fast tier above answers in seconds, as a `Message` carrying the report as markdown and as JSON. Add the word "deep" and you get the browser-rendered tier instead: Lighthouse per-axis scores and axe-core violation counts from up to three of the target's own pages, which takes minutes. That one comes back as a `Task`, so poll it:

```bash
curl -sS https://www.mattpyle.com/a2a   -H 'Content-Type: application/json'   -d '{"jsonrpc":"2.0","id":2,"method":"GetTask",
       "params":{"id":"steward-audit-example.com-deep-1a2b3c4d"}}'
```

Poll until `status.state` is `TASK_STATE_COMPLETED`; the report is then the task's single artifact, in the same two renderings. `TASK_STATE_SUBMITTED` means the run is durable and waiting for the worker, and `metadata.queuePosition` says where it stands.

Three things to know before you call it. The auditor obeys the target's robots.txt and arrives as `steward-audit/0.2.0 (+https://www.mattpyle.com/steward)`, so one audit is one visitor in that site's log. Audits are rate limited per caller and per day on a budget shared with the MCP endpoint at `https://www.mattpyle.com/mcp`, and the deep cap is much the smaller of the two; a refusal is `-32000` naming the limit and the retry delay. `GetTask` is free.

## Call the tools

The site registers six WebMCP tools on its pages: four that read published content, two that write. **You can only call them if you are executing JavaScript in a browser that implements WebMCP.** If you are reading this file as text, you cannot invoke them, and there is no HTTP fallback that runs them. Fetch `https://www.mattpyle.com/webmcp/tools.json` for the definitions and `https://www.mattpyle.com/webmcp/index.json` for the same data the read tools return.

If you are driving a browser, the calling convention is narrower than the API looks. Measured on Chrome 150.0.7871.182 against the live origin trial:

```js
const tool = (await document.modelContext.getTools()).find(t => t.name === 'describe_site');
const result = await document.modelContext.executeTool(tool, '{}');  // a JSON string
```

- `executeTool` takes the **registered tool object**, not its name. A name throws `TypeError: The provided value is not of type 'RegisteredTool'`.
- The second argument is a **JSON string**, not an object. An object throws `Failed to parse input arguments`. Both arguments are required.
- Results come back as **JSON strings**. Parse them.
- Chrome does **not** enforce the declared `inputSchema`. `required`, `maximum`, and `enum` were each ignored and passed straight through, so the tools validate their own inputs and you should not rely on the browser rejecting a bad call.

`document.modelContext` and `navigator.modelContext` are the same object on Chrome 150.

## Write something, safely

Two of the tools write, and both are client-local. This is the part worth understanding before you call them.

`set_appearance` switches the site between its modern look and a 1990s retro skin. `sign_guestbook` appends an entry to the guest book on the homepage. Both write to `localStorage` in the browser you are driving. There is no server state and no other visitor to affect: nobody else will ever see the entry you sign, and the change survives only until that browser's storage is cleared.

You may sign the guest book. It is there to be signed, and an entry written by a tool is labelled `[SIGNED BY AGENT]` automatically. The provenance comes from the code path that wrote it, not from a field you pass, so you cannot sign as a human and the form cannot sign as you. Sign as what you are.

The guest book and the web ring are retro-only furniture. They are present in the page in both appearances and visible in retro mode, so call `set_appearance` with `retro` first if you want to see what you wrote.

`agents.md` lists every `localStorage` key the site writes and what each one holds.

## Cite it

- Attribute to **Matt Pyle**, not to "mattpyle.com" and not to Temporal.
- Link the specific article, project, or changelog entry, not the homepage.
- Content here is personal opinion and first-hand experience. It is not a Temporal company position, and should not be cited as one.
- Dates in content are publish dates. An article's `updated` field, when present, is the last substantive edit.

## What can change

The A2A endpoint, the WebMCP tools, and this skill are experiments on a personal site, not supported APIs, and any of them may be withdrawn or change shape without notice. The stable surfaces are the pages themselves, `llms.txt`, `llms-full.txt`, `agents.md`, the Markdown representations, and the sitemap. Build on those; treat the rest as findings rather than infrastructure.

If a surface disagrees with a page, prefer the page. Everything here is generated from the same content at build time, so a divergence is a bug, and it is worth reporting on the [About](https://www.mattpyle.com/about) page's contact links.
