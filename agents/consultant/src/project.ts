/**
 * The projection from a public audit report to what the model sees. Pure, and the only producer of
 * an `AuditView`.
 *
 * It copies by allow-list: numbers, enum values, and check ids that match `CHECK_ID`. It never
 * copies a free-text field (`observed`, `title`, `fix`, `notes`, `evidence`, `target.input`, the
 * markdown summary), because those carry what the audited site served, and a site can write
 * instructions to a model there. A check with any field outside the allow-list is dropped whole and
 * counted in `dropped`, so a malformed report degrades to fewer checks, never to site text.
 */
import {
  AuditView,
  CATEGORIES,
  CHECK_ID,
  DECISION_CLASSES,
  METRIC_UNITS,
  ORIGIN,
  SEVERITIES,
  STATUSES,
  type CheckView,
} from './tools.js';

type Unknown = Record<string, unknown>;

const isObject = (v: unknown): v is Unknown => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v);

/**
 * The origin the caller asked about, built from the caller's input by this package: lower-case
 * scheme and host, optional port, nothing else. Null when the input is not an http(s) URL with a
 * plain DNS host.
 */
export function normaliseOrigin(input: string): string | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const origin = url.origin.toLowerCase();
  return ORIGIN.test(origin) ? origin : null;
}

function projectCheck(raw: unknown): CheckView | null {
  if (!isObject(raw)) return null;
  const { id, category, severity, decisionClass, status, metric } = raw;
  if (typeof id !== 'string' || !CHECK_ID.test(id)) return null;
  if (!oneOf(CATEGORIES, category) || !oneOf(SEVERITIES, severity) || !oneOf(STATUSES, status)) return null;
  const view: CheckView = { id, category, severity, status };
  if (decisionClass !== undefined) {
    if (!oneOf(DECISION_CLASSES, decisionClass)) return null;
    view.decisionClass = decisionClass;
  }
  if (metric !== undefined) {
    if (!isObject(metric) || !isFinite(metric.value) || !oneOf(METRIC_UNITS, metric.unit)) return null;
    view.metric = { value: metric.value, unit: metric.unit };
    if (isFinite(metric.outOf)) view.metric.outOf = metric.outOf;
    if (isCount(metric.pages)) view.metric.pages = metric.pages;
  }
  return view;
}

/**
 * Project a report. `origin` is the caller's own normalised origin, not the report's `target`.
 * Throws only if the result fails its own schema, which would be a bug here.
 */
export function projectReport(report: unknown, tier: 'fast' | 'deep', origin: string): AuditView {
  const doc: Unknown = isObject(report) ? report : {};
  const rawChecks = Array.isArray(doc.checks) ? doc.checks : [];
  const checks: CheckView[] = [];
  for (const raw of rawChecks) {
    const view = projectCheck(raw);
    if (view) checks.push(view);
  }

  const categories = (Array.isArray(doc.categories) ? doc.categories : []).flatMap((c) =>
    isObject(c) &&
    oneOf(CATEGORIES, c.category) &&
    isCount(c.passed) &&
    isCount(c.applicable) &&
    isCount(c.notApplicable) &&
    isCount(c.errors)
      ? [
          {
            category: c.category,
            passed: c.passed,
            applicable: c.applicable,
            notApplicable: c.notApplicable,
            errors: c.errors,
          },
        ]
      : [],
  );

  const view: AuditView = {
    status: 'complete',
    tier,
    origin,
    durationMs: isCount(doc.durationMs) ? doc.durationMs : 0,
    requests: isCount(doc.requests) ? doc.requests : 0,
    categories,
    checks,
    dropped: rawChecks.length - checks.length,
  };
  if (isCount(doc.browserPages)) view.browserPages = doc.browserPages;
  if (isObject(doc.integrity) && (doc.integrity.status === 'clean' || doc.integrity.status === 'degraded')) {
    view.integrity = doc.integrity.status;
  }
  if (isObject(doc.decisionClasses)) {
    const counts: Partial<Record<(typeof DECISION_CLASSES)[number], number>> = {};
    for (const key of DECISION_CLASSES) {
      const n = doc.decisionClasses[key];
      if (isCount(n)) counts[key] = n;
    }
    view.decisionClasses = counts;
  }
  return AuditView.parse(view);
}
