---
name: implement-markdown-negotiation
description: Implement site-wide Markdown content negotiation, so every HTML page also answers `Accept: text/markdown` with a clean Markdown representation of itself. Covers the sibling URL rule, build-time conversion from the page's main landmark, edge negotiation with a fallback to HTML, and the traps that only surface in production: output roots, response headers, recursion, extraction, and registration drift. Use when adding Markdown representations to a site for AI agents, or when an agent-readiness check reports that a site does not serve Markdown.
---

# Implement Markdown content negotiation

Make every HTML page on a site answer `Accept: text/markdown` with a Markdown version of that page's content, at the same URL, with no separate site to maintain. Agents get the page without the navigation, the footer, the cookie banner and the class attributes; browsers and ordinary crawlers get byte-identical HTML to what they got before.

Do it in four parts, in this order:

1. **A sibling rule.** One deterministic mapping from a page path to the URL of its Markdown representation.
2. **A source of Markdown for every page.** Convert the built HTML at build time, except where a curated route can do better.
3. **Negotiation at the edge.** Parse `Accept` properly, fetch the sibling, fall back to HTML.
4. **A build gate.** Fail the build when a page has no sibling, because the fallback hides that failure perfectly.

Each part below is written so it can be implemented on its own. The traps sections are where the time actually goes.

## Derive the sibling URL, do not maintain a list

Use one rule with no whitelist: strip the page path's trailing slash and append `.md`. Map `/` to `/index.md`.

| Page | Sibling |
|---|---|
| `/` | `/index.md` |
| `/about/` or `/about` | `/about.md` |
| `/writing/` | `/writing.md` |
| `/writing/some-post/` | `/writing/some-post.md` |

Two properties make this rule worth preferring over a manifest. Index pages land one level above the entries beneath them, so `/writing.md` and `/writing/some-post.md` never collide. And a new page is covered the moment it exists, with nothing to update and nothing to go stale.

Put the rule in one module that the edge handler, the build step, the validator and the tests all import. The moment two of those carry their own copy of the mapping, the site can serve a sibling that the validator does not check.

A path whose last segment already contains a dot is not negotiable. Return null for it. That single line is also the recursion guard, described below.

## Give every page a Markdown source

Two sources, with a clear precedence: **a curated route wins wherever one exists, and conversion covers everything else.**

**Curated routes** serve Markdown that is better than anything a converter can produce, or that a converter cannot produce at all:

- **Pages rendered from Markdown source.** Articles, posts, changelog entries. Serve the author's original text, frontmatter included. Converting the rendered HTML back to Markdown throws away the source and returns an approximation of it.
- **Pages the server renders on demand.** A page that reads live data at request time has no built HTML file for a build step to convert. It needs a route that produces its Markdown the same way the page produces its HTML. This is easy to miss, because such a page is usually static-rendered first and becomes on-demand later, which silently removes its sibling. When a page stops prerendering, check its sibling in the same change.

**Conversion** covers the rest: after the site builds, walk the built HTML files, extract each page's main content landmark, convert it to Markdown, and write the result next to the page as a `.md` file.

Keep the two from colliding. The conversion step must know which sibling paths a curated route already answers, and skip them. On most platforms a static file is served before a function route with the same path, so a stray converted file does not error, it just quietly shadows the real answer.

Give every converted file a small YAML frontmatter block with at least the title and the canonical URL, and start the body at a heading. An agent that fetched the Markdown alone should still know what page it is holding.

## Extract from the landmark, and expect the CSS to be carrying meaning

Convert the page's `main` landmark, not the whole document. Everything a reader would skip lives outside it already, assuming the page has a sane accessibility tree. If it does not, fix the page: this pattern rewards semantic markup and punishes wrapper soup.

Then drop what is not content in any reading:

- `script`, `style`, `noscript`, `template`
- `[hidden]` and `[aria-hidden="true"]`
- form controls: `button`, `input`, `select`, `textarea`. Markdown has nothing to click, and a filter row converts into a stranded line of noise.
- anything the site marks as belonging to one appearance or theme only. A single marker class for such content pays for itself here.

**The hard part is that a Markdown representation is not a format conversion, it is a rendering with the stylesheet removed.** Anything the CSS was carrying, and the markup was not, disappears with it. Three failures show up on almost any real site, and all three have generic fixes, so no page should need a special case:

- **Inline elements laid out as blocks.** Many build tools emit no whitespace between sibling elements, and sites lean on spans that CSS displays as blocks. Converted naively, a row of metadata reads as `02 AUG 2026featureA post title`. Insert a separating space between adjacent element siblings. Exempt code, where whitespace is content.
- **A card-shaped link wrapping several blocks.** When one `<a>` wraps a heading and a summary, converters spread the link label over several lines, and a multi-line Markdown link is not a link at all, so the destination is lost silently. Push the anchor down onto the heading instead, producing `## [Title](/path)`.
- **Responsive duplicates.** A layout that renders the same data twice and hides one copy with a media query has both copies in the DOM, distinguished by nothing the converter can see. Either mark one copy so extraction can drop it, or stop duplicating it in the component. There is no generic rule that can tell them apart.

The general tell: wherever visual layout supplies meaning the markup does not, that meaning is invisible to every consumer that is not a browser, agents included.

## Write to every output root the deploy actually serves

**A post-build step must write its files into each directory the deployed site is served from, not just the one the framework builds into.**

