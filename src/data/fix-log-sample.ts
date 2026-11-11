/**
 * Eight real fix-log entries, hand-made for the design mocks under /fix-log/mocks/.
 *
 * MOCK DATA, NOT THE LOG. The full log comes from a pipeline in a later build. These
 * eight were chosen to cover the cases a design has to handle: a fix measured on
 * production, one confirmed by its deploy, a slow one, one of each finding type, and
 * one the loop got wrong (MP-48, still reopened).
 *
 * Every value is copied from the finding, its fix pull request, or the card that tells
 * its story. Times are UTC instants; pages show them in America/Vancouver.
 *
 * What an entry deliberately leaves out: verdict reasons, workflow identifiers and the
 * name of the system that saw or measured each side.
 */

export type FindingType = 'seo' | 'agent-readiness' | 'content' | 'ux' | 'accessibility' | 'feature';
export type FindingKind = 'defect' | 'opportunity';

/** The thing itself, shown as it was or as it is. */
export type Specimen =
  | { kind: 'figure'; value: string; caption: string }
  | { kind: 'lines'; label: string; lines: { text: string; mark?: 'added' | 'removed' }[] }
  | { kind: 'spoken'; label: string; words: string[] }
  | { kind: 'missing'; label: string; text: string };

/**
 * A check a visitor's browser can run again, on this site's own origin.
 * `needle` may hold the literal ORIGIN, replaced at run time by the origin the page
 * is served from: the site writes its own origin into llms.txt, so on a preview the
 * production string would never match.
 */
export type LiveCheck =
  | { kind: 'count'; paths: string[]; needle: string; equals: number }
  | { kind: 'contains'; paths: string[]; needles: string[] }
  | { kind: 'selector'; paths: string[]; test: 'post-links-onward' };

export interface FixEntry {
  key: string;
  title: string;
  type: FindingType;
  kind: FindingKind;
  /** `fixed`, or `reopened` when the check on production still failed. */
  status: 'fixed' | 'reopened';
  /** How the after was confirmed. */
  confirmedBy: 'check' | 'deploy';
  /** Who was let down, in plain words. */
  who: string;
  before: { text: string; specimen: Specimen };
  after: { text: string; specimen: Specimen };
  pr: { number: number; title: string };
  /** A later pull request that finished or repaired the work, if any. */
  followUp?: { number: number; title: string; text: string };
  /** The URL a reader can open to see the fix. */
  where: string;
  /** Whether something visible changed, so a screenshot pair belongs here later. */
  visual: boolean;
  times: { found: string; approved: string; prOpened: string; merged: string; verified: string };
  live?: LiveCheck;
  /**
   * The before and after a reader takes in at a glance: a number pair where the
   * fix has one, otherwise the shortest true quote. `label` names what is counted.
   */
  glance: { label: string; before: string; after: string; quoted?: boolean };
  /** What was done and why, in two or three plain sentences. No annotation. */
  story: string;
  /** For a visual fix, the screen it is about: sets the screenshot shape. */
  screen?: 'phone' | 'desktop';
  /** Whether the fix is told as an article of its own. */
  article?: boolean;
  /** The fix as a plain claim a reader can hold the site to. */
  claim: string;
  /** For a check a browser cannot run. */
  liveNote?: string;
}

const PR_BASE = 'https://github.com/mattpyle/mattpyle.com-website/pull/';
export const prUrl = (n: number) => `${PR_BASE}${n}`;

