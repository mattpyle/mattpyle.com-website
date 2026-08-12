import {
  rankedFixes,
  stripControlChars,
  type AuditResult,
  type CheckEvidence,
  type CheckResult,
} from './result.js';

/**
 * The markdown summary — the second of the report's three renderings (the JSON
 * itself is the first; the interactive HTML file is a later slice).
 *
 * A pure function of the canonical result and nothing else. That is the point
 * of the schema: if this renderer ever needs a fact the JSON does not carry,
 * the JSON is wrong, not this file.
 *
 * Written to be pasted into a chat window and read once: what was audited,
 * how many checks passed per category, then the failures as a ranked list of
 * things to go and do, each carrying the evidence it was decided on. **No
 * composite score** — per-category counts only, by the card's decision.
 *
 * **Every value out of the audit goes through `safe()` on the way out.** Most
 * of them are, at some remove, text the audited site chose: a title, a header
 * value, a quoted body. `excerpt()` already strips control characters as the
 * evidence is built, and this is the second layer, covering the strings that
 * never passed through it — `observed` lines with a page title interpolated
 * into them, raw header values, an id from a future check. The output of this
 * function lands in a terminal, so an unstripped `ESC [` in it is a site
 * deciding what the operator's screen says.
 */

const STATUS_MARK: Record<CheckResult['status'], string> = {
  pass: '✅',
  fail: '❌',
  'not-applicable': '➖',
  error: '⚠️',
};

const CATEGORY_LABEL: Record<string, string> = {
  crawlability: 'Crawlability',
  discovery: 'Discovery',
  'content-access': 'Content access',
};

/** Anything interpolated into the output passes through here. See the docblock. */
function safe(value: string): string {
  return stripControlChars(value);
}

function renderEvidence(evidence: CheckEvidence[]): string[] {
  const lines: string[] = [];
  for (const ev of evidence) {
    const head = [
      ev.url ? `\`${safe(ev.url)}\`` : null,
      ev.status !== undefined ? `→ ${ev.status}` : null,
      ...Object.entries(ev.headers ?? {}).map(([k, v]) => `\`${safe(k)}: ${safe(v)}\``),
    ]
      .filter(Boolean)
      .join(' ');
    if (head) lines.push(`- ${head}`);
    if (ev.note) lines.push(`${head ? '  - ' : '- '}${safe(ev.note)}`);
    if (ev.excerpt) lines.push(`${head ? '  - ' : '- '}> ${safe(ev.excerpt)}`);
  }
  return lines;
}

export function renderMarkdownSummary(audit: AuditResult): string {
  const out: string[] = [];
  const host = new URL(audit.target.origin).host;

  out.push(`# Agent-readiness audit: ${safe(host)}`);
  out.push('');
  out.push(`- **Target:** ${safe(audit.target.origin)} (given as \`${safe(audit.target.input)}\`)`);
  out.push(`- **Run:** ${safe(audit.startedAt)}`);
  out.push(
    `- **Tool:** ${safe(audit.tool.name)} ${safe(audit.tool.version)}, result schema v${audit.schemaVersion}`,
  );
  out.push(
    `- **Cost:** ${audit.requests} HTTP request(s) in ${(audit.durationMs / 1000).toFixed(1)}s`,
  );
  out.push('');

  out.push('## Checks passed');
  out.push('');
  out.push('| Category | Passed | Checked | Not applicable | Errors |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const row of audit.categories) {
    out.push(
      `| ${CATEGORY_LABEL[row.category] ?? safe(row.category)} | ${row.passed} | ${row.applicable} | ${row.notApplicable} | ${row.errors} |`,
    );
  }
  out.push('');
  out.push('Per-category counts, deliberately not rolled into one number.');
  out.push('');

  const fixes = rankedFixes(audit.checks);
  out.push('## Fixes, most important first');
  out.push('');
  if (fixes.length === 0) {
    out.push('Nothing failed. Every applicable check passed.');
    out.push('');
  } else {
    fixes.forEach((check, i) => {
      out.push(
        `### ${i + 1}. ${safe(check.title)} — ${check.severity} (${CATEGORY_LABEL[check.category] ?? safe(check.category)})`,
      );
      out.push('');
      out.push(`**What was found:** ${safe(check.observed)}`);
      out.push('');
      if (check.fix) {
        out.push(`**Fix:** ${safe(check.fix)}`);
        out.push('');
      }
      const evidence = renderEvidence(check.evidence);
      if (evidence.length > 0) {
        out.push('**Evidence:**');
        out.push('');
        out.push(...evidence);
        out.push('');
      }
    });
  }

  out.push('## Every check');
  out.push('');
  for (const check of audit.checks) {
    out.push(
      `- ${STATUS_MARK[check.status]} **${safe(check.title)}** (\`${safe(check.id)}\`) — ${safe(check.observed)}`,
    );
  }
  out.push('');

  if (audit.notes.length > 0) {
    out.push('## Notes on the run');
    out.push('');
    for (const note of audit.notes) out.push(`- ${safe(note)}`);
    out.push('');
  }

  return out.join('\n');
}
