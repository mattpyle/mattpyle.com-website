/**
 * Two findings in Argus's template, for the fixer's tests: an approved defect
 * with a cause in the source, hard-wrapped the way Argus writes, and an
 * approved opportunity with neither a cause nor a `kind` the fixer takes.
 */

export const DEFECT_KEY = 'content-perfect-score-labelled-fail--scorecard';

export const DEFECT_FINDING = [
  '---',
  `key: ${DEFECT_KEY}`,
  'status: approved',
  'kind: defect',
  'scenario: defect-hunt',
  'type: content',
  'priority: low',
  'confidence: high',
  'source: argus',
  'first_seen: 2026-09-28',
  'last_seen: 2026-09-28',
  'last_run: 2026-09-28T0730Z',
  'verdict_reason: "Approved by Matt via steward finding approve."',
  'verdict_at: 2026-10-11T06:26:32.301Z',
  'verdict_source: cli',
  'resolved_run:',
  'references: []',
  '---',
  '',
  '# /scorecard\'s run history says "Accessibility: 100/100 (Fail)", a perfect score labelled as a failure',
  '',
  '## Who wanted what',
  '',
  "`defect-hunt`: a visitor reading the scorecard's history to see how the site has held up.",
  '',
  '## What happened',
  '',
  '- URL: https://www.mattpyle.com/scorecard/ ("Previous runs", 03 Sept 2026 row)',
  '- Viewport and appearance: desktop 1280×800, modern',
  '- What they did: read the row for the 03 Sept run.',
  '- What happened: the row reads "Accessibility: 100/100 (Fail)." The reason it failed is not on',
  '  the page. It is in `/scorecard.json`: `description: "1 axe violation across 25 tested pages."`',
  '- Expected: the row names what failed, e.g. "Accessibility: 1 axe violation (Fail)".',
  '- Cause, from the source: `agents/steward/src/workflows/scorecard-audit.ts` line 558,',
  '  `buildCommentary()` formats every non-passing gate as `${m.name}: ${m.value}/${m.maximum}',
  '  (${m.status})` and never uses `m.description`.',
  '- Artifact: row `outerHTML` `.run-note` = "Accessibility: 100/100 (Fail)."',
  '',
  '## What would serve them',
  '',
  "Build the commentary for a failing gate from the gate's `description`. Past rows are archived",
  'text. Leave them alone.',
  '',
  '## Why it matters',
  '',
  'The scorecard exists to be believed.',
  '',
  '## How to measure',
  '',
  'A future run whose gate fails on axe violations shows the violation count in its row, not "100/100',
  '(Fail)". Checkable in a unit test of `buildCommentary`.',
  '',
  '## References',
  '',
].join('\n');

export const OPPORTUNITY_KEY = 'ux-feed-link-opens-raw-xml--writing';

export const OPPORTUNITY_FINDING = [
  '---',
  `key: ${OPPORTUNITY_KEY}`,
  'status: approved',
  'kind: opportunity',
  'scenario: would-be-subscriber',
  'type: ux',
  'links:',
  '  comment: https://example.com/c/1',
  '---',
  '',
  '# Every "rss" link sends a would-be subscriber to a raw XML tree',
  '',
  '## Who wanted what',
  '',
  '`would-be-subscriber`: a reader who wants to follow the site.',
  '',
  '## What happened',
  '',
  '- URL: https://www.mattpyle.com/writing/',
  '- What they did: clicked "rss".',
  '- What happened: the browser showed an XML tree with no word on what a feed is.',
  '',
  '## What would serve them',
  '',
  'A styled feed, or one line that says what to do with the link.',
  '',
  '## How to measure',
  '',
  'The feed URL renders a page a person can read: `curl -s https://www.mattpyle.com/rss.xml` names a stylesheet.',
  '',
].join('\n');

/** The PR a fixer run opened for the defect. */
export const FIX_PR = 'https://github.com/mattpyle/mattpyle.com-website/pull/312';

/** The defect once `writeFindingFix` has marked it: `fixing`, with the PR link. */
export const FIXING_FINDING = DEFECT_FINDING.replace('status: approved', 'status: fixing').replace(
  'references: []',
  ['references: []', 'links:', `  pr: ${FIX_PR}`].join('\n'),
);

/** The production origin the fixtures' handoffs are validated against. */
export const ORIGIN = 'https://www.mattpyle.com';

/**
 * A handoff the generator's template asks for, as a model would return it. Its
 * verify list is empty: the finding's measure is a unit test.
 */
export const DEFECT_HANDOFF = [
  '---',
  'verify: []',
  '---',
  '',
  '# Handoff: Name the failing reason in scorecard commentary',
  '',
  `Finding: \`${DEFECT_KEY}\``,
  '',
  '## Goal',
  '',
  'A visitor reading the run history sees why a gate failed.',
  '',
  '## What happened',
  '',
  'The 03 Sept row on https://www.mattpyle.com/scorecard/ reads "Accessibility: 100/100 (Fail)."',
  '',
  '## Cause',
  '',
  '`buildCommentary()` in `agents/steward/src/workflows/scorecard-audit.ts` never uses `m.description`.',
  '',
  '## Cases',
  '',
  '- A gate that fails on axe violations: its score, then the violation count from `description`.',
  '- A Performance gate under its floor: its score, unchanged.',
  '',
  '## Tasks',
  '',
  '1. Build the commentary for a failing gate from its `description`.',
  '2. Add a unit test of `buildCommentary`.',
  '',
  '## Verify',
  '',
  '1. A unit test of `buildCommentary` shows the violation count for a gate that fails on axe violations.',
  '   Run `npm test -w @mattpyle/steward`.',
  '2. `npx tsc --noEmit -p agents/steward` is clean.',
  '',
  '## Out of scope',
  '',
  'Archived rows. Merging and deploying.',
  '',
].join('\n');

/**
 * The handoff as the generator now writes it: the same, with the coverage map
 * beside its empty block. The scorecard page is the one surface the finding
 * names, and a unit test is no check. `DEFECT_HANDOFF` stands for a handoff
 * written before the map.
 */
export const MAPPED_HANDOFF = DEFECT_HANDOFF.replace(
  'verify: []\n',
  [
    'verify: []',
    'verify_coverage:',
    '  - surface: https://www.mattpyle.com/scorecard/',
    '    reason: The measure is a unit test of buildCommentary, which no check on the live site runs.',
    '',
  ].join('\n'),
);
