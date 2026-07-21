---
title: "A quiet afternoon with a durable workflow"
date: 2026-07-20
description: "A short, low-stakes draft used to demo the Steward's review pipeline end-to-end on a scratch database."
tags: ["demo"]
draft: false
---

## Why this draft exists

This post isn't really about anything. It's a throwaway piece of prose, separated
from the rest of the site's writing, whose only job is to give a reviewer
something to read while a Temporal workflow works through its checks in the
background.

## What the Steward looks at

The review pipeline runs a handful of passes over a draft like this one: a
spell check, a prose linter, an editorial pass that looks for unsupported
claims, and a real build-and-audit step that renders the page and runs
accessibility and performance checks against it. Each pass reports back
independently, and the results get synthesized into a single report before a
human ever has to look at it.

None of that is exotic. What's interesting is the durability underneath it —
the workflow can sit parked for hours or days waiting on a human decision,
survive a worker restart, and resume exactly where it left off without losing
any of the state it accumulated along the way. That property is the whole
reason this is built on Temporal rather than as a one-shot script.

## What this draft is not

This isn't a real post. It won't be published, and its content doesn't matter
beyond giving the pipeline something to chew on. If you're reading this in the
writing index, something has gone wrong — it should stay `draft: true` and out
of every generated feed indefinitely.
