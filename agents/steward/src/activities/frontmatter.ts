import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE_DIR, type Collection } from '../config.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import type { Finding, PassResult, ReviewMode, Verdict } from '../lib/report.js';
import { worstVerdict } from '../lib/report.js';
import { pathState } from '../lib/git.js';
import { timed } from '../lib/logger.js';

const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 300;
const SERP_DESCRIPTION = 155;
const SERP_TITLE = 60;

/**
 * The suffix the page template appends to every entry title:
 * `src/layouts/Layout.astro:63` renders `${seoTitle ?? title} — Matt Pyle`, and
 * neither entry template passes `fullTitle`, so this applies to every entry in
 * the two collections checked here. (That line also exempts the exact string
 * `Matt Pyle`, which is the homepage's title and not reachable from a post.)
 *
 * **Hand-transcribed, like `RULES` below, and with the same failure mode**: if
 * `Layout.astro` changes the suffix, change it here in the same commit or this
 * check silently measures a string the site no longer renders. It is hard-coded
 * rather than derived because deriving it means parsing an Astro template from
 * an activity, and a wrong constant is a visible 12-character error while a
 * template parser is a whole new way for the check to fail.
 *
 * 12 characters, which is why the effective budget for a bare `title` is ~48
 * rather than the 60 `SERP_TITLE` names. `Layout.astro:22` already stated the
 * rule correctly ("~60 chars incl. ` — Matt Pyle`"); this is the code catching
 * up with its own comment.
 */
const TITLE_SUFFIX = ' — Matt Pyle';

/**
 * Per-collection frontmatter shape, transcribed from the **real** Zod schema in
 * `src/content.config.ts` rather than from the spec's summary of it. The two
 * collections are genuinely different and the differences are not cosmetic:
 *
 * | | `writing` | `changelog` |
 * |---|---|---|
 * | dek/meta field | `description` | `summary` |
 * | SERP override | `seoDescription` / `seoTitle` | `seoDescription` / `seoTitle` |
 * | `updated` | optional | **required** |
 * | extra enums | — | `type`, `significance` |
 *
 * The override row used to be the one with teeth: `changelog` had no escape
 * hatch, so advising an author to "add a short `seoDescription`" named a field
 * the schema did not have and would have failed the build. It gained both
 * override fields on 2026-08-07, so the advice is now valid for either
 * collection — but the dek field still differs, and that difference is live.
 *
 * Nothing keeps this transcription in sync with the schema automatically — if
 * `src/content.config.ts` changes a collection's fields, enums, or required
 * flags, update RULES below in the same commit, or Steward will false-block
 * on (or silently allow) a value the schema's own rules have since changed.
 */
interface CollectionRules {
  /** Frontmatter key that drives the dek, OG, and meta description. */
  dekField: 'description' | 'summary';
  /** The `seoDescription`-style override, when the schema has one. */
  dekOverride?: string;
  titleOverride?: string;
  /** Zod-required enum fields — defence-in-depth only (see the Zod-overlap note). */
  enums: { field: string; values: readonly string[] }[];
  /** Whether `updated` is required by the schema. */
  updatedRequired: boolean;
  /**
   * Whether this collection's entry template lets `Layout.astro` append
   * {@link TITLE_SUFFIX}. True for both today, because neither entry page passes
   * `fullTitle` (`src/pages/writing/[slug].astro:33`,
   * `src/pages/changelog/[slug].astro:40`). A collection whose template did pass
   * `fullTitle` would set this false rather than have the check add 12
   * characters that never render.
   */
  rendersTitleSuffix: boolean;
}

const RULES: Record<Collection, CollectionRules> = {
  writing: {
    dekField: 'description',
    dekOverride: 'seoDescription',
    titleOverride: 'seoTitle',
    enums: [],
    updatedRequired: false,
    rendersTitleSuffix: true,
  },
  changelog: {
    dekField: 'summary',
    dekOverride: 'seoDescription',
    titleOverride: 'seoTitle',
    enums: [
      { field: 'type', values: ['launch', 'feature', 'content', 'infra', 'experiment'] },
      { field: 'significance', values: ['major', 'minor', 'patch'] },
    ],
    updatedRequired: true,
    rendersTitleSuffix: true,
  },
};

