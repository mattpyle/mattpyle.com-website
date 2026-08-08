import { FLOORS } from './audit-map.js';
import type { PassResult, ReviewReport, Verdict } from './report.js';
import { formatTellGroup, groupArchivedCitations } from './tell-citations.js';

/**
 * `steward report <slug>` and the tail of `steward review` (build-log "readable
 * report") — the human-readable render of an archived `ReviewReport`.
 *
 * Pure and side-effect-free: takes a validated report, returns a string. Neither
 * `report` nor `review` duplicate this logic — both call it and `console.log`
 * the result. Terminal-only; no TUI framework, matching spec §10.
 */

/** Exported so other renderers (e.g. `steward study`'s comparison table) share one palette. */
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const RED = '\x1b[31m';
export const AMBER = '\x1b[33m';
export const GREEN = '\x1b[32m';
export const CYAN = '\x1b[36m';

const VERDICT_COLOR: Record<Verdict, string> = { pass: GREEN, flag: AMBER, block: RED };
/** Same bracket shape the CLI's `render()` already used for `status`/`review` — kept, just colourised. */
const BADGE_TEXT: Record<Verdict, string> = { pass: '[ PASS]', flag: '[ FLAG]', block: '[BLOCK]' };
const RANK: Record<Verdict, number> = { block: 2, flag: 1, pass: 0 };

export function paint(text: string, color: string): string {
  return `${color}${text}${RESET}`;
}

function badge(v: Verdict): string {
  return paint(BADGE_TEXT[v], VERDICT_COLOR[v]);
}

