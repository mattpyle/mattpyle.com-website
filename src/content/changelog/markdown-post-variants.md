---
title: "Raw-markdown post variants + content negotiation"
summary: "Every post now has a token-efficient raw-markdown sibling at /writing/<slug>.md, and the canonical URL itself serves markdown when a request genuinely prefers it. Took three attempts to land the negotiation."
date: 2026-07-16
type: infra
significance: minor
tags: ["agents", "aeo"]
draft: false
---

Agents scraping a post used to pay full HTML-parsing cost and site chrome to reach prose that's already stored as markdown. Now each post has a raw-markdown variant at `/writing/<slug>.md` — attribution frontmatter, a canonical link back to the HTML page, and no site chrome — discoverable from the HTML page itself.

## Phase 2: same URL, negotiated

The second phase made the *canonical* URL serve markdown when a request's `Accept` header genuinely prefers `text/markdown` over `text/html` — real RFC 7231 q-value negotiation, not a substring match.

It took three attempts. A `vercel.json` rewrite proved dead on arrival because Vercel checks the filesystem for a matching static file before evaluating rewrites. Routing Middleware fixed the ordering but then 404'd, because on this adapter Astro's on-demand renderer can only resolve a route as the literal top-level request — not through any internal routing-layer rewrite.

## What actually shipped

The middleware does the Accept parsing and then `fetch()`es the already-working `.md` endpoint directly, relaying the response verbatim under the original URL — a reverse proxy inside the middleware rather than a routing trick. Verified live with a full curl matrix: HTML for browsers, markdown for agents that ask for it, and no cache cross-contamination between the two.
