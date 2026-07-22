---
title: "Hello, World! Or, this post is a lie."
date: 2026-07-18
updated: 2026-07-18
description: "Testing Temporal workflows, deterministic standards, and agentic AI to build an editor for my website"
seoTitle: "Hello, World! Or, this post is a lie."
seoDescription: "Testing Temporal workflows, deterministic standards, and agentic AI to build an editor for my website"
tags: ["agents", "temporal", "tech"]
featured: false
draft: false
---

I think I committed a cardinal sin. A "Hello, World!" post as the second published entry feels...off yet, here we are.

## Why this site exists

This website has two primary purposes: 
1. Encourage me to write more about the topics I care about and find interesting
2. Learn and experiment with evolving website trends and development practices in the era of AI

Those are the two I'll tell everyone but there's a reason this website is public under this domain name https://www.mattpyle.com. I'm looking to improve my personal brand. I've owned this domain since 2015. For a while it went nowhere, then, I did a lazy thing and, forwarded it my LinkedIn. Lame! This gave me the excuse of just leaving it. 

I've never been good at self-promotion and advocacy so I'm utilising what I do find interesting such as playing, building, tinkering, and experimenting, and using that as a forcing-function to create, and write about, this very site, out in the open.

*side note: Before this domain, I owned `matthewpyle.com` but the only people who call me Matthew are the government and my mum when I've done something wrong.*

## Building in the open

One of the goals of this website is to be as transparent as possible, while remaining safe and secure. The website codebase is available to view on my [Github profile](https://github.com/mattpyle/mattpyle.com-website), verified site test scores are published on the [scorecard](/scorecard), there's a [changelog](/changelog) where details on major site changes and features are shared. 

This is just the start. As can be read on the changelog, a lot of experimental features, such as adding a [WebMCP surface](/changelog/webmcp-tools), have been added in the short time since this site went live. Those features and changes are all in the pursuit of learning (something I enjoy) and will be written and shared here (something I'm learning to enjoy!).

There are a few things currently .gitignored. Aside from environment variables, api keys, and config that has no reason to be public I'm currently not sharing:
- Claude.md - *for Claude*
- AGENTS.md - *for Codex*
- Backlog.md - An evolving set of ideas for website features, builds, and content
- Learnings.md - A quick file to capture learnings from building. *note to self: this is actually looking outdated*
- Scoreboard.md - This captures the output and scores from regular performance, a11y, seo, and agentic browsing checks. Now available publicly on the [scorecard](/scorecard)
- `/steward` - The reason this post exists *...more on that later*

### This post is a test

Ignore the title. This is not your typical "Hello, World!" article, made obvious by this not being the very first post.

Truthfully, I'm building something I think is cool. My AI coding assistants have essentially forced me to write this post, in my own writing style, prose, grammar, *Britishisms*, and including my own mistakes in order to test the prototype of Steward.

## Steward - Demonstrating Temporal & agentic workflows on this website

### What is Steward?

Steward is an editorial agent that owns the path from a draft article (`draft: true`) to published for posts on this website, mattpyle.com. It is implemented as Temporal workflows running against a local [Temporal](https://temporal.io) dev server, with a worker whose activities review, score, and gate a post; wait durably for a human verdict; and then execute the publish mechanics end-to-end, including live verification against the deployed origin.

### Why does Steward exist?

The thesis being demonstrated is: **the difference between an AI toy and an AI coworker is durable execution, observability, and a human-in-the-loop protocol.** The Temporal workflow history is the agent's audit log.

However, I already outlined this website's purposes as learning and building in the open. Here, I'm looking to learn how developers (and even non-devs, such as *vibe-coders*) build with Temporal and how agentic AI workflows are launched and used in production-like environments.

### Testing Temporal and agents

As I alluded to, this post is a test. I currently have a local Temporal dev server running, using the [Typescript SDK](https://github.com/temporalio/sdk-typescript), and the [Temporal Developer skill](https://github.com/temporalio/skill-temporal-developer). So far, I have spent the exorbitant fee of $0.08 USD in Anthropic API usage.

Then, both Opus in Claude Code and Fable in Claude Chat told me **"You need to write more in order for us to test this properly"**.

## The tech stack

Right now, I am *phoning in* in the rest of this post. I'm losing a bit of steam and, dear reader, you can be assured that this will be much better quality when it meets your eyes, all thanks to excessive amounts of coffee, the gentle nudges of my coding assistants, and Steward.

However, the tech stack and tooling for this website is as follows:
- [Astro 7](https://astro.build/blog/astro-7/) - a lightweight framework for content-driven sites, all content written in Markdown
- Hosted on [Vercel](https://vercel.com) hobby tier for now (I'm not that popular!)
- Using Claude Code and Codex to build
- [WebMCP](https://github.com/webmachinelearning/webmcp) - This site is enrolled in the WebMCP Origin Trial and, if you so desire, you can test out the functionality!
- Axe - The repo has built in Github actions that run [axe-core accessibility](https://github.com/mattpyle/mattpyle.com-website/actions) checks on production builds
- [CSpell](https://cspell.org/) - Since this is all markdown, I'm writing this very article in VS Code which surfaced the need to check my spelling. Vale does that, and is being built into Steward.

By the time this post goes live, I hope to say:
- Temporal server, workers, and workflows
- [Vale](https://vale.sh/) is being used to check the quality of my writing mechanically and deterministically.

It's important to note one thing about Vale, CSpell, and other deterministic checks on this website. One part of Steward is to create a learning loop. Where the Editor agent finds issues that could have been diagnosed mechanically, it is captured as a learning and implemented against. This will both save costs and resources, but also allow the agent to focus on what it will do best.

## How this site is built

I'm currently using both Claude and ChatGPT to build this website. It's a mix of all their offerings — Design, CLI, Codex, Desktop apps.

I tend to lean towards designing a plan with the higher-intelligence (and higher-cost) frontier models, implementing incrementally with lower-effort and lower-priced models, and continuously re-reviewing with the planners. However, competition is creating a healthy environment for the end-users right now and frequent usage resets, increased limits, and promotional offers are allowing me to try different things.

Using multiple LLM/AI tool stacks in collaboration is a learning experience and I soon hope to try others such as Kimi K3 and GLM 5.2.

## What's next?

Well, I give this post to Steward. Then... I tell you what happened.