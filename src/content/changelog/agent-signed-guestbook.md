---
title: "A guest book an agent can sign"
summary: "The retro homepage gets 1997 functionality: a guest book, a web ring, and a visit counter. The guest book is the first place on this site where an agent can create content, through WebMCP."
date: 2026-08-02
publishedAt: 2026-08-03T21:00:00-07:00
updated: 2026-08-03
type: feature
significance: major
tags: ["agents", "webmcp"]
hero: ../../assets/guestbook-changelog-hero.png
heroAlt: "Hero image to announce the guest book on retro mode, showing a 1990s era PC with the monitor displaying a rendered version of the guest book with a robot hand writing to it with a pen."
draft: false
---

The retro homepage now has what every 1997 personal site had: a guest book, a web ring, a visit counter, and a note to the webmaster. An agent can sign the guest book through [WebMCP](/webmcp), and both an external client and a model working from plain English have now done so on production.

## Straight out of 1997

Guest books, web rings, and hit counters were the social layer of the early web. You visited a site, you signed the book, and you followed the ring to the next site. [Retro mode](/changelog/agent-driven-retro-mode) rebuilt the look of that era; this adds the parts you could touch.

## An agent can sign my guest book

`sign_guestbook` is the site's second WebMCP write tool, and the first that creates something instead of changing a setting. It takes a name and a message, clamps both to the same limits the visible form enforces, and confirms with the entry number and where the entry now sits. A second new tool, `list_related_sites`, reads the web ring.

The book lives in your browser's localStorage. Nothing goes to a server, and no other visitor sees your entries.

## Testing WebMCP write functionality

There are two ways to test a WebMCP surface today: call a named tool directly, or hand the whole surface to a model and see what it picks. I ran both against production.

The direct layer needs no model and no API key. I used the [WebMCP - Model Context Tool Inspector](https://chromewebstore.google.com/detail/webmcp-model-context-tool/gbpdfapgefenggkahomfgkhfehlcenpd) extension, running outside the page, enumerated all six tools and invoked every one.

The model layer is the more interesting test. I ran the inspector's Gemini mode with a free AI Studio key and plain-English prompts, no tool names. Seven tool selections across five conversations, seven correct.

## Try it

Turn on retro mode with the footer toggle and sign the book by hand. To sign it the way an agent does, install the [WebMCP - Model Context Tool Inspector](https://chromewebstore.google.com/detail/webmcp-model-context-tool/gbpdfapgefenggkahomfgkhfehlcenpd) extension and enable `chrome://flags/#enable-webmcp-testing`. Direct tool calls need no API key; the model-driven mode needs a free Gemini key.
