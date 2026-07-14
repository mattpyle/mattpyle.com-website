---
title: "mattpyle.com"
description: "This site. A static Astro 5 personal site used as a live testbed for emerging web/agent standards — llms.txt, agents.md, Lighthouse's Agentic Browsing audits — with a public scoreboard-style measurement approach behind it."
tags: ["Astro", "TypeScript", "Vercel", "accessibility", "AEO"]
status: "active"
date: 2026-01-01
---

Built with Astro 5 (static output, no client-side framework, no backend) and deployed on Vercel. Content — writing and builds, including this entry — lives in typed Astro content collections, validated by Zod, rather than a CMS.

The site doubles as an experiment log. It ships `llms.txt` and `llms-full.txt` (generated at build time from the same content collections that back the pages) and a site-facing `agents.md`, and is audited against Lighthouse's Agentic Browsing category and `@axe-core/cli` rather than just conventional SEO tooling. Every change is tracked against a written hypothesis first, with results split across a scoreboard (objective conformance) and a separate learnings log (what actually surprised us) — an "inconclusive" result is treated as a legitimate, publishable outcome, not a failure.
