import matter from 'gray-matter';
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.js';

/**
 * Steward's copy of the fix log's entry rules: the facts an entry holds, the schema it
 * must pass, and the rules of `agents/steward/briefs/fix-log.md` that code can check.
 *
 * WHY A COPY. The hosted worker's image holds only `agents/steward/`, so it cannot import
 * the site's `fixes` schema in `src/content.config.ts` or `scripts/fix-log-entries.mjs`.
 * CI on the site is the real check of an entry; this copy lets Steward refuse a bad draft
 * before it commits one. `tests/lib/fix-log-rules.test.ts` fails when the copy and the
 * site disagree: the forbidden strings, the schema's fields and which are optional, and
 * every real entry, which must pass this copy.
 *
 * WHAT IS A RULE. Only what the brief states as a rule is a hard check. Its aims, such as
 * a title of 40 to 65 characters, go in the prompt, and the check holds only a generous
 * bound. Facts written by Steward (the checks' expected and measured text) quote the site
 * and are exempt from the prose rules.
 *
 * Pure: no network, no environment, no side effect at import.
 */

/** Strings an entry must never hold. Equal to `FORBIDDEN` in `scripts/fix-log-entries.mjs`. */
export const FIX_LOG_FORBIDDEN: readonly string[] = ['verify/', 'finding/', 'vercel.app', 'docs/', '.claude/'];

/** The slug pattern of the site's schema. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The brief: a slug under 71 characters. */
export const SLUG_MAX = 70;
/** A generous bound on the title. The brief's aim of 40 to 65 characters is in the prompt. */
export const TITLE_MAX = 90;
/** The brief: a lead under 25 words. */
export const LEAD_MAX_WORDS = 24;

export const ENTRIES_PATH = 'src/content/fixes';
export const entryFile = (key: string): string => `${key.toLowerCase()}.md`;
export const entryPath = (key: string): string => `${ENTRIES_PATH}/${entryFile(key)}`;

/**
 * The slug the brief derives from a title: lower case, words joined by hyphens. An
 * apostrophe joins its word ("site's" gives `sites`); every other run of characters that
 * is not a letter or a digit is one hyphen. It reproduces 75 of the 78 entries of
 * 2026-11-27; the other three were set by hand and stay as they are.
 */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── The schema: the `fixes` collection of src/content.config.ts ──────────────

const lines = z.object({
  kind: z.literal('lines'),
  label: z.string(),
  lines: z.array(z.object({ text: z.string(), mark: z.enum(['added', 'removed']).optional() })).min(1),
});
const specimen = z.discriminatedUnion('kind', [
  lines,
  z.object({ kind: z.literal('spoken'), label: z.string(), words: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('missing'), label: z.string(), text: z.string() }),
]);

export const measureSchema = z.object({
  label: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1),
  quoted: z.boolean().default(false),
  sides: z.tuple([z.string(), z.string()]).optional(),
});

export const textPairSchema = z.object({ before: specimen, after: specimen });

export const checkSchema = z.object({
  passed: z.boolean(),
  method: z.enum(['text', 'js', 'selector', 'markdown', 'header']),
  urls: z.array(z.string()).min(1),
  viewport: z.string().optional(),
  expected: z.string(),
  measured: z.string(),
  before: z.string().optional(),
});

/** The fields of an entry, as the site's schema declares them. The test compares the two. */
export const fixEntryShape = {
  key: z.string().regex(/^MP-\d+$/),
  title: z.string().min(1),
  slug: z.string().regex(SLUG_PATTERN),
  lead: z.string().min(1),
  type: z.enum(['seo', 'agent-readiness', 'content', 'ux', 'accessibility', 'feature']),
  kind: z.enum(['defect', 'opportunity']),
  status: z.enum(['fixed', 'reopened']),
  confirmedBy: z.enum(['check', 'deploy']),
  where: z.string().min(1),
  visual: z.boolean(),
  screen: z.enum(['phone', 'desktop']).optional(),
  found: z.coerce.date(),
  approved: z.coerce.date(),
  verified: z.coerce.date().optional(),
  updated: z.coerce.date().optional(),
  changes: z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        opened: z.coerce.date(),
        merged: z.coerce.date().optional(),
      }),
    )
    .min(1),
  measures: z.array(measureSchema).length(1).optional(),
  text: textPairSchema.optional(),
  checks: z.array(checkSchema).default([]),
};

export const fixEntrySchema = z
  .object(fixEntryShape)
  .refine((entry) => Boolean(entry.measures) !== Boolean(entry.text), {
    message: 'An entry shows its before and after once: hold measures or changed text, not both and not neither.',
  });

// ── The facts: a port of readFinding and entryText in scripts/fix-log-entries.mjs ──

const ORIGIN = 'https://www.mattpyle.com';

export interface FixCheck {
  passed: boolean;
  method: string;
  urls: string[];
  viewport?: string;
  expected: string;
  measured: string;
  before?: string;
}