export const FIX_ENTRIES: FixEntry[] = [
  {
    key: 'MP-144',
    story: 'The guides this site writes for AI agents said the homepage holds a bio. It has none: the bio is on the About page. An agent asked about Matt for a recruiter was sent to the wrong page first, so the line now describes the homepage as it is.',
    glance: { label: 'what llms.txt says the homepage holds', before: 'a bio', after: 'name, tagline, latest work', quoted: true },
    claim: 'llms.txt does not call the homepage a bio.',
    title: 'Agent guides said the homepage holds a bio',
    type: 'agent-readiness',
    kind: 'defect',
    status: 'fixed',
    confirmedBy: 'check',
    who: 'An agent asked to summarise Matt for a recruiter',
    before: {
      text: 'llms.txt described the homepage as “bio, tagline, recent activity feed”. The homepage has no bio; it is on /about.',
      specimen: {
        kind: 'lines',
        label: 'llms.txt',
        lines: [{ text: '- [Home](/): bio, tagline, recent activity feed.', mark: 'removed' }],
      },
    },
    after: {
      text: 'The line now names what the homepage shows. “bio, tagline” occurs 0 times in llms.txt and in the WebMCP index.',
      specimen: {
        kind: 'lines',
        label: 'llms.txt',
        lines: [{ text: '- [Home](/): name, tagline, and the latest writing, projects, scorecard and changelog.', mark: 'added' }],
      },
    },
    pr: { number: 671, title: 'llms.txt: describe the homepage as it is' },
    where: '/llms.txt',
    visual: false,
    times: {
      found: '2026-11-10T07:30:00Z',
      approved: '2026-11-11T05:50:06Z',
      prOpened: '2026-11-11T05:52:01Z',
      merged: '2026-11-11T06:10:02Z',
      verified: '2026-11-11T06:13:07Z',
    },
    live: { kind: 'count', paths: ['/llms.txt'], needle: 'bio, tagline', equals: 0 },
  },
  {
    key: 'MP-136',
    story: 'An agent asked to follow Matt’s writing starts at llms.txt, the index this site points agents to. It listed fifteen resources and neither RSS feed. Now it lists both.',
    glance: { label: 'RSS feeds listed in llms.txt', before: '0', after: '2' },
    claim: 'llms.txt lists both RSS feeds.',
    title: 'llms.txt listed no RSS feed',
    type: 'agent-readiness',
    kind: 'opportunity',
    status: 'fixed',
    confirmedBy: 'check',
    who: 'An agent asked to “follow Matt’s writing” for a reader',
    before: {
      text: 'The agent index listed 15 machine-readable resources and neither feed. “rss.xml” occurred 0 times, though every HTML page advertises one.',
      specimen: {
        kind: 'lines',
        label: 'llms.txt',
        lines: [
          { text: '- [Scorecard data](/scorecard.json): …' },
          { text: '- [Activity data](/activity.json): …' },
        ],
      },
    },
    after: {
      text: 'Both feeds are listed. Each feed URL occurs once.',
      specimen: {
        kind: 'lines',
        label: 'llms.txt',
        lines: [
          { text: '- [Scorecard data](/scorecard.json): …' },
          { text: '- [Activity data](/activity.json): …' },
          { text: '- [Writing feed](/rss.xml): RSS feed of the writing, for subscribing to new posts.', mark: 'added' },
          { text: '- [Changelog feed](/changelog/rss.xml): RSS feed of the changelog, for following what ships on this site.', mark: 'added' },
        ],
      },
    },
    pr: { number: 653, title: 'llms.txt: list the writing and changelog RSS feeds' },
    where: '/llms.txt',
    visual: false,
    times: {
      found: '2026-11-06T07:30:00Z',
      approved: '2026-11-11T03:45:45Z',
      prOpened: '2026-11-11T03:47:37Z',
      merged: '2026-11-11T04:36:25Z',
      verified: '2026-11-11T04:38:47Z',
    },
    live: { kind: 'contains', paths: ['/llms.txt'], needles: ['ORIGIN/rss.xml', 'ORIGIN/changelog/rss.xml'] },
  },
  {
    key: 'MP-46',
    story: 'The site invites developers to reuse its code, but the repository had no licence, so nobody could legally copy it. The code is now MIT licensed. The writing stays all rights reserved.',
    glance: { label: 'licence on the code', before: 'none', after: 'MIT' },
    claim: 'The repository’s code is MIT licensed.',
    title: 'The public repository had no licence',
    type: 'content',
    kind: 'opportunity',
    status: 'fixed',
    confirmedBy: 'deploy',
    who: 'A developer who wanted to copy the site’s audit code',
    before: {
      text: 'The site invites developers to reuse its code, but the repository had no licence, so nobody could legally copy it.',
      specimen: { kind: 'lines', label: 'GitHub API', lines: [{ text: '"license": null', mark: 'removed' }] },
    },
    after: {
      text: 'The code is MIT licensed. The writing stays all rights reserved. Confirmed when the deploy that carries the licence went live.',
      specimen: { kind: 'lines', label: 'LICENSE', lines: [{ text: 'MIT License', mark: 'added' }] },
    },
    pr: { number: 658, title: 'Add MIT LICENSE for the repository code' },
    where: 'https://github.com/mattpyle/mattpyle.com-website',
    visual: false,
    times: {
      found: '2026-10-06T07:30:00Z',
      approved: '2026-11-11T03:54:31Z',
      prOpened: '2026-11-11T03:55:58Z',
      merged: '2026-11-11T04:39:21Z',
      verified: '2026-11-11T04:41:50Z',
    },
    liveNote: 'The licence lives in the repository, not on this site, so your browser cannot check it from here. It was confirmed by the deploy that carries it.',
  },
  {
    key: 'MP-130',
    story: 'The slash before each link in the header is decoration, but screen readers read it aloud, on every page. It is still shown, and no longer spoken.',
    glance: { label: 'what a screen reader says', before: 'slash writing', after: 'writing', quoted: true },
    claim: 'The navigation is not read aloud as “slash writing”, on three pages.',
    title: 'Screen readers heard “slash writing” on every page',
    type: 'accessibility',
    kind: 'opportunity',
    status: 'fixed',
    confirmedBy: 'check',
    who: 'A screen-reader user moving through the main navigation',
    before: {
      text: 'Every header link’s name started with a slash, so the navigation was read aloud as “slash writing, slash projects” on every page.',
      specimen: { kind: 'spoken', label: 'screen reader', words: ['slash writing', 'slash projects', 'slash changelog', 'slash scorecard', 'slash about'] },
    },
    after: {
      text: 'The slash is still shown and no longer read. The old link text is gone from 3 of 3 pages checked.',
      specimen: { kind: 'spoken', label: 'screen reader', words: ['writing', 'projects', 'changelog', 'scorecard', 'about'] },
    },
    pr: { number: 656, title: 'Hide the decorative nav slash from accessible names' },
    where: '/',
    visual: false,
    times: {
      found: '2026-11-04T07:30:00Z',
      approved: '2026-11-11T03:47:11Z',
      prOpened: '2026-11-11T03:49:54Z',
      merged: '2026-11-11T04:22:43Z',
      verified: '2026-11-11T04:26:12Z',
    },
    live: { kind: 'count', paths: ['/', '/writing/', '/about/'], needle: '>/writing<', equals: 0 },
  },
  {
    key: 'MP-107',
    story: 'The changelog page filters entries by type. The feed carried no types, so a feed reader could not do the same. Every item in the feed now carries its type.',
    glance: { label: 'launch tags in the changelog feed', before: '0', after: '3' },
    claim: 'The changelog feed carries each entry’s type.',
    title: 'The changelog feed carried no entry type',
    type: 'feature',
    kind: 'opportunity',
    status: 'fixed',
    confirmedBy: 'check',
    who: 'A subscriber who wants launches, not every infrastructure tweak',
    before: {
      text: 'The page filters the changelog by type, but the feed carried 0 categories, so a feed reader had nothing to filter on.',
      specimen: {
        kind: 'lines',
        label: 'changelog/rss.xml',
        lines: [{ text: '<item>' }, { text: '  <title>…</title>' }, { text: '  <pubDate>…</pubDate>' }, { text: '</item>' }],
      },
    },
    after: {
      text: 'Every item carries its type. The feed has 3 launch categories, one per launch on the page.',
      specimen: {
        kind: 'lines',
        label: 'changelog/rss.xml',
        lines: [
          { text: '<item>' },
          { text: '  <title>…</title>' },
          { text: '  <pubDate>…</pubDate>' },
          { text: '  <category>launch</category>', mark: 'added' },
          { text: '</item>' },
        ],
      },
    },
    pr: { number: 662, title: 'changelog feed: carry each entry’s type as a category' },
    where: '/changelog/rss.xml',
    visual: false,
    times: {
      found: '2026-10-29T07:30:00Z',
      approved: '2026-11-11T03:46:37Z',
      prOpened: '2026-11-11T04:07:09Z',
      merged: '2026-11-11T04:23:09Z',
      verified: '2026-11-11T04:25:18Z',
    },
    live: { kind: 'contains', paths: ['/changelog/rss.xml'], needles: ['<category>launch</category>'] },
  },
  {
    key: 'MP-109',
    story: 'Three links in the WebMCP post pointed at /webmcp without its trailing slash, so each click went through a redirect. They now point straight at the page.',
    glance: { label: 'links that go through a redirect', before: '3', after: '0' },
    claim: 'The WebMCP post has no link that goes through a redirect.',
    title: 'The WebMCP post linked through a redirect',
    type: 'seo',
    kind: 'defect',
    status: 'fixed',
    confirmedBy: 'check',
    who: 'A reader clicking from the post to the live tools',
    before: {
      text: 'Three links in the WebMCP post pointed at /webmcp without its trailing slash, so each click went through a 308 redirect.',
      specimen: { kind: 'figure', value: '3', caption: 'links to href="/webmcp"' },
    },
    after: {
      text: 'All three links carry the slash. The post’s HTML has 0 links to the redirecting address.',
      specimen: { kind: 'figure', value: '0', caption: 'links to href="/webmcp"' },
    },
    pr: { number: 651, title: 'writing: link /webmcp/ with its trailing slash in the WebMCP post' },
    where: '/writing/how-to-implement-webmcp-on-a-website/',
    visual: false,
    times: {
      found: '2026-10-29T07:30:00Z',
      approved: '2026-11-11T03:44:51Z',
      prOpened: '2026-11-11T03:46:40Z',
      merged: '2026-11-11T03:59:27Z',
      verified: '2026-11-11T04:02:41Z',
    },
    live: { kind: 'count', paths: ['/writing/how-to-implement-webmcp-on-a-website/'], needle: 'href="/webmcp"', equals: 0 },
  },
  {
    key: 'MP-48',
    story: 'On a phone, a post opened with nearly two screens of links and buttons before its first sentence.',
    glance: { label: 'posts that start on the first phone screen', before: '0 of 3', after: '1 of 3' },
    article: true,
    screen: 'phone',
    claim: 'A post starts on the first screen of a phone.',
    title: 'On a phone, a post started two screens down',
    type: 'ux',
    kind: 'opportunity',
    status: 'reopened',
    confirmedBy: 'check',
    who: 'A newcomer who opened a shared post on a phone',
    before: {
      text: 'On a 390px phone the first sentence of a post started 1,214 to 1,594px down, below the contents list and five action buttons.',
      specimen: { kind: 'figure', value: '1,594px', caption: 'to the first sentence, WebMCP post' },
    },
    after: {
      text: 'The fix collapsed the contents list. One post of three now starts on the first screen; two still do not, so the finding is open again. Collapsing the list after the page drew also made it jump, which a second pull request removed.',
      specimen: { kind: 'figure', value: '1 of 3', caption: 'posts start on the first screen' },
    },
    pr: { number: 572, title: 'Post rail: collapse contents and lay actions in a row on phones' },
    followUp: {
      number: 641,
      title: 'Post rail: contents list is served in its phone state, so nothing shifts on load',
      text: 'The collapse ran after first paint and moved the page: 0.107 to 0.147 layout shift on a slow phone. Served closed, 15 of 18 test loads read 0.0000 and the worst read 0.0083. The phone layout of a post is now being designed properly.',
    },
    where: '/writing/how-to-implement-webmcp-on-a-website/',
    visual: true,
    times: {
      found: '2026-10-08T07:30:00Z',
      approved: '2026-11-03T03:43:56Z',
      prOpened: '2026-11-07T04:55:50Z',
      merged: '2026-11-07T05:26:53Z',
      verified: '2026-11-07T05:31:49Z',
    },
    liveNote: 'This check measures where the first sentence sits on a 390px phone screen, so it cannot run inside this page. It still fails on two posts.',
  },
  {
    key: 'MP-31',
    story: 'Posts linked only to the next older post, so the oldest one ended with nowhere to go. Every post now ends with a newer and an older link.',
    glance: { label: 'links onward from the oldest post', before: '0', after: '1' },
    screen: 'desktop',
    claim: 'The oldest post ends with a link to another post.',
    title: 'The oldest post was a dead end',
    type: 'ux',
    kind: 'opportunity',
    status: 'fixed',
    confirmedBy: 'check',
    who: 'A first-time visitor who finished a post and wanted another',
    before: {
      text: 'Posts linked only to the next older post, so the oldest one ended on its last paragraph with no link to anything else to read.',
      specimen: { kind: 'missing', label: 'after the last paragraph', text: 'nothing, then the footer' },
    },
    after: {
      text: 'Every post ends with a newer and an older link where they exist. The oldest post now points to a newer one.',
      specimen: { kind: 'lines', label: 'after the last paragraph', lines: [{ text: 'newer · 18 Jul 2026  Hello, World! Or, this post is a lie.', mark: 'added' }] },
    },
    pr: { number: 567, title: 'Writing posts end with a newer/older pair' },
    where: '/writing/accessibility-and-ai/',
    visual: true,
    times: {
      found: '2026-09-30T07:30:00Z',
      approved: '2026-10-13T03:32:18Z',
      prOpened: '2026-11-07T03:41:47Z',
      merged: '2026-11-07T04:15:02Z',
      verified: '2026-11-07T04:18:37Z',
    },
    live: { kind: 'selector', paths: ['/writing/accessibility-and-ai/'], test: 'post-links-onward' },
  },
];

