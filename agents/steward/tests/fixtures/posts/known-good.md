---
title: "A clean draft with nothing wrong in it"
date: 2026-07-18
description: "A fixture post that should produce zero findings from every Phase 1a mechanical pass."
tags: ["testing"]
featured: false
draft: true
---

## The point of this fixture

Every Phase 1a pass should return `pass` against this file. If a change makes it
emit a finding, either the change is wrong or the fixture needs updating — decide
which deliberately, rather than editing the fixture to make a test green.

![A screenshot of a terminal showing the steward CLI printing a clean report](../../assets/steward-clean.png)

## Why the alt text above is real

The alt text conveys what the image shows, not the filename. That is the rule the
frontmatter pass enforces, and the fixture has to model it.
