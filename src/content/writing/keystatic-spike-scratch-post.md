---
title: Keystatic spike scratch post
date: 2026-08-30
tags: []
draft: true
description: Spike artifact, written in Keystatic.
---
This paragraph exists to find out what writing in Keystatic feels like when the words matter more than the file. The test is deliberately ordinary: a few hundred words, a couple of headings, a list, a link, some inline code, and one image. Nothing here is meant to publish.

## What the editor gets right

Headings render as headings the moment the space lands after the hashes. That is the whole trick, and it is a real one: the page in front of me looks like the page a reader gets, so the sentence I am fixing is the sentence, not a line of source that stands for it. The frontmatter has moved out of the way entirely. It sits in a panel on the right as nine labelled controls, and none of it interrupts the paragraph I am in.

- A list item, entered the way a list item is entered in any markdown file.
- A second item, to prove the list continues on its own.

## Where the syntax still shows

Inline code still wants backticks. Typing a backtick, a token, and a closing backtick produces a code span and drops the caret cleanly back into plain text afterwards. A link is the same bargain: the markdown spelling is what my hands already know, so the syntax has not gone away, it has only stopped being the thing on screen.

The site already publishes a [scorecard](/scorecard/) and this draft links to it to check that the link input rule fires. The draft switch in the panel writes `draft: true` into the frontmatter.

The image below was pasted straight into the editor, which is the part of the flow the spike most wanted to see, because Astro only optimizes what lands under src/assets with a relative reference.

![A plain dark blue rectangle, used only to test image handling.](../../assets/writing/keystatic-spike-scratch-post/spike-paste.png)

Alt text sits in a dialog behind a pencil icon rather than a prompt at paste time, and the field is optional. For a site that publishes an accessibility scorecard, that is the one place this editor is quieter than it should be.
