---
title: "WebMCP read-only tool surface"
summary: "Registered three read-only, agent-callable WebMCP tools behind Chrome's origin trial — pure progressive enhancement, removable in one step, and consumed by approximately nothing."
date: 2026-07-17
type: experiment
significance: minor
tags: ["agents", "webmcp"]
draft: false
---

The live pages now register three read-only [WebMCP](https://github.com/webmachinelearning/webmcp) tools — `describe_site`, `get_recent_writing`, and `search_content` — backed by a single static JSON index. They're layered on as progressive enhancement: the site renders and behaves identically with the whole feature deleted, and does so in exactly one step.

## The hypothesis, and where it broke

Going in, I assumed Chrome might return the API undefined even with a valid token, that `document.modelContext` was the new surface and `navigator` the deprecated one, and that Chrome would validate the declared input schema. Measured against Chrome 150 on the live origin trial, three of those were wrong.

The API works, the two surfaces are the *same object*, and Chrome does **not** validate the schema — which means the input-clamping guards in the tool handlers are load-bearing validation, not decoration.

## No consumption claimed

Registration and execution were driven through devtools against the real API, not by an agent. The origin-trial token expires 2026-11-17, after which Chrome ignores it and the tools silently stop registering — a harmless no-op. This is the kind of result this site exists to produce: shipped it, measured it, learned something specific, and it moved no metric anyone would notice.
