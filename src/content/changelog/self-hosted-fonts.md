---
title: "Self-hosted fonts, Performance back to 100"
summary: "Dropped the render-blocking cross-origin Google Fonts stylesheet for self-hosted subset woff2 files. Live Performance went from 84–87 to 97–100 on every page; first paint from ~3.3s to under a second."
date: 2026-07-14
type: infra
significance: major
tags: ["performance"]
draft: false
---

The site's first live-network audit showed Performance failing its ≥95 budget at 84–87. Total blocking time was zero everywhere — the entire cost was a single render-blocking, cross-origin Google Fonts stylesheet under simulated slow-4G.

## The fix

I downloaded the exact variable woff2 files Google was serving to Chrome — JetBrains Mono and Source Serif 4, latin and latin-ext subsets only — into the repo, moved the `@font-face` rules into the site's own CSS, preloaded the two latin files, and deleted the Google Fonts link and its preconnects.

| Metric | Before | After |
|---|---|---|
| Performance | 84–87 | 97–100 |
| First Contentful Paint | 3.2–3.5s | 0.8–1.0s |
| Cumulative Layout Shift | 0 | 0 |

## A stricter CSP, for free

With no cross-origin font requests left, the Content Security Policy dropped its last third-party origins — zero external origins now remain in the policy. The font files ship with an immutable cache header, so the one rule to remember is: rename the file if the font ever changes.
