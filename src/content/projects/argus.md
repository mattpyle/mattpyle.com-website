---
title: "Argus"
description: "A persona inspector. Each day it visits a site as one kind of visitor, such as a recruiter or a screen-reader user, and files what that visitor wanted and did not get. A finding waits for a verdict before anything is fixed."
tags: ["agents", "Hermes", "QA"]
status: "live"
date: 2026-09-07
---

Argus runs on Hermes, not Temporal. Each run wears one scenario with a goal, a first action and a definition of success. It browses the site at desktop and phone widths, measures what it suspects, and reads the site's source to name the cause.

A finding is a markdown file with a URL, the evidence and a way to measure the fix. Matt approves or rejects each one, and a rejection carries a reason that Argus reads on its next run. Approved findings become work on this site: the visible feed links, the byline on a post and the 404 page all started as Argus findings. The repository is private.
