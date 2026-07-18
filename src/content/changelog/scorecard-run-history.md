---
title: "The Scorecard gets a memory"
summary: "Redesigned /scorecard around a prominent latest run and a compact, expandable history, so score movement stays legible without creating a detail page for every audit."
date: 2026-07-18
publishedAt: 2026-07-18T00:22:47-07:00
updated: 2026-07-18
type: feature
significance: minor
tags: ["measurement", "performance", "accessibility", "agents"]
draft: false
---

The Scorecard now separates the current result from the archive. The latest run keeps the full score descriptions, pass/fail state, scope, tools, entry method, and context. Older runs collapse into a four-column ledger inspired by the changelog and expand in place when their metadata or commentary matters.

## The hypothesis

A dominant latest-run summary plus a dense chronological ledger should make score changes easier to scan without turning each audit into a separate page. Twenty runs per page is the intended archive density once the history grows large enough to paginate.

## Historical precision stays honest

The first two archive rows come from the live-network results already documented on the site: the failing Performance baseline and the passing run after fonts were self-hosted. Those audits recorded dates but not exact times, so the UI shows dates only. Future timestamps are optional ISO 8601 values; prose such as “time not recorded” is not used as a timestamp substitute.

## The audit process did not change

This is a presentation and data-shape change only. It does not change the Lighthouse or axe versions, tested page scope, pass/fail rules, audit commands, cadence, or how results are collected. Automating and maintaining the run history remains separate work.
