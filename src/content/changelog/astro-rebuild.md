---
title: "Rebuilt on Astro"
summary: "Moved the site onto Astro content collections and shipped the foundational discoverability layer — sitemap, robots.txt, agents.md, and llms.txt. The foundation everything else here sits on."
seoTitle: "Rebuilt on Astro with a discoverability layer"
seoDescription: "Moved the site onto Astro content collections and shipped the discoverability layer: sitemap, robots.txt, agents.md, and llms.txt."
date: 2026-07-12
updated: 2026-07-26
type: launch
significance: major
tags: ["infra"]
hero: ../../assets/tech-stack.png
heroAlt: "Isometric diagram of the site's foundation: an Astro content-collections layer resting on a base block, connected to robots.txt, sitemap.xml, agents.md, and llms.txt. Discoverable by machines, useful for people."
draft: false
---

The site was rebuilt on Astro, with content living in typed content collections rather than hand-maintained pages. This is the substrate every later entry builds on — writing and builds are Zod-validated collections, and pages that expose them (the sitemap, `llms.txt`, this changelog) are generated from that same source at build time.

## The discoverability layer

The rebuild shipped the foundational files that make the site legible to machines as well as people:

- **`robots.txt`** — allow-all, including AI crawlers.
- **XML sitemap** — auto-generated, with per-page last-modified dates.
- **`agents.md`** — a plain-language brief for AI agents reading or citing the site.
- **`llms.txt` / `llms-full.txt`** — a concise index and a full content export.

Plus a simplified visual baseline, a favicon set, and Open Graph / Twitter share metadata.