// ── Shared formatting ─────────────────────────────────────────────────────

const ZONE = 'America/Vancouver';
/** `DD MMM YYYY` from parts: en-GB alone writes September as Sept. */
function siteDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric', timeZone }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}`;
}
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONE });

/** `10 Nov 2026`, in Matt's zone. */
export const fixDate = (iso: string) => siteDay(iso, ZONE);
/** The day a finding was filed: its own UTC date, since the inspector runs at 07:30 UTC. */
export const foundDate = (e: FixEntry) => siteDay(e.times.found, 'UTC');
/** `19:44`, in Matt's zone. */
export const fixTime = (iso: string) => timeFmt.format(new Date(iso));

export const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;

/** `18 minutes`, `2 hours`, `25 days`. Rounded to the unit a reader thinks in. */
export function formatSpan(minutes: number): string {
  if (minutes < 90) { const m = Math.max(1, Math.round(minutes)); return `${m} ${m === 1 ? 'minute' : 'minutes'}`; }
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Approval to verified, the loop's own time. */
export const fixSpan = (e: FixEntry) => minutesBetween(e.times.approved, e.times.verified);

export const TYPE_LABEL: Record<FindingType, string> = {
  seo: 'search',
  'agent-readiness': 'agent readiness',
  content: 'content',
  ux: 'usability',
  accessibility: 'accessibility',
  feature: 'feature',
};

/** Newest verified first. */
export const ENTRIES_NEWEST = [...FIX_ENTRIES].sort((a, b) => Date.parse(b.times.verified) - Date.parse(a.times.verified));

export function medianSpan(entries: FixEntry[]): number {
  const spans = entries.map(fixSpan).sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  return spans.length % 2 ? spans[mid] : (spans[mid - 1] + spans[mid]) / 2;
}


/** The one place a page says how entries are made. */
export const HOW_MADE =
  'Each fix was found by an automated inspector, approved by Matt, made by an automated fixer and checked on the live site.';
