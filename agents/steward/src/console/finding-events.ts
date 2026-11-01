import type { ParsedVerification } from '../lib/findings.js';

/**
 * A finding's dated history, read from what the file and the run hold. An
 * event exists only when its source does: a finding with no verdict has no
 * verdict event, and nothing is a placeholder.
 */

export interface FindingEvent {
  kind: 'first-seen' | 'seen' | 'recheck' | 'verdict' | 'pr' | 'verification' | 'resolved';
  /** ISO 8601, or a bare day for `first_seen`. Null for the PR: Steward stores no date for it. */
  at: string | null;
  label: string;
  url?: string;
  detail?: string;
  /** A verification event's run; the page links it to the Temporal Web UI. */
  workflowId?: string;
}

export interface EventSources {
  data: Record<string, unknown>;
  body: string;
  status: string;
  prUrl: string | null;
  verification: ParsedVerification | null;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** `2026-10-03T0642Z` (a run id) as `2026-10-03T06:42:00Z`; any other string is returned as it is. */
export function runIdToIso(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z$/.exec(value);
  return m ? `${m[1]}T${m[2]}:${m[3]}:00Z` : value;
}

function day(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

/** The `## Re-check <run id>` sections: when, and the outcome line if the section has one. */
function rechecks(body: string): FindingEvent[] {
  const lines = body.split(/\r?\n/);
  const events: FindingEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s+Re-check\s+(\S+)\s*$/.exec(lines[i]);
    if (!heading) continue;
    let outcome: string | null = null;
    for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j++) {
      const m = /^-\s+Outcome:\s*(.+?)\s*$/.exec(lines[j]);
      if (m) outcome = m[1];
    }
    events.push({
      kind: 'recheck',
      at: runIdToIso(heading[1]),
      label: 'Re-checked',
      ...(outcome ? { detail: outcome } : {}),
    });
  }
  return events;
}

const VERIFICATION_LABEL: Record<string, string> = {
  resolved: 'Verified on production',
  reopened: 'Reopened by verification',
  confirmed: 'Confirmed by its deploy',
};

export function buildEvents(src: EventSources): FindingEvent[] {
  const { data } = src;
  const events: FindingEvent[] = [];

  const firstSeen = day(text(data.first_seen));
  if (firstSeen) events.push({ kind: 'first-seen', at: firstSeen, label: 'First seen by Argus' });

  const lastRun = text(data.last_run);
  const lastSeen = day(text(data.last_seen));
  const seenAt = lastRun ? runIdToIso(lastRun) : lastSeen;
  if (seenAt && lastSeen && lastSeen !== firstSeen) events.push({ kind: 'seen', at: seenAt, label: 'Seen again' });

  events.push(...rechecks(src.body));

  const verdictAt = text(data.verdict_at);
  if (verdictAt) {
    const source = text(data.verdict_source);
    const reason = text(data.verdict_reason);
    const detail = [reason, source ? `via ${source}` : null].filter(Boolean).join(' ');
    events.push({
      kind: 'verdict',
      at: verdictAt,
      label: src.status === 'rejected' ? 'Rejected' : 'Approved',
      ...(detail ? { detail } : {}),
    });
  }

  if (src.prUrl) events.push({ kind: 'pr', at: null, label: 'PR opened', url: src.prUrl });

  const v = src.verification;
  if (v) {
    const passed = v.checks.filter((c) => c.pass).length;
    events.push({
      kind: 'verification',
      at: v.at,
      label: VERIFICATION_LABEL[v.outcome] ?? 'Verified',
      ...(v.checks.length > 0 ? { detail: `${passed} of ${v.checks.length} checks passed` } : {}),
      ...(v.workflowId ? { workflowId: v.workflowId } : {}),
    });
  }

  const resolvedRun = text(data.resolved_run);
  if (resolvedRun) events.push({ kind: 'resolved', at: runIdToIso(resolvedRun), label: 'Resolved' });

  // Oldest first. An undated event (the PR) keeps its place after the event before it.
  let previous = '';
  const keyed = events.map((event, index) => {
    const key = event.at ?? previous;
    previous = key;
    return { event, key, index };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  return keyed.map((k) => k.event);
}