/** What Steward knows of a fix from its finding, before the pull request. */
export interface FindingFacts {
  key: string;
  type: string;
  kind: string;
  status: 'fixed' | 'reopened';
  confirmedBy: 'check' | 'deploy';
  where: string;
  pr: number;
  found: string | undefined;
  approved: string | null;
  /** Null until production confirmed the fix. */
  verified: string | null;
  checks: FixCheck[];
  /** The finding's status as filed: `resolved` and `reopened` are the launch set. */
  findingStatus: string;
}

export interface FixPullRequest {
  number: number;
  title: string;
  opened: string;
  /** Null before the merge. */
  merged: string | null;
}

function section(body: string, name: string): string {
  const parts = body.split(/^## /m).filter((p) => p.startsWith(`${name}\n`));
  return parts.length ? parts[parts.length - 1].slice(name.length + 1) : '';
}

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v.replace(/T(\d{2})(\d{2})Z$/, 'T$1:$2:00Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const CHECK_LINE =
  /^\d+\. (Pass|Fail), `(\w+)` on (?:\d+ URLs \(([^)]*)\)|(\S+?))(?: at (\d+x\d+))?\. Expected: ([\s\S]*)\. Measured: ([\s\S]*?)\.?$/;

const unquote = (s: string): string =>
  s.replace(/"((?:[^"\\]|\\.)*)"/g, (m, inner: string) => (inner.includes('\\"') ? '`' + inner.replace(/\\"/g, '"') + '`' : m));

function sitePath(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  return u.origin === ORIGIN ? `${u.pathname}${u.search}${u.hash}` : url;
}

function parseChecks(text: string): FixCheck[] {
  const out: FixCheck[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(CHECK_LINE);
    if (!m) continue;
    out.push({
      passed: m[1] === 'Pass',
      method: m[2],
      urls: (m[3] ? m[3].split(', ') : [m[4]]).map(sitePath),
      ...(m[5] ? { viewport: m[5] } : {}),
      expected: unquote(m[6]),
      measured: unquote(m[7]),
    });
  }
  return out;
}

const VERIFIED_LINE =
  /^Steward (?:ran this finding's checks against production|confirmed this finding's fix by its deploy) at (\S+?)\. Outcome: (\w+)\./m;

/**
 * The facts of one finding file, or null when it has no fix pull request. Unlike the
 * site's script it answers for any status, with `findingStatus` set, so the caller
 * decides; the backfill keeps the launch set, `resolved` and `reopened`.
 */
