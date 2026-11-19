/**
 * What the model sees from a tool, as zod schemas. Shared by the workflow (the tool declarations)
 * and the worker (the activities that fill them), so it imports nothing with side effects.
 *
 * Every string in these shapes is an enum, a check id that matched an allow-list pattern, or an
 * origin this package built from the caller's own input. No string from the audited site's pages
 * or headers fits any of them: `src/project.ts` is the only producer, and it drops what does not.
 */
import { z } from 'zod';

export const CATEGORIES = ['crawlability', 'discovery', 'content-access', 'rendered-experience'] as const;
export const SEVERITIES = ['high', 'medium', 'low'] as const;
export const STATUSES = ['pass', 'fail', 'not-applicable', 'error'] as const;
export const DECISION_CLASSES = ['provenBlocker', 'bestPractice', 'conditional', 'emergingConvention'] as const;
export const METRIC_UNITS = ['score', 'count', 'ratio'] as const;

/** A check id: the audit's own identifier, never site text. Anything else is dropped. */
export const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** An origin this package normalised: scheme, a host of DNS characters, an optional port. */
export const ORIGIN = /^https?:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/;

const count = z.number().int().nonnegative();

export const CheckView = z.object({
  id: z.string().regex(CHECK_ID),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  decisionClass: z.enum(DECISION_CLASSES).optional(),
  status: z.enum(STATUSES),
  metric: z
    .object({
      value: z.number(),
      unit: z.enum(METRIC_UNITS),
      outOf: z.number().optional(),
      pages: count.optional(),
    })
    .optional(),
});
export type CheckView = z.infer<typeof CheckView>;

export const AuditView = z.object({
  status: z.literal('complete'),
  tier: z.enum(['fast', 'deep']),
  origin: z.string().regex(ORIGIN),
  durationMs: count,
  requests: count,
  browserPages: count.optional(),
  integrity: z.enum(['clean', 'degraded']).optional(),
  categories: z.array(
    z.object({
      category: z.enum(CATEGORIES),
      passed: count,
      applicable: count,
      notApplicable: count,
      errors: count,
    }),
  ),
  decisionClasses: z.partialRecord(z.enum(DECISION_CLASSES), count).optional(),
  checks: z.array(CheckView),
  /** Checks left out because a field failed the allow-list. Normally 0. */
  dropped: count,
});
export type AuditView = z.infer<typeof AuditView>;

export const REFUSAL_REASONS = [
  'invalid_url',
  'rate_limited',
  'error',
  'deep_audit_failed',
  'cap:tool_calls',
  'cap:deep_audits',
  'session_ended',
] as const;
export const Refusal = z.object({
  status: z.literal('refused'),
  reason: z.enum(REFUSAL_REASONS),
});
export type Refusal = z.infer<typeof Refusal>;

export const ToolResult = z.union([AuditView, Refusal]);
export type ToolResult = z.infer<typeof ToolResult>;

export const UrlInput = z.object({
  url: z
    .string()
    .min(1)
    .max(300)
    .describe('The site to audit, such as https://example.com or example.com. The path is ignored.'),
});
export type UrlInput = z.infer<typeof UrlInput>;

/**
 * The site's published facts, for questions about mattpyle.com. The text here is the site owner's
 * own published copy, read from the site's public content index. `src/project.ts` copies named
 * fields only, and caps every length and every list.
 */
export const SITE_TOPICS = ['overview', 'writing', 'projects', 'changelog'] as const;
/** The most entries one list topic returns, newest first. `total` says how many exist. */
export const SITE_FACTS_MAX_ENTRIES = 12;
/** The longest text field, in characters. Longer text is cut. */
export const SITE_FACTS_MAX_TEXT = 400;

const factText = z.string().max(SITE_FACTS_MAX_TEXT);
const factUrl = z.string().max(300).regex(/^https:\/\/\S+$/);
const Named = z.object({ name: factText, url: factUrl, summary: factText });

export const SiteOverview = z.object({
  status: z.literal('complete'),
  topic: z.literal('overview'),
  site: z.object({
    name: factText,
    url: factUrl,
    description: factText,
    person: z.object({ name: factText, jobTitle: factText, worksFor: factText }).optional(),
  }),
  sections: z.array(Named).max(SITE_FACTS_MAX_ENTRIES),
  pages: z.array(Named).max(SITE_FACTS_MAX_ENTRIES),
});

