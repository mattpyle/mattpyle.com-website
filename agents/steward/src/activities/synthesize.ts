import {
  MECHANICAL_PASSES,
  worstVerdict,
  verdictRank,
  type DraftSnapshot,
  type PassResult,
  type PatchProposal,
  type ReviewReport,
  type Verdict,
} from '../lib/report.js';
import { timed } from '../lib/logger.js';

export interface SynthesizeInput {
  snapshot: DraftSnapshot;
  passes: PassResult[];
  workflowId: string;
  runId: string;
}

/**
 * Design rule 1, enforced in code rather than trusted to a prompt: only
 * mechanical passes may emit `block`. Anything else is clamped to `flag`.
 */
function clampSeverities(passes: PassResult[]): PassResult[] {
  return passes.map((p) => {
    if (MECHANICAL_PASSES.includes(p.pass)) return p;
    const findings = p.findings.map((f) =>
      f.severity === 'block' ? { ...f, severity: 'flag' as Verdict } : f,
    );
    return { ...p, findings, verdict: worstVerdict(findings.map((f) => f.severity)) };
  });
}

/** Naive `+s` gets "patchs" wrong, and the summary is the most-read line here. */
function pluralize(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  const plural = /(s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`;
  return `${n} ${plural}`;
}

/**
 * Phase 1a uses the spec's explicitly-permitted template summary (§8.9) — no LLM
 * call. Deterministic, free, and it makes the workflow tests hermetic.
 */
export function templateSummary(passes: PassResult[], overall: Verdict, patches: PatchProposal[]): string {
  const all = passes.flatMap((p) => p.findings);
  const blocks = all.filter((f) => f.severity === 'block').length;
  const flags = all.filter((f) => f.severity === 'flag').length;

  const lead =
    overall === 'block'
      ? `BLOCK — ${pluralize(blocks, 'blocking finding')} must be resolved before publish.`
      : overall === 'flag'
        ? `FLAG — nothing blocks publish, but ${pluralize(flags, 'finding')} want a human look.`
        : 'PASS — no findings.';

  const byPass = passes
    .map((p) => `${p.pass}: ${p.verdict} (${pluralize(p.findings.length, 'finding')})`)
    .join('; ');

  const patchLine = patches.length
    ? ` ${pluralize(patches.length, 'patch')} proposed.`
    : ' No patches proposed.';

  return `${lead} ${byPass}.${patchLine}`;
}

/** Blocks first, then flags, then by file and line. */
function orderFindings(passes: PassResult[]): PassResult[] {
  return passes.map((p) => ({
    ...p,
    findings: [...p.findings].sort(
      (a, b) =>
        verdictRank(b.severity) - verdictRank(a.severity) ||
        (a.file ?? '').localeCompare(b.file ?? '') ||
        (a.line ?? 0) - (b.line ?? 0),
    ),
  }));
}

/** Spec §8.9. Mechanical assembly — rollup, ordering, template summary. */
export async function synthesizeReport(input: SynthesizeInput): Promise<ReviewReport> {
  const { result } = await timed('synthesizeReport', async () => {
    const passes = orderFindings(clampSeverities(input.passes));
    const overall = worstVerdict(passes.map((p) => p.verdict));

    // Re-key patches globally so IDs are unique across passes, and drop any whose
    // finding was clamped out of existence.
    const patches: PatchProposal[] = [];
    for (const p of passes) {
      for (const patch of p.patches ?? []) {
        patches.push({ ...patch, id: `patch-${patches.length + 1}` });
      }
    }

    return {
      schemaVersion: 1,
      slug: input.snapshot.slug,
      file: input.snapshot.file,
      contentSha256: input.snapshot.contentSha256,
      reviewedAt: new Date().toISOString(),
      workflowId: input.workflowId,
      runId: input.runId,
      passes: passes.map(({ patches: _drop, ...rest }) => rest),
      patches,
      overall,
      summary: templateSummary(passes, overall, patches),
      human: {},
      publish: {},
    } satisfies ReviewReport;
  });
  return result;
}