export function findingFacts(text: string): FindingFacts | null {
  const { data: fm, content: body } = parseFrontmatter(text.replace(/\r\n/g, '\n')) as {
    data: Record<string, any>;
    content: string;
  };
  const prUrl = fm.links?.pr;
  if (!prUrl || typeof fm.key_short !== 'string') return null;

  const verification = section(body, 'Verification');
  const verified = verification.match(VERIFIED_LINE);
  const checks = parseChecks(verification);
  const before = parseChecks(section(body, 'Measured at the verdict'));
  for (const c of checks) {
    const b = before.find((x) => x.urls.join() === c.urls.join() && x.expected === c.expected);
    if (b) c.before = b.measured;
  }
  const firstVerifyUrl = Array.isArray(fm.verify) ? [fm.verify[0]?.url].flat()[0] : undefined;
  const happenedUrl = section(body, 'What happened').match(/https?:\/\/[^\s,)`]+/)?.[0];
  const confirmed = verified !== null && ['resolved', 'reopened'].includes(fm.status);

  return {
    key: fm.key_short,
    type: fm.type,
    kind: fm.kind,
    status: fm.status === 'reopened' ? 'reopened' : 'fixed',
    confirmedBy: fm.resolved_by === 'deploy' || verified?.[2] === 'confirmed' ? 'deploy' : 'check',
    where: sitePath(firstVerifyUrl ?? happenedUrl ?? ORIGIN),
    pr: Number(String(prUrl).split('/').pop()),
    found: typeof fm.first_seen === 'string' ? fm.first_seen : iso(fm.first_seen)?.slice(0, 10),
    approved: iso(fm.verdict_at),
    verified: confirmed ? iso(verified[1]) : null,
    checks: confirmed ? checks : [],
    findingStatus: String(fm.status ?? ''),
  };
}

/** The text fields a writer, person or model, supplies. Steward derives the slug. */
export interface EntryWriting {
  title: string;
  lead: string;
  visual: boolean;
  screen?: 'phone' | 'desktop';
  measures?: Array<{ label: string; before: string; after: string; quoted?: boolean; sides?: [string, string] }>;
  text?: { before: unknown; after: unknown };
  story: string;
}

/** The facts and the writing joined, in the site script's key order. */
export function entryData(facts: FindingFacts, pr: FixPullRequest, writing: EntryWriting): Record<string, unknown> {
  return {
    key: facts.key,
    title: writing.title,
    slug: slugFromTitle(writing.title),
    lead: writing.lead,
    type: facts.type,
    kind: facts.kind,
    status: facts.status,
    confirmedBy: facts.confirmedBy,
    where: facts.where,
    visual: writing.visual,
    ...(writing.screen ? { screen: writing.screen } : {}),
    found: facts.found,
    approved: facts.approved,
    ...(facts.verified ? { verified: facts.verified } : {}),
    changes: [
      { number: pr.number, title: pr.title, opened: pr.opened, ...(pr.merged ? { merged: pr.merged } : {}) },
    ],
    ...(writing.measures ? { measures: writing.measures } : {}),
    ...(writing.text ? { text: writing.text } : {}),
    checks: facts.checks,
  };
}

/** The entry file: YAML frontmatter, then the story. No line folding, so every key stays on one line. */
export function entryFileText(data: Record<string, unknown>, story: string): string {
  return matter.stringify(`\n${story.trim()}\n`, data, { lineWidth: -1 } as never);
}

// ── The checks ──────────────────────────────────────────────────────────────

export interface Taken {
  titles: readonly string[];
  slugs: readonly string[];
}

/** One failed rule: a stable name and the reason, as the correction turn sends it. */
export interface RuleFailure {
  rule: string;
  reason: string;
}

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const OCCURRENCE_LABEL = /\b(occurrences?|copies|instances|count) of\b/i;

/** Every prose string a writer supplied, for the dash and forbidden-string rules. */
function writtenStrings(data: Record<string, any>, story: string): string[] {
  const out = [String(data.title ?? ''), String(data.lead ?? ''), story];
  for (const m of data.measures ?? []) out.push(m.label, m.before, m.after, ...(m.sides ?? []));
  const collect = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(data.text);
  return out;
}

/**
 * The checks of one entry file against the schema and the brief's rules. Empty means it
 * passes. `taken` holds the titles and slugs of every other entry; `newEntry` adds the
 * checks that hold only for an entry Steward writes, such as the slug it derives.
 */
export function checkEntry(fileText: string, taken: Taken, options: { newEntry?: boolean } = {}): RuleFailure[] {
  const failures: RuleFailure[] = [];
  const fail = (rule: string, reason: string): void => {
    failures.push({ rule, reason });
  };
  let data: Record<string, any>;
  let story: string;
  try {
    const parsed = parseFrontmatter(fileText.replace(/\r\n/g, '\n'));
    data = parsed.data as Record<string, any>;
    story = parsed.content;
  } catch (err) {
    return [{ rule: 'frontmatter', reason: `the frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}` }];
  }

  const schema = fixEntrySchema.safeParse(data);
  if (!schema.success) {
    for (const issue of schema.error.issues) fail('schema', `${issue.path.join('.') || '(entry)'}: ${issue.message}`);
  }

  for (const s of FIX_LOG_FORBIDDEN) if (fileText.includes(s)) fail('forbidden', `the entry holds "${s}", which the brief forbids`);

  const title = String(data.title ?? '');
  if (title.length > TITLE_MAX) fail('title-length', `the title is ${title.length} characters; keep it to 40 to 65`);
  if (/[:?]/.test(title)) fail('title-form', 'the title is a plain statement: no question and no colon-joined halves');
  const sameTitle = taken.titles.find((t) => t.trim().toLowerCase() === title.trim().toLowerCase());
  if (sameTitle) fail('title-taken', `another entry already has the title "${sameTitle}"; write a different title`);

  const slug = String(data.slug ?? '');
  if (slug.length > SLUG_MAX) fail('slug-length', `the title makes a slug of ${slug.length} characters, over ${SLUG_MAX}; shorten the title`);
  if (taken.slugs.includes(slug)) fail('slug-taken', `the title makes the slug "${slug}", which another entry holds; write a different title`);
  if (options.newEntry && slug !== slugFromTitle(title)) fail('slug-derived', `the slug must be "${slugFromTitle(title)}", derived from the title`);

  const lead = String(data.lead ?? '');
  if (words(lead) > LEAD_MAX_WORDS) fail('lead-length', `the lead is ${words(lead)} words; keep it under 25`);
  if (/[.!?]\s+\S/.test(lead.trim())) fail('lead-sentences', 'the lead is one sentence');

  if (writtenStrings(data, story).some((s) => s.includes('—'))) fail('em-dash', 'the writing holds an em dash; use a comma, colon or parentheses');

  if (!story.trim()) fail('story', 'the story is empty; write two to five short paragraphs');
  const prose = story.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const tag = prose.match(/<[A-Za-z/!][^>\n]*>?/);
  if (tag) fail('story-tag', `the story holds ${tag[0]} outside backticks; put paths, tags and placeholders in backticks`);

  const measures = Array.isArray(data.measures) ? data.measures : [];
  if (measures.length > 1) fail('one-measure', 'the entry holds more than one measure; choose the one a reader cares about most');
  if (measures.length > 0 && data.text) fail('one-form', 'the entry holds both measures and changed text; hold one');
  if (measures.length === 0 && !data.text) fail('one-form', 'the entry holds neither measures nor changed text; hold one');
  for (const m of measures) {
    if (OCCURRENCE_LABEL.test(String(m?.label ?? ''))) fail('measure-label', `"${m.label}" counts occurrences; use words or changed lines`);
  }
  return failures;
}
