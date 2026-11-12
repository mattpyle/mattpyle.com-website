# Writing a fix log entry

This brief is for whoever writes the text of an entry in `src/content/fixes/`: a person, or a model in a Steward activity. `scripts/fix-log-entries.mjs` writes the facts. You write the title, the lead, the measures and the story. The brief is first-pass and will change; edit it when an entry teaches you something.

## The reader

The reader knows nothing about this site's tooling. It may be a colleague of Matt's, a developer, or an agent. They want to know what was wrong, whom it let down, what changed and whether it worked. They do not want to know how the problem was found, which system measured it, or how long it took.

## What you read

1. The finding: its summary, "Who wanted what", "What happened", "What would serve them", "Why it matters", and the checks in its Verification section.
2. The fix pull request: its title, its body and its diff.
3. Any later pull request that finished or repaired the fix. Add it to `changes` by hand.

Use only facts from those sources. When a source does not say something, leave it out.

## The title

1. Say what was wrong, as a plain past-tense statement of fact.
2. Name the concrete thing: the page, the file or the feature. "The WebMCP post", not "a post".
3. Aim for 40 to 65 characters.
4. No wordplay, no question, no "the fix that…", no colon-joined halves.
5. It must stand alone as one row of an index, with no lead beside it.

Good: "The WebMCP post sent readers to its tools through a redirect".

## The slug

Set `slug` once, when you first write the title: the title in lower case, words joined by hyphens, under 71 characters. Never change it afterwards, because the page's URL is the slug and people hold links to it.

## The lead

One sentence under the title, under 25 words. Say whom the problem let down and how, or give the cause in plain words. Add what the title leaves out; do not repeat it.

## The before and after

An entry shows its before and after once, in the single best form. Hold `measures` or `text`, never both and never neither. The schema refuses both.

The forms, in order of preference:

1. A real measurement, a number a reader cares about: "Posts that start on the first phone screen", 0 of 3, then 1 of 3. Use one only where the finding or the fix pull request holds the number.
2. A short pair of words: the channels a file names, the label a screen reader spoke. Set `quoted: true` only for text the reader would see or hear verbatim.
3. The changed lines, in `text`: a few lines a reader can read, as they were and as they are.

Rules for the form:

1. The check's own test is never a measure. A count of occurrences of a string, copies of a sentence or instances of a phrase tells a reader nothing. A label that names one fails the test.
2. A second measure stays only when it measures a different thing.
3. The label names what is counted or shown, in a reader's words.
4. The before is what was observed when the problem was found, unless a measured value exists. The after is the value on production after the fix. For a fix confirmed by its deploy, it is what the merged change does.
5. Add no fact the finding and the pull request do not hold.
6. Set `visual: true` and `screen` when something visible on a page changed.

## The story

Two to five short paragraphs of plain prose, in this order:

1. What was wrong. Name the page and give the observed number or quote.
2. Whom it let down. Use the person or agent from the finding, in plain words.
3. What changed. Describe the change in the pull request in plain words; name a file only when it helps.
4. The effect. State the after. For a reopened entry, say plainly what still fails.

Write more detail than the title and lead carry. A reader who wants only the story should understand it without the measures.

Where the finding concerns how an agent reads the site, say what the agent got wrong or could not do. That is the effect that matters most. Use the finding's own account, and add nothing to it.

State no intent and no future work. The story says what is true on production now.

## Rules for every field

1. Sentences under 20 words, active voice, one idea per sentence.
2. British spelling. No em dashes.
3. No disclaimers, caveats or notes on method: no "this was not measured", no "confirmed by", no durations.
4. Never name the system that found, measured or fixed the problem.
5. Leave out the verdict reason, any workflow identifier, any preview hostname and any private path. The strings `verify/`, `finding/`, `vercel.app`, `docs/` and `.claude/` fail the check.
6. Times stay as the script wrote them.
7. Put a path, a tag or a placeholder in backticks, such as `/writing/<slug>.md`. A bare angle-bracket tag in the story breaks the page.
8. Set `updated` to the day of any substantive edit, so the sitemap date moves. A new entry needs none.
9. Before you write a title, read the existing titles. Two entries must not open with the same thing.
