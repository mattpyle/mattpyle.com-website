---
title: "Accessibility, AI, and testing with screen readers"
date: 2026-07-13
updated: 2026-08-07
description: "AI built this site. Every automated tool gave it top marks. Then I installed a screen reader for the first time, spent an evening fumbling with it, and heard what my site actually sounds like."
seoTitle: "Accessibility, AI, and screen reader testing"
seoDescription: "AI built this website and every automated tool gave it top marks. Then I used a screen reader for the first time and heard what those tools missed."
tags: ["accessibility", "agents", "measurement"]
featured: false
draft: false
---

Lighthouse 13.3, launched in May 2026, shipped an [**Agentic Browsing**](https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring) audit category by default. As the standards for the agentic web are still emerging, the Agentic Browsing category gives binary pass/fail signals instead of a 1-100 scale like other categories, and is one of many emerging tools prompting us to ask the question: *can an AI agent actually read my site?*.

The past 12 months have brought an interesting new spotlight on a11y practices. The accessibility tree, which acts as the semantic bridge between website code and assistive technologies, is now being [parsed by AI agents alongside the raw HTML and screenshots](https://www.accessibility.works/blog/value-of-accessibility-compliance-for-aeo-in-agentic-web-era/). Clean, semantic trees allow agents to easily find valuable buttons and fields such as "add to cart" or "sign up" without relying on fragile screenshots or bloated code.

Generic audits and checklists give you a false sense of security and accomplishment, the same failure mode as every generic SEO audit checklist: **scan the thing, change the thing, get a green check, feel good**.

This website exists to build, play, experiment, and learn so I ran an accessibility audit against this website and learned that in order to truly evaluate your accessibility experience, you must experience it yourself.

## a11y is for everyone

![The Simpsons meme with Milhouse telling Bart "Remember A11y? Now it's back! In bot form."](../../assets/a11y-bot-form.png)

I could write anything in the alt attribute for the above image and the build would pass. An automated accessibility testing tool would fail me for omitting an alt tag, but it'd happily pass a really terrible one. My score would go up.

A11y (or, accessibility) has been a passion of mine for a while. Consider it a sign of my growing age, but I still remember my life before the Internet and the immediate life-changing impact it had and still has. Ensuring that every human has an equitable and safe experience online to unlock that same impact is a basic requirement that is often shamefully overlooked.

Building this site has been a hobby project. Equal parts: write more; be more visible; build and have fun.

As part of this, I want to use this website as a testbed for all things online - whether it's accessibility, SEO, AEO, performance. Getting hands-on with my own brand for the things I work with my team on at work. Experiment, fail, learn, and share those learnings transparently.

Will the bot revolution bring fair online experiences for all humans? We'll see.

## What the code review caught and missed

The filter buttons on my writing index communicate their active state through a CSS class and nothing else. Nothing in the markup says which filter is on.

A sighted human sees the highlighted pill and knows which filter is applied. The accessibility tree sees **multiple identical, indistinguishable buttons.** A screen reader user, and an agent, cannot tell which filter is active, or that clicking one did anything at all.

However, `/about` had no `<h1>`. At all. This is one of those things that has appeared in my professional life when auditing website best practices. Apparently it's as easy for a bot to skip as it is for the human who wrote the page.

The Lighthouse accessibility-tree audit and my own checklist, built from years of experience, somehow completely missed it. Who would miss a h1? Honestly? Thankfully, having multiple instruments paid off as axe caught it instantly.

I'd explicitly worried about the *opposite* problem, writing a note in my SEO checklist to "confirm no page renders two `h1`s".

## How 'aria-pressed' works

I asked my Coding Assistant to fix the filter: "Fix the issue, maximum effort, make no mistakes".

`aria-pressed` was added to each pill — `true` on the active one, `false` on the rest. axe reported zero violations. Lighthouse stayed at 100. Agentic Browsing stayed at 3/3 (Accessibility tree is well-formed, Cumulative Layout Shift passes, and llms.txt follows recommendations).

Then I read the spec properly.

`aria-pressed` describes a **toggle button** — an independent on/off state. Press it once, it's on; press it again, it's off. My filters on my blog index page aren't that. They're **mutually exclusive**: clicking `AI` *deselects* `ALL`. Only one is ever active. Announcing "AI, toggle button, pressed" tells you nothing about `ALL` having just switched off, and falsely implies each pill toggles independently.

Every automated tool passed it as `aria-pressed` on a `<button>` is *syntactically valid ARIA*. axe can't know my buttons are mutually exclusive. Nothing can, by reading the markup alone.

I had shipped the `aria-pressed` change based on my AI Coding Agent's recommendation. It was only when I read the spec that I had doubts.

Admittedly, I am still a bit lost here. Reading the [W3C ARIA spec](https://www.w3.org/TR/wai-aria-1.2/#aria-pressed), my implementation seems acceptable. Imperfect, but acceptable.

Ultimately, I settled on keeping the filters as buttons with the current active one `aria-current="true"`, and announce the result in a live region. I considered `aria-selected` but that's invalid on `role=button`, `aria-expanded` is for disclosure widgets, which this isn't. Radio/tab patterns are semantically exact but carry an arrow-key contract you'd then have to honour.

## Experiencing a screen reader for the first time

I had never used a screen reader. I always professed the importance of web accessibility and equity for all, spent my time reading markup and quoting best practices, yet, in a career built on the web, I had never truly listened. I had no idea what a website sounded like.

It took an evening of fumbling. Every machine interaction narrated, constantly. Overstimulating in a way I hadn't experienced. That's how a lot of people use an operating system, software, the web. All the time.

My first attempt was in Chrome and NVDA was just repeating "Chrome Legacy Window", over and over. I spent twenty minutes convinced I'd built a site that was completely unreadable to screen readers, and I was ready to write that sentence down. It turned out to be a known NVDA/Chrome issue on my machine. Nothing to do with my website. NVDA would have said the same thing on Wikipedia.

### First, by accident: the page I hadn't fixed

I ran the test on the wrong page. A happy little accident.

My site has *two* filter widgets — one on `/writing`, one on `/builds`. I had only ever fixed one of them. I didn't account for the other one (who has two filter components?!).

So the first thing I heard was the original bug, still live:

<figure>

```
ALL           button
ACTIVE        button
IN PROGRESS   button
ARCHIVED      button
```

<figcaption>/builds — the component I never fixed. Every pill announces identically. Nothing tells you which filter is active.</figcaption>
</figure>

Four identical buttons. No state, no "current", nothing. Exactly what I'd been told the accessibility tree would see. Except now I could hear it.

*Dear reader, I've since fixed it. A successful refactor, deleting one of the two components and using the same one twice.*

### Then, the page I had changed

<figure>

```
Skip to content    same page  link
banner landmark    Matt Pyle — home  link
Main navigation    navigation landmark
  Writing   visited  link
  Builds    visited  link
  About     link
main landmark      FIELD NOTES

Filter by topic    grouping
  ALL             button    current      ← aria-current="true"
  AI              button
  PLG             button
  SAAS            button
  BUILDING        button
  GROWTH          button
  MARKETING       button
  PERSONAL        button
  TOOLS           button

[Enter on TOOLS]

Showing 1 article tagged TOOLS.          ← the live region firing
current
```

<figcaption>/writing — after the fix. Keyboard navigation only, production build.</figcaption>
</figure>

It worked. The active pill announces as `current`. The inactive ones announce no state at all, which is correct. And when I hit Enter, the live region speaks: *"Showing 1 article tagged TOOLS."*

A screen reader user knows which filter is on, and knows what happened when they changed it.

That's the first thing in this entire exercise I verified by *listening* rather than by reading a score.

## But how does this site score?

The site was already at 100 Accessibility, 100 SEO, 100 Best Practices, and 3/3 on Agentic Browsing before any of this. It passed everything but, you know, there's not much here.

This website will be as transparent as possible. I've launched a publicly-facing [`/scorecard`](/scorecard) with my own scores across these categories as well as a change log and what I learned from each change.

## A green scoreboard is only a signal

An agent's view of your site is not a degraded version of a human's view. Tools validate syntax, not what we want the visitor to consume, feel, and think. You can pass every automated check yet it'd still misrepresent the lived experience your users have with your interface. A clean audit tells you that you haven't broken any rules. It cannot tell you your markup is true.

Now, this is a basic hobbyist website. Nothing here is overly complex. In the grand scale, this is an anecdote about a small issue encountered while trying to make this the best possible website it can. However, I think this is a signal of how the changing landscape of Agent Experience (AX) is shining a fresh spotlight on accessibility. I hope that this renewed focus means that every developer, designer, product manager, and marketer will put the same focus on accessibility equity for humans that we all deserve.

Read the spec. Then go and listen to it.
