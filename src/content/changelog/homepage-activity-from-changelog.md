---
title: "Homepage activity now comes from the changelog"
summary: "The homepage's hand-maintained activity list is now a linked preview of the public changelog, with explicit dates and deterministic same-day ordering."
date: 2026-07-17
publishedAt: 2026-07-18T06:31:45Z
updated: 2026-07-17
type: feature
significance: minor
tags: ["meta", "changelog", "accessibility"]
draft: false
---

The homepage's Latest Activity panel now reads directly from the same changelog collection as this page. Its four entries cannot drift into a separate, manually edited version of the site's history anymore.

Each row links to the full changelog entry and shows an explicit `DD MON YYYY` date, significance dot, and type. The visible date stays compact without becoming ambiguous across years or between month-first and day-first readers; its `<time>` element retains the ISO ship date for machines.

## Same-day changes have a real order

Changelog entries still use a date-only ship date, but can now add an exact `publishedAt` timestamp when it is known. Same-day ties fall back deterministically to significance, launch type, title, and finally slug. Historical entries remain honest rather than receiving invented timestamps.

The comparator is shared by the homepage, changelog index and navigation, `llms.txt`, `llms-full.txt`, and the WebMCP content index, so every surface agrees about what “latest” means.
