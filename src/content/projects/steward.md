---
title: "Steward"
description: "An agent-readiness auditor and this site's editorial agent, built on Temporal. It checks what a site tells an agent over plain HTTP, then opens the pages in a real browser for Lighthouse and axe-core. Each run is a durable workflow that survives a worker restart."
tags: ["Temporal", "TypeScript", "MCP", "accessibility"]
status: "live"
live: "https://www.mattpyle.com/steward/"
github: "https://github.com/mattpyle/mattpyle.com-website"
date: 2026-07-18
image: ../../assets/projects/steward.png
---

Steward started as the agent that reviews a draft post: spelling, prose linting, an editorial pass, and a real production build with accessibility and performance audits. It waits durably for approval, publishes by pull request, then verifies production.

The agent-readiness audit was one step of that review, and it turned out to be the part worth pointing at other sites. It is open to anyone through an MCP endpoint, an A2A skill and a form at [/audit](/audit/). The fast tier answers in seconds. The deep tier runs as a Temporal workflow you poll. The code lives in the `agents/steward` directory of this site's repository.
