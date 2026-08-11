import { rankedFixes, type AuditResult, type CheckEvidence, type CheckResult } from './result.js';

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

function renderEvidence(evidence: CheckEvidence[]): string[] {
  const lines: string[] = [];
  for (const ev of evidence) {
    const head = [
      ev.url ? `\`${ev.url}\`` : null,
      ev.status !== undefined ? `→ ${ev.status}` : null,
      ...Object.entries(ev.headers ?? {}).map(([k, v]) => `\`${k}: ${v}\``),
    ]
      .filter(Boolean)
      .join(' ');
    if (head) lines.push(`- ${head}`);
    if (ev.note) lines.push(`${head ? '  - ' : '- '}${ev.note}`);
    if (ev.excerpt) lines.push(`${head ? '  - ' : '- '}> ${ev.excerpt}`);
  }
  return lines;
}

export function renderMarkdownSummary(audit: AuditResult): string {
  const out: string[] = [];
  const host = new URL(audit.target.origin).host;

  out.push(`# Agent-readiness audit: ${host}`);
  out.push('');
  out.push(`- **Target:** ${audit.target.origin} (given as \`${audit.target.input}\`)`);
  out.push(`- **Run:** ${audit.startedAt}`);
  out.push(
    `- **Tool:** ${audit.tool.name} ${audit.tool.version}, result schema v${audit.schemaVersion}`,
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
      `| ${CATEGORY_LABEL[row.category] ?? row.category} | ${row.passed} | ${row.applicable} | ${row.notApplicable} | ${row.errors} |`,
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
        `### ${i + 1}. ${check.title} — ${check.severity} (${CATEGORY_LABEL[check.category] ?? check.category})`,
      );
      out.push('');
      out.push(`**What was found:** ${check.observed}`);
      out.push('');
      if (check.fix) {
        out.push(`**Fix:** ${check.fix}`);
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
    out.push(`- ${STATUS_MARK[check.status]} **${check.title}** (\`${check.id}\`) — ${check.observed}`);
  }
  out.push('');

  if (audit.notes.length > 0) {
    out.push('## Notes on the run');
    out.push('');
    for (const note of audit.notes) out.push(`- ${note}`);
    out.push('');
  }

  return out.join('\n');
}