/** Markdown images, excluding those already inside an HTML tag. `![alt](src)`. */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Line number (1-based) of the first occurrence of `needle` in `full`. */
function lineOf(full: string, index: number): number {
  return full.slice(0, index).split('\n').length;
}

/**
 * Spec §8.4. Deterministic structural checks, no LLM.
 *
 * These agree with `src/content.config.ts` (the real Zod schema) rather than the
 * spec's summary of it: the schema already makes `title`/`date`/`description`
 * hard build failures, so the value added here is the *editorial* layer the
 * schema cannot express — SERP lengths, alt text, heading level, image location.
 */
export async function checkFrontmatter(
  file: string,
  collection: Collection = 'writing',
  mode: ReviewMode = 'gate',
): Promise<PassResult> {
  const rules = RULES[collection];
  const { result, startedAt, durationMs } = await timed('checkFrontmatter', async () => {
    const abs = path.join(SITE_DIR, file);
    const raw = await fs.readFile(abs, 'utf8');
    const parsed = parseFrontmatter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const body = parsed.content;
    // Offset of the body within the raw file, so reported line numbers point at
    // the real line in the file the human will open.
    const bodyOffset = raw.length - body.length;

    const findings: Finding[] = [];
    let n = 0;
    const add = (severity: Verdict, message: string, extra: Partial<Finding> = {}) => {
      n += 1;
      findings.push({ id: `frontmatter-${n}`, pass: 'frontmatter', severity, message, file, ...extra });
    };

    /**
     * The override's value, or `undefined` when the field is absent or blank.
     *
     * A blank override counts as **present**, because `Layout.astro` uses `??`
     * and so renders it: `seoTitle: ""` produces a `<title>` of ` — Matt Pyle`
     * with the post's name gone. Measuring the title instead would print a
     * length for a string the page does not emit, which is the exact failure
     * this whole change exists to remove. It is reported separately below.
     */
    const overrideValue = (field: string | undefined): string | undefined => {
      if (!field) return undefined;
      const value = fm[field];
      return typeof value === 'string' ? value : undefined;
    };
    for (const field of [rules.dekOverride, rules.titleOverride]) {
      const value = overrideValue(field);
      if (value !== undefined && value.trim() === '') {
        add('block', `\`${field}\` is empty. Remove the field or give it a value; an empty override still replaces the string it overrides.`);
      }
    }

    // dek — `description` on writing, `summary` on changelog.
    //
    // The SERP check measures whichever string reaches `<meta name="description">`
    // (`Layout.astro:64`: `seoDescription ?? description`), not always the dek.
    // Before, the mere *presence* of an override suppressed the finding without
    // ever measuring it, so a 200-char `description` "fixed" with a 200-char
    // `seoDescription` passed — and adding the override is exactly what the
    // finding told the author to do.
    const dek = typeof fm[rules.dekField] === 'string' ? (fm[rules.dekField] as string) : '';
    const dekOverrideValue = overrideValue(rules.dekOverride);
    const dekOutOfBounds = dek.length < DESCRIPTION_MIN || dek.length > DESCRIPTION_MAX;
    if (!dek) {
      add(
        'block',
        `Missing \`${rules.dekField}\`. It drives the dek, OG, and the meta description, and the content schema requires it.`,
      );
    } else if (dekOutOfBounds) {
      // The on-page dek's own bounds, independent of any override: this one is
      // rendered as visible page copy whatever the meta description says.
      add(
        'block',
        `\`${rules.dekField}\` is ${dek.length} chars; expected ${DESCRIPTION_MIN}–${DESCRIPTION_MAX}.`,
      );
    }

    // The SERP length, measured on whichever string reaches the meta
    // description. Its own statement rather than another `else if` on the chain
    // above, because a 320-char dek is out of bounds *and* may carry a 250-char
    // override, and the override is the string search results show — chaining it
    // would report the bounds violation and skip the string that renders.
    //
    // The one case that is still suppressed: an out-of-bounds dek with no
    // override, where the block above already says to shorten this exact string
    // and a second finding about it would be the same instruction twice.
    const metaDescription = dekOverrideValue ?? (dek || undefined);
    const dekAlreadySaid = dekOverrideValue === undefined && dekOutOfBounds;
    if (!dekAlreadySaid && metaDescription !== undefined && metaDescription.length > SERP_DESCRIPTION) {
      const field = dekOverrideValue !== undefined ? rules.dekOverride : rules.dekField;
      add(
        'flag',
        dekOverrideValue !== undefined
          ? `\`${field}\` is ${metaDescription.length} chars — over the ~${SERP_DESCRIPTION}-char SERP limit, and it is the string that reaches the meta description. Shorten the override itself.`
          : rules.dekOverride
            ? `\`${field}\` is ${metaDescription.length} chars — over the ~${SERP_DESCRIPTION}-char SERP limit. Add a \`${rules.dekOverride}\` override of ${SERP_DESCRIPTION} chars or fewer.`
            : // No override field exists in this collection's schema, so the only
              // remedy is shortening the field itself. Suggesting an override that
              // the schema would reject would be worse than saying nothing.
              `\`${field}\` is ${metaDescription.length} chars — over the ~${SERP_DESCRIPTION}-char SERP limit. The ${collection} schema has no override field, so shorten it here.`,
      );
    }

    // title
    //
    // Measured as rendered, not as written. `Layout.astro:63` builds the
    // `<title>` from `${seoTitle ?? title}` plus a 12-character suffix (see
    // `TITLE_SUFFIX`), so the budget for a bare `title` is ~48, and a 60-char
    // title Steward used to pass reached the SERP at 72.
    const title = typeof fm.title === 'string' ? fm.title : '';
    const titleOverrideValue = overrideValue(rules.titleOverride);
    const suffix = rules.rendersTitleSuffix ? TITLE_SUFFIX : '';
    /** Budget left for the frontmatter string once the suffix is spent. */
    const titleBudget = SERP_TITLE - suffix.length;
    if (!title) {
      add('block', 'Missing `title`.');
    }
    // Measured outside that `if`, for the same reason the meta-description check
    // stands on its own: with `title` missing the override still renders, and
    // its length is still the one the SERP shows.
    const headTitle = titleOverrideValue ?? (title || undefined);
    const renderedLength = (headTitle?.length ?? 0) + suffix.length;
    if (headTitle !== undefined && renderedLength > SERP_TITLE) {
      const rendered = `${headTitle.length} chars + the ${suffix.length}-char \`${suffix}\` suffix = ${renderedLength} rendered`;
      add(
        'flag',
        titleOverrideValue !== undefined
          ? `\`${rules.titleOverride}\` is ${rendered} — over the ~${SERP_TITLE}-char SERP limit, and it is the string that reaches \`<title>\`. Shorten the override to ${titleBudget} chars or fewer.`
          : rules.titleOverride
            ? `\`title\` is ${rendered} — over the ~${SERP_TITLE}-char SERP limit. Shorten it to ${titleBudget} chars or fewer, or add a \`${rules.titleOverride}\` override that short.`
            : `\`title\` is ${rendered} — over the ~${SERP_TITLE}-char SERP limit. The ${collection} schema has no override field, so shorten it here to ${titleBudget} chars or fewer.`,
      );
    }

    // draft — gate mode only. In audit mode the post is *expected* to be
    // published; blocking on it would make every audit report open with a
    // finding that the thing being audited is the thing we asked for.
    if (mode === 'gate' && fm.draft !== true) {
      add('block', 'Post is not `draft: true`. Steward only reviews drafts in gate mode.');
    }

    // collection-specific enums (Zod-required — defence-in-depth, see above)
    for (const { field, values } of rules.enums) {
      const v = fm[field];
      if (typeof v !== 'string' || !values.includes(v)) {
        add('block', `\`${field}\` must be one of: ${values.join(', ')}.`);
      }
    }

    // dates
    const date = asDate(fm.date);
    if (!date) {
      add('block', 'Missing or invalid `date`.');
    }
    const updated = fm.updated === undefined ? null : asDate(fm.updated);
    if (fm.updated === undefined) {
      if (rules.updatedRequired) {
        add(
          'block',
          `Missing \`updated\`. The ${collection} schema requires it — sitemap lastmod needs an explicit page-content update date.`,
        );
      }
    } else if (!updated) {
      add('block', 'Invalid `updated` date.');
    } else if (date && updated < date) {
      add('block', '`updated` is earlier than `date`.');
    }

    // tags
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    if (tags.length === 0) {
      add('flag', 'No `tags`. Tags feed the writing index and topical grouping.');
    }

    // h1 in body — the page template emits the h1 from `title`
    const h1 = /^#\s+\S/m.exec(body);
    if (h1) {
      add('block', 'Body contains an `# h1`. The page template emits the h1 from `title`; body headings start at `h2`.', {
        line: lineOf(raw, bodyOffset + h1.index),
        excerpt: body.slice(h1.index, h1.index + 200).split('\n')[0],
      });
    }

    // git state of the draft itself — gate mode only.
    //
    // This is a note about the routine, not a defect. Steward reads the draft
    // from the primary checkout but commits it in its own worktree (design rule
    // 3), so an uncommitted draft publishes perfectly well and simply leaves a
    // copy of itself behind afterwards, which then blocks `git pull` until it is
    // removed. Drafts staying out of git is Matt's documented choice, so the
    // note says what happens next rather than asking for a different habit.
    //
    // `pass` severity, deliberately: it must not move the pass's verdict and it
    // must not read in the report as something to fix. In audit mode it is
    // skipped entirely — published content has no twin to reconcile.
    if (mode === 'gate') {
      const state = await pathState(SITE_DIR, file.split(path.sep).join('/'));
      const slug = path.basename(file).replace(/\.md$/, '');
      if (state === 'untracked') {
        add(
          'pass',
          `\`${file}\` is untracked, which is the normal way drafts work here. Publish will ` +
            `work: Steward reads the file from your checkout and commits it in its own ` +
            `worktree. A copy of the draft stays behind in your checkout afterwards. Run ` +
            `\`steward cleanup ${slug}\` once the PR merges to remove it and fast-forward.`,
        );
      } else if (state === 'uncommitted') {
        add(
          'pass',
          `\`${file}\` is tracked with uncommitted changes. Publish will work, since Steward ` +
            `publishes the bytes on disk rather than the committed version, but the local file ` +
            `stays as it is, and \`steward cleanup ${slug}\` refuses to touch a file git is ` +
            `holding a copy of, so reconcile this one with git yourself after the merge.`,
        );
      }
    }

    // images
    for (const m of body.matchAll(IMAGE_RE)) {
      const [full, alt, src] = m;
      const line = lineOf(raw, bodyOffset + (m.index ?? 0));
      if (alt.trim() === '') {
        add('block', `Image \`${src}\` has empty alt text. Alt text conveys the information in the image, not the filename.`, {
          line,
          excerpt: full.slice(0, 200),
        });
      }
      const isRelativeAsset = src.startsWith('.') && src.includes('assets/');
      const isRemote = /^https?:\/\//.test(src);
      if (!isRelativeAsset && !isRemote) {
        add(
          'flag',
          `Image \`${src}\` is not a relative \`src/assets/\` reference. Images in \`public/\` get no optimisation and no intrinsic dimensions, which costs CLS.`,
          { line, excerpt: full.slice(0, 200) },
        );
      }
    }

    return findings;
  });

  return {
    pass: 'frontmatter',
    verdict: worstVerdict(result.map((f) => f.severity)),
    findings: result,
    patches: [],
    startedAt,
    durationMs,
  };
}