export const SiteList = z.object({
  status: z.literal('complete'),
  topic: z.enum(['writing', 'projects', 'changelog']),
  /** How many entries the site publishes under this topic. `entries` holds the newest. */
  total: count,
  entries: z
    .array(
      z.object({
        title: factText,
        url: factUrl,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        description: factText,
        tags: z.array(z.string().max(40)).max(8),
        /** A project's status or a changelog entry's type. */
        kind: z.string().max(40).optional(),
      }),
    )
    .max(SITE_FACTS_MAX_ENTRIES),
});

export const SiteFacts = z.union([SiteOverview, SiteList]);
export type SiteFacts = z.infer<typeof SiteFacts>;
export const SiteFactsResult = z.union([SiteOverview, SiteList, Refusal]);
export type SiteFactsResult = z.infer<typeof SiteFactsResult>;

export const SiteFactsInput = z.object({
  topic: z
    .enum(SITE_TOPICS)
    .describe(
      'overview: who the site belongs to, its sections and pages. writing, projects or changelog: the newest entries of that kind.',
    ),
});
export type SiteFactsInput = z.infer<typeof SiteFactsInput>;

/**
 * The site's published fix log, searched by audit check. The text is the site owner's own published
 * copy, read from `/fix-log.md`. `src/fix-log.ts` is the only producer: it copies a title and a
 * lead, cuts both, and builds each address itself from `FIX_LOG_ORIGIN` and a slug that fits
 * `FIX_LOG_SLUG`.
 */
export const FIX_LOG_ORIGIN = 'https://www.mattpyle.com';
/** A fix-log entry's URL segment, as the site's content schema defines it, with a length bound. */
export const FIX_LOG_SLUG = /^(?=.{1,160}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The most checks one call searches for. */
export const FIX_LOG_MAX_CHECKS = 5;
/** The most entries one check returns. `matched` says how many the log holds. */
export const FIX_LOG_MAX_ENTRIES = 3;
/** The longest title or lead, in characters. Longer text is cut. */
export const FIX_LOG_MAX_TEXT = 400;

const fixText = z.string().max(FIX_LOG_MAX_TEXT);

export const FixLogView = z.object({
  status: z.literal('complete'),
  /** How many entries the fix log holds. */
  total: count,
  results: z
    .array(
      z.object({
        check: z.string().regex(CHECK_ID),
        /** How many entries matched this check. `entries` holds the closest. */
        matched: count,
        entries: z
          .array(
            z.object({
              title: fixText.min(1),
              url: z.string().max(200).regex(/^https:\/\/www\.mattpyle\.com\/fix-log\/[a-z0-9-]+\/$/),
              lead: fixText,
              /**
               * named: the entry's title or lead names the thing the check tests.
               * related: it is about the same area, and no closer.
               */
              match: z.enum(['named', 'related']),
            }),
          )
          .max(FIX_LOG_MAX_ENTRIES),
      }),
    )
    .max(FIX_LOG_MAX_CHECKS),
});
export type FixLogView = z.infer<typeof FixLogView>;

/** The fix log could not be read, or was not the fix log. The turn goes on without it. */
export const FixLogUnavailable = z.object({
  status: z.literal('unavailable'),
  reason: z.literal('fix_log_unavailable'),
});
export type FixLogUnavailable = z.infer<typeof FixLogUnavailable>;
export const FIX_LOG_UNAVAILABLE: FixLogUnavailable = { status: 'unavailable', reason: 'fix_log_unavailable' };

export const FixLogResult = z.union([FixLogView, FixLogUnavailable, Refusal]);
export type FixLogResult = z.infer<typeof FixLogResult>;

export const FixLogInput = z.object({
  checks: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(FIX_LOG_MAX_CHECKS)
    .describe('The ids of failed checks, exactly as an audit result gives them, such as llms-txt. At most five.'),
});
export type FixLogInput = z.infer<typeof FixLogInput>;

export function refused(reason: Refusal['reason']): Refusal {
  return { status: 'refused', reason };
}