function verdictWord(v: Verdict): string {
  return paint(v.toUpperCase(), VERDICT_COLOR[v]);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * `claims_structure` always leads, ahead of every mechanical pass and
 * regardless of its own verdict. It is the one pass whose findings answer the
 * question Matt actually reads this report for — is the *post* good — and
 * burying it behind cspell/vale noise (which usually has far more findings,
 * just cheaper ones) was the specific failure this renderer exists to fix.
 * Everything else sorts worst-verdict-first.
 */
const SECTIONED_PASSES: readonly PassResult['pass'][] = [
  'claims_structure',
  'build_audit',
  // Both halves of the ai-tells taxonomy have their own section below, and both
  // read badly in the generic finding list: the citations because twenty-one of
  // them at three lines each would bury every other check, the composite because
  // it is a metric rather than a finding and has to be rendered with its
  // validation warning attached.
  'tell_citations',
  'ai_tells',
];

function orderOtherPasses(passes: PassResult[]): PassResult[] {
  return passes
    .filter((p) => !SECTIONED_PASSES.includes(p.pass))
    .slice()
    .sort((a, b) => RANK[b.verdict] - RANK[a.verdict]);
}

/**
 * The machine-voice section: deterministic citations by default, the composite
 * only when it was asked for.
 *
 * **The split this renders is the whole point of the section.** The citations
 * are counted in code and name the line they fired on, so a wrong one costs the
 * reader two seconds to disprove. `aiLikenessScore` is a different kind of
 * object: its pre-registered study found it correlates 0.813 with word count and
 * ranked the one human-edited post in the corpus as the most AI-like. It is
 * printed only when `--ai-tells` asked for it, and never without the warning —
 * displayed casually it would anchor the author toward shortening posts to move
 * a number that mostly measured length.
 *
 * Citations render as counts, densities and line numbers rather than as one
 * entry per hit. A post with fifteen triads does not need fifteen paragraphs
 * telling it so; it needs the number and the lines.
 */
function renderMachineVoice(report: ReviewReport): string[] {
  const citations = report.passes.find((p) => p.pass === 'tell_citations');
  const aiTells = report.passes.find((p) => p.pass === 'ai_tells');
  if (!citations && !aiTells) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(
    `  ${BOLD}MACHINE VOICE${RESET} ` +
      `${paint('(deterministic tell citations — counted in code, no API call)', DIM)}`,
  );

  if (!citations) {
    lines.push('      Citations did not run.');
  } else {
    const words = Number(citations.metrics?.words ?? 0);
    const groups = groupArchivedCitations(citations.findings, words);
    if (groups.length === 0) {
      lines.push('      No tells fired.');
    } else {
      for (const group of groups) lines.push(`      ${formatTellGroup(group)}`);
      lines.push('');
      for (const f of citations.findings) {
        lines.push(`      ${paint(`line ${f.line}`, DIM)}  ${f.message}`);
        if (f.excerpt) lines.push(`          "${f.excerpt}"`);
      }
      lines.push('');
      lines.push(
        `      ${paint('Citations only. Style is the author\'s call — nothing here is applied.', DIM)}`,
      );
    }
  }

  if (aiTells) {
    const score = aiTells.metrics?.aiLikenessScore;
    lines.push('');
    lines.push(`  ${BOLD}AI-LIKENESS COMPOSITE${RESET}  ${paint('(--ai-tells)', DIM)}`);
    lines.push(`      aiLikenessScore: ${typeof score === 'number' ? score : '—'} / 100`);
    lines.push(
      `      ${paint('! UNVALIDATED (spec §9.2): this composite failed its pre-registered study —', AMBER)}`,
    );
    lines.push(
      `      ${paint('  r = 0.813 against word count, and it ranked the one human-edited post', AMBER)}`,
    );
    lines.push(
      `      ${paint('  in the corpus as the most AI-like. Not evidence of authorship.', AMBER)}`,
    );
    if (aiTells.findings.length) {
      lines.push('');
      lines.push(`      ${paint('LLM-judged tells:', DIM)}`);
      for (const f of aiTells.findings) {
        lines.push(`      ${badge(f.severity)}  ${f.message}${f.line ? ` (line ${f.line})` : ''}`);
        if (f.excerpt) lines.push(`          "${f.excerpt}"`);
      }
    }
  }

  return lines;
}

function renderPass(pass: PassResult, report: ReviewReport): string[] {
  const lines: string[] = [];
  const count = pass.findings.length;
  lines.push(
    `  ${badge(pass.verdict)} ${pass.pass} — ${count} finding${count === 1 ? '' : 's'} (${pass.durationMs}ms)`,
  );
  if (count === 0) {
    lines.push('      No findings.');
    return lines;
  }

  const sorted = pass.findings.slice().sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  for (const f of sorted) {
    const patch = report.patches.find((p) => p.findingId === f.id);
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    lines.push(
      `      ${badge(f.severity)}${where}  ${f.message}` +
        (patch ? `  ${paint(`(${patch.id})`, DIM)}` : ''),
    );
    if (f.excerpt) lines.push(`          "${f.excerpt}"`);
    if (f.evidence) lines.push(`          why: ${f.evidence.split('\n').join(' / ')}`);
  }
  return lines;
}

function nextHint(report: ReviewReport): string {
  if (report.mode === 'audit') {
    return 'audited — advisory only; findings go through your normal git flow, not `apply`.';
  }
  if (report.human.decision) {
    const when = report.human.decidedAt ? ` on ${formatWhen(report.human.decidedAt)}` : '';
    return `${report.human.decision}${when} — nothing further to do here.`;
  }
  switch (report.overall) {
    case 'block':
      return (
        `block — fix the blocking findings, then \`steward rereview ${report.slug}\`, ` +
        `or \`steward approve ${report.slug} --force\` to override.`
      );
    case 'flag':
      return `flag — \`steward approve ${report.slug}\` when ready.`;
    case 'pass':
      return `pass — \`steward approve ${report.slug}\` when ready.`;
    default: {
      const exhaustive: never = report.overall;
      return String(exhaustive);
    }
  }
}

export function renderReport(report: ReviewReport): string {
  const lines: string[] = [];

  // --- Header -----------------------------------------------------------
  const label = report.collection === 'writing' ? report.slug : `${report.collection}/${report.slug}`;
  const modeTag = report.mode === 'audit' ? `  ${paint('· mode: audit (advisory)', DIM)}` : '';
  lines.push('');
  lines.push(
    `  ${BOLD}${label}${RESET}  ·  ${report.collection}  ·  overall: ${verdictWord(report.overall)}${modeTag}`,
  );
  lines.push(`  reviewed ${formatWhen(report.reviewedAt)}`);
  lines.push('');
  lines.push(`  ${report.summary}`);

  // --- Editorial quality (claims_structure) — the substance --------------
  // Always rendered as its own labelled section, whether or not the pass ran,
  // so its absence is as visible as its findings — see the module docblock.
  const claims = report.passes.find((p) => p.pass === 'claims_structure');
  lines.push('');
  lines.push(
    `  ${BOLD}EDITORIAL QUALITY${RESET} — claims_structure ` +
      `${paint('(overclaiming · buried lede · structure · self-containment)', DIM)}`,
  );
  if (claims) {
    lines.push(...renderPass(claims, report));
  } else {
    lines.push('      Pass did not run.');
  }

  // --- Machine voice (tell_citations, and the composite only if asked for) --
  lines.push(...renderMachineVoice(report));

  // --- Other checks -------------------------------------------------------
  const others = orderOtherPasses(report.passes);
  if (others.length) {
    lines.push('');
    lines.push(`  ${BOLD}OTHER CHECKS${RESET}`);
    for (const pass of others) {
      lines.push(...renderPass(pass, report));
    }
  }

  // --- Proposed patches ----------------------------------------------------
  lines.push('');
  lines.push(`  ${BOLD}PROPOSED PATCHES${RESET} (${report.patches.length})`);
  if (report.patches.length === 0) {
    lines.push('      None.');
  } else {
    for (const p of report.patches) {
      lines.push(`      ${p.id}  "${p.oldText}" -> "${p.newText}"`);
      lines.push(`          ${p.rationale}`);
    }
  }

  // --- Build audit ---------------------------------------------------------
  const build = report.passes.find((p) => p.pass === 'build_audit');
  lines.push('');
  lines.push(`  ${BOLD}BUILD AUDIT${RESET}`);
  if (!build) {
    lines.push('      Skipped (--skip-build-audit, or the pass is gated off).');
  } else {
    const metrics = build.metrics ?? {};
    const axeViolations = Number(metrics.axeViolations ?? 0);
    lines.push(
      `      ${paint(
        `axe: ${axeViolations} violation${axeViolations === 1 ? '' : 's'}`,
        axeViolations === 0 ? GREEN : RED,
      )}`,
    );
    const scores = (metrics.scores ?? {}) as Record<string, number>;
    for (const [key, floor] of Object.entries(FLOORS)) {
      const score = scores[key];
      if (typeof score !== 'number') continue;
      const ok = score >= floor;
      lines.push(`      ${paint(`${key}: ${score}`, ok ? GREEN : AMBER)}  (floor ${floor})`);
    }
    const failedAudits = metrics.failedAudits as string[] | undefined;
    if (failedAudits && failedAudits.length) {
      lines.push(`      failing audits: ${failedAudits.join(', ')}`);
    }
  }

  // --- Next -----------------------------------------------------------------
  lines.push('');
  lines.push(`  next: ${nextHint(report)}`);
  lines.push('');

  return lines.join('\n');
}
