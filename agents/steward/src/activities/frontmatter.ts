import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { SITE_DIR } from '../config.js';
import type { Finding, PassResult, Verdict } from '../lib/report.js';
import { worstVerdict } from '../lib/report.js';
import { timed } from '../lib/logger.js';

const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 300;
const SERP_DESCRIPTION = 155;
const SERP_TITLE = 60;

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
export async function checkFrontmatter(file: string): Promise<PassResult> {
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

    // description
    const description = typeof fm.description === 'string' ? fm.description : '';
    if (!description) {
      add('block', 'Missing `description`. It drives the dek, OG, and RSS, and the content schema requires it.');
    } else if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
      add(
        'block',
        `\`description\` is ${description.length} chars; expected ${DESCRIPTION_MIN}–${DESCRIPTION_MAX}.`,
      );
    } else if (description.length > SERP_DESCRIPTION && typeof fm.seoDescription !== 'string') {
      add(
        'flag',
        `\`description\` is ${description.length} chars — over the ~${SERP_DESCRIPTION}-char SERP limit. Add a short \`seoDescription\` override.`,
      );
    }

    // title
    const title = typeof fm.title === 'string' ? fm.title : '';
    if (!title) {
      add('block', 'Missing `title`.');
    } else if (title.length > SERP_TITLE && typeof fm.seoTitle !== 'string') {
      add(
        'flag',
        `\`title\` is ${title.length} chars — over the ~${SERP_TITLE}-char SERP limit. Add a short \`seoTitle\` override.`,
      );
    }

    // draft
    if (fm.draft !== true) {
      add('block', 'Post is not `draft: true`. The Steward only reviews drafts.');
    }

    // dates
    const date = asDate(fm.date);
    if (!date) {
      add('block', 'Missing or invalid `date`.');
    }
    const updated = fm.updated === undefined ? null : asDate(fm.updated);
    if (fm.updated !== undefined && !updated) {
      add('block', 'Invalid `updated` date.');
    } else if (date && updated && updated < date) {
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
