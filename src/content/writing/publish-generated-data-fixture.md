---
title: "Publish generated data fixture"
description: "A throwaway draft used to prove that a publish PR carries the regenerated src/data files."
date: 2026-09-04
draft: false
---

## Why this file exists

This draft exists to test one thing: a publish pull request carries the regenerated files under `src/data/`.

Three of the site's build scripts write files that are committed. Site tests then assert that the committed copy matches what the generator produces from the content tree. Adding a post changes that tree, so a publish that carries only the markdown leaves those files stale and the tests go red.

## What to look for

The pull request this draft opens should list `src/data/page-paths.mjs` and `src/data/a2a-digest.json` beside the markdown. Both check runs should be green.

The pull request is closed without merging once it has been read.
