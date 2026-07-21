import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { SITE_DIR, type Collection } from '../config.js';
import type { Finding, PassResult, ReviewMode, Verdict } from '../lib/report.js';
import { worstVerdict } from '../lib/report.js';
import { timed } from '../lib/logger.js';

const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 300;
const SERP_DESCRIPTION = 155;
const SERP_TITLE = 60;

/**
 * Per-collection frontmatter shape, transcribed from the **real** Zod schema in
 * `src/content.config.ts` rather than from the spec's summary of it. The two
 * collections are genuinely different and the differences are not cosmetic:
 *
 * | | `writing` | `changelog` |
 * |---|---|---|
 * | dek/meta field | `description` | `summary` |
 * | SERP override | `seoDescription` / `seoTitle` | **none — no escape hatch exists** |
 * | `updated` | optional | **required** |
 * | extra enums | — | `type`, `significance` |
 *
 * The `seoDescription` row is the one with teeth. Telling a changelog author to
 * "add a short `seoDescription`" would be advice for a field the schema does not
 * have, and following it would fail the build.
 *
 * Nothing keeps this transcription in sync with the schema automatically — if
 * `src/content.config.ts` changes a collection's fields, enums, or required
 * flags, update RULES below in the same commit, or the Steward will false-block
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
}

const RULES: Record<Collection, CollectionRules> = {
  writing: {
    dekField: 'description',
    dekOverride: 'seoDescription',
    titleOverride: 'seoTitle',
    enums: [],
    updatedRequired: false,
  },
  changelog: {
    dekField: 'summary',
    enums: [
      { field: 'type', values: ['launch', 'feature', 'content', 'infra', 'experiment'] },
      { field: 'significance', values: ['major', 'minor', 'patch'] },
    ],
    updatedRequired: true,
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
    const parsed = matter(raw);
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

    // dek — `description` on writing, `summary` on changelog
    const dek = typeof fm[rules.dekField] === 'string' ? (fm[rules.dekField] as string) : '';
    if (!dek) {
      add(
        'block',
        `Missing \`${rules.dekField}\`. It drives the dek, OG, and the meta description, and the content schema requires it.`,
      );
    } else if (dek.length < DESCRIPTION_MIN || dek.length > DESCRIPTION_MAX) {
      add(
        'block',
        `\`${rules.dekField}\` is ${dek.length} chars; expected ${DESCRIPTION_MIN}–${DESCRIPTION_MAX}.`,
      );
    } else if (
      dek.length > SERP_DESCRIPTION &&
      !(rules.dekOverride && typeof fm[rules.dekOverride] === 'string')
    ) {
      add(
        'flag',
        rules.dekOverride
          ? `\`${rules.dekField}\` is ${dek.length} chars — over the ~${SERP_DESCRIPTION}-char SERP limit. Add a short \`${rules.dekOverride}\` override.`
          : // No override field exists in this collection's schema, so the only
            // remedy is shortening the field itself. Suggesting an override that
            // the schema would reject would be worse than saying nothing.
            `\`${rules.dekField}\` is ${dek.length} chars — over the ~${SERP_DESCRIPTION}-char SERP limit. The ${collection} schema has no override field, so shorten it here.`,
      );
    }

    // title
    const title = typeof fm.title === 'string' ? fm.title : '';
    if (!title) {
      add('block', 'Missing `title`.');
    } else if (
      title.length > SERP_TITLE &&
      !(rules.titleOverride && typeof fm[rules.titleOverride] === 'string')
    ) {
      add(
        'flag',
        rules.titleOverride
          ? `\`title\` is ${title.length} chars — over the ~${SERP_TITLE}-char SERP limit. Add a short \`${rules.titleOverride}\` override.`
          : `\`title\` is ${title.length} chars — over the ~${SERP_TITLE}-char SERP limit. The ${collection} schema has no override field, so shorten it here.`,
      );
    }

    // draft — gate mode only. In audit mode the post is *expected* to be
    // published; blocking on it would make every audit report open with a
    // finding that the thing being audited is the thing we asked for.
    if (mode === 'gate' && fm.draft !== true) {
      add('block', 'Post is not `draft: true`. The Steward only reviews drafts in gate mode.');
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