Hosting adapters commonly copy the framework's build output into a platform-specific output directory as the last thing the build command does, before any post-build script runs. A step that writes only into the framework's directory then passes every local check, every local preview, and every test, and ships nothing. The failure has no symptom other than agents getting HTML.

Resolve every output root once, in the emit step, and write each file to all of them. Have the validator check all of them too.

## Negotiate properly, and fall back to HTML

Negotiation belongs at the edge, in whatever runs before cache and static-file serving. Framework-level middleware is usually the wrong layer: on most frameworks it never runs for prerendered routes, which is exactly the set of pages this pattern is about.

The handler is short:

1. Map the request path to a sibling. No sibling means not negotiable, so pass the request through untouched.
2. Parse `Accept`. Unless Markdown genuinely wins, pass through.
3. Fetch the sibling URL. If it does not return 200, log it and pass through to the HTML.
4. Otherwise return the body as `text/markdown`, at the original URL.

**Do real q-value negotiation, not a substring match on the header.** The rules that matter:

| `Accept` | Serve | Why |
|---|---|---|
| `text/markdown, text/html;q=0.5` | Markdown | An explicit, outranking preference |
| `text/markdown` alone | Markdown | HTML is not accepted at all |
| `text/markdown, text/html` | HTML | A tie must favour HTML |
| `*/*` or `text/*` | HTML | A wildcard is not a preference |
| absent | HTML | |

The wildcard rule is the one to get right. Browsers and crawlers send `*/*` constantly, and treating it as a request for Markdown would change what a search engine indexes. Only a literal `text/markdown` token, with a q-value strictly above whatever HTML resolves to, should trigger negotiation.

**Fall back to HTML rather than trusting a manifest.** If the sibling 404s, serve the page. That is what makes the no-whitelist rule safe: a page the emit step never covered degrades to today's behaviour instead of erroring.

### Build the response headers, do not relay them

Read the upstream body as text and construct a fresh set of headers. Do not pass the upstream response's headers through.

The reason is that the sibling can come from two different kinds of source. A curated route is a function response; a converted file is a static file, and a static hit can arrive with a `content-encoding` that will not survive being paired with an already-decoded body. Declaring the type outright makes both sources answer identically.

Set:

- `Content-Type: text/markdown; charset=utf-8`
- `Link: <https://example.com/the/page/>; rel="canonical"`, pointing at the HTML page's canonical URL, so nothing treats the Markdown as a duplicate document
- `Vary: Accept`, on every negotiable path, so caches and CDNs do not serve one representation to the audience for the other
- a cache policy of your choosing

### The recursion guard belongs in the mapping

The handler fetches a `.md` URL, and that fetch re-enters the same handler. Do not solve this with a flag on the request or a custom header: those are easy to lose across a proxy hop.

Solve it in the path mapping. A path whose last segment contains a dot maps to no sibling, so a `.md` request re-enters the handler once, fails the mapping, and falls straight through to the routing layer. One rule, no state, and it also correctly excludes every asset on the site.

## Keep every registration in sync, with a test

This pattern needs the same list of page paths in more than one place, and every platform-level router makes it worse:

- the edge handler's route matcher
- the shared negotiation module's copy of the same list
- platform config: the `Vary: Accept` header rules, and any content-type pinning for the served files

They are duplicated because platforms typically read a route matcher **statically at build time** and cannot evaluate an imported constant, so the matcher has to be a literal. Accept the duplication and then remove the risk: keep the canonical list in the shared module, and write a test that parses the handler file and the platform config and diffs both against it.

**A path missing from the matcher fails in the worst possible direction.** Nothing errors. The page simply serves HTML forever, to everyone, including the agent that asked for Markdown, and no log line records that it happened.

Add the same sync step to whatever checklist covers adding a page or a section to the site.

## Gate the build

The HTML fallback is a safety net for a missing page, but it is equally a blindfold over a wholly broken emit step. Every check a person runs would pass while every agent got HTML.

So put a validator in the build chain, after the emit step, and fail the build when:

- a built page has no sibling, in any output root
- a sibling is empty, or has no frontmatter and no heading
- a `.md` URL has leaked into the sitemap or the feeds, which are for the canonical HTML URLs only

Prove the validator by deleting one converted file and watching the build fail. A gate that has never failed is not yet known to be a gate.

## Verify it

Check these against the deployed site, not a local build. Several of the traps above only exist in the deploy path.

- **The sample is every page shape, not one page.** Home, a section index, an entry page, a paginated page, an on-demand page. Agent-readiness scanners commonly probe only the homepage, so passing a scan is not evidence the site is covered.
- **A plain `Accept` returns byte-identical HTML to what shipped before.** This is the important regression check: negotiation must be invisible to everyone who did not ask.
- **Every negotiable path carries `Vary: Accept`**, whichever representation it served.
- **Wildcards and ties still return HTML.**
- **Curated siblings still win** where they exist. Check with something only the curated source emits, such as a frontmatter field the converter never produces.
- **The negotiated response carries the site's security headers.** Platforms differ on whether config-level headers apply to a response built inside middleware. Check rather than assume.
- **The Markdown reads well.** Fetch a few and read them. Structure, links intact, no stranded control text, no duplicated rows.

Log one line per served Markdown response, with the path and the `Accept` header that triggered it. Whether anything actually negotiates is then a query rather than an assumption, and it is the only way to find out which clients want this.
