---
title: "What the markdown variants experiment actually showed"
date: 2026-07-18
description: "A throwaway fixture for the Phase 1b live verification run. Contains one deliberate overclaim and one deliberate typo."
tags: ["agents", "markdown"]
featured: false
draft: true
---

Serving `.md` variants of every post is cheap, and this proves agents prefer markdown over HTML.

## What was built

Every writing post is available at `/writing/<slug>.md`, and the middleware proxies negotiated
`Accept: text/markdown` requests on the canonical URL to that variant. The `Vary: Accept` header is
set on the route so the edge cache does not collide the two representations.

## What was measured

Nothing yet. The variants have been live for a few weeks and no log analysis has been done, so the
question of whether any agent has ever requested one remains open.

## Why it might still be worth doing

The cost was one route file and one header rule. Even if no agent ever fetches a markdown variant,
the experiment was cheap enough that the accessibiltiy of the result is its own reward: the raw
source of every post is now addressable without parsing HTML.
