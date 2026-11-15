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

export function refused(reason: Refusal['reason']): Refusal {
  return { status: 'refused', reason };
}
