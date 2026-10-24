---
title: "Steward measures an agent's reading budget"
summary: "The agent audit and the nightly scorecard now measure how much of the first 8,000 characters an agent reads on each page is content rather than navigation, as text and as markdown, so a header that eats an agent's first read shows up as a number."
seoTitle: "Steward measures an agent's reading budget per page"
seoDescription: "The agent audit and the nightly scorecard measure how much of the first 8,000 characters an agent reads on each page is content rather than navigation."
date: 2026-10-22
publishedAt: 2026-10-22T23:30:00-07:00
updated: 2026-10-22
type: feature
significance: minor
tags: ["measurement", "agents"]
draft: false
---

[Peec AI's study of Deep Research session logs](https://peec.ai/blog/how-chatgpt-deep-research-reads-your-site-what-the-logs-reveal) (June 2026) found that an agent sees a capped window of a page on first read, about 5,700 characters at the median and about 8,000 at most, and that links eat it: real content fell from about 78% of the window on pages with under 20 links to about 33% on pages with 60 or more. A page is read in source order, so a header full of links is read before the first sentence of the body, whatever the screen shows.

This site now measures that number for itself.

## What is measured

For each page, the share of the first 8,000 characters that is the page's main content, twice:

| Reading | What an agent gets | Main content |
|---|---|---|
| Text | The HTML rendered the way a markdown converter reads it: links as `[text](url)`, images as their alt text, scripts and styles dropped | The `main` element, or `article` when there is none |
| Markdown | The page's markdown twin, served to a client that sends `Accept: text/markdown` | Everything after the front matter that is not a list of bare links |

A page shorter than 8,000 characters is measured over its whole length, and the figure says so.

## Where it shows

1. `steward audit-url` reports two `reading-budget` rows for any site, the homepage and a sitemap-named content page, from the responses its negotiation checks already fetched. Give it a page URL and it measures that page too.
2. The nightly scorecard run measures every live page and writes the lowest share, with the page it was found on, beside the four gates. [/scorecard](/scorecard/) prints that sentence from the first run that carries it, and [/scorecard.json](/scorecard.json) carries it as data.

## What it is not

The study gives bands, not a target, so the figure passes nothing and fails nothing. It is a number to make a layout decision with, and the four scorecard gates are unchanged.
