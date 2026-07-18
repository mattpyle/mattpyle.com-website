---
title: "mattpyle.com goes live"
summary: "The domain went live with www as the canonical host. Fixed every emitted URL to the canonical host, fixed a layout-shift regression, captured the first live-network baseline, and confirmed every AI crawler gets a 200."
date: 2026-07-14
type: launch
significance: major
tags: ["infra"]
draft: false
---

## Hello World!

The site went live on its real domain, with `www` as the canonical host and the apex redirecting to it. Going live surfaced the things that only a real network hop can.

## What the live network exposed

The config's `site` was still the apex, so every canonical, `og:url`, sitemap entry, and structured-data URL emitted a host that immediately redirected out from under crawlers. Fixed at the source and in the four places that hardcoded it.

A layout-shift regression on the list pages was fixed with metric-matched fallback fonts, so the web-font swap changes glyph shapes, not layout — live CLS is 0 on all five page types.

## First honest numbers

This replaced every prior localhost baseline, which had been flattering the site by construction. The first live-network audit is the one that found the Performance gap — see the [self-hosted fonts](/changelog/self-hosted-fonts) entry for how that got closed. All six AI crawler user agents were confirmed to receive a 200.
