---
title: "A new light theme"
summary: "Retired the dark, amber, monospace look for a warmer, serif-led reading design — and moved the accent from a default-reading clay orange to oxblood to break the 'AI-generated design' tell."
date: 2026-07-13
type: feature
significance: major
tags: ["design"]
draft: false
---

The site traded its dark, amber-on-black, monospace look for the warmer, serif-led reading design you're looking at now: a cream ground, Source Serif 4 for titles and prose, JetBrains Mono for labels and metadata.

## Why the accent moved

The first pass used a terracotta accent. Warm cream plus a serif display face plus a clay-orange accent is precisely the combination Anthropic's own frontend-design guidance names as the "AI-generated design" tell — it reads as a default, not a choice. So the accent moved to oxblood.

The change was aesthetic, not an accessibility fix — but I measured contrast rather than eyeballing it. The new accent clears WCAG AAA at 8.69:1 on the page background, where the old one only cleared AA. 
