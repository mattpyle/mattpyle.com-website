import {
  MECHANICAL_PASSES,
  worstVerdict,
  verdictRank,
  type DraftSnapshot,
  type PassResult,
  type PatchProposal,
  type ReviewMode,
  type ReviewReport,
  type Verdict,
} from '../lib/report.js';
import { timed } from '../lib/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE_DIR } from '../config.js';
import { annotateDispositions, type DictionaryProposal } from '../lib/dispositions.js';

export interface SynthesizeInput {
  snapshot: DraftSnapshot;
  passes: PassResult[];
  workflowId: string;
  runId: string;
  /** Defaulted so pre-audit-mode callers and fixtures keep working. */
  mode?: ReviewMode;
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

/**
 * Collapses byte-identical patch proposals and re-keys the survivors so IDs are
 * unique across passes.
 *
 * **Why only byte-identical ones.** cspell and the editorial pass routinely reach
 * the same conclusion about the same typo — Phase 1b offered `accessibiltiy` as
 * both `patch-1` (mechanical) and `patch-2` (editorial). Two patches that are one
 * patch is noise, and with a third finding source in the fan-out it gets worse.
 *
 * **Overlapping-but-different patches are deliberately NOT merged.** Two passes
 * proposing different rewrites of the same span is a genuine disagreement, and
 * picking a winner would mean the Steward making an editorial choice on the
 * human's behalf (design rule 1). Both survive as separate patches; selecting
 * both fails safely, because `applyPatchesActivity`'s all-or-nothing exact-match
 * guard finds 0 matches for the second and writes nothing.
 *
 * Identity is `(file, oldText, newText)`. `source` and `rationale` deliberately do
 * not participate: the same edit proposed for two different stated reasons is
 * still the same edit. The survivor keeps the first pass's identity and records
 * every pass that proposed it in `sourcePasses`, so the human can see that two
 * independent checks agreed rather than losing that signal to the dedupe.
 */
export function dedupePatches(passes: PassResult[]): PatchProposal[] {
  const byKey = new Map<string, PatchProposal>();
  const order: string[] = [];

  for (const p of passes) {
    for (const patch of p.patches ?? []) {
      const key = JSON.stringify([patch.file, patch.oldText, patch.newText]);
      const seen = byKey.get(key);
      if (seen) {
        // Same edit, second proposer. Record the agreement, keep one patch.
        if (!seen.sourcePasses!.includes(p.pass)) seen.sourcePasses!.push(p.pass);
        continue;
      }
      byKey.set(key, { ...patch, sourcePasses: [p.pass] });
      order.push(key);
    }
  }

  return order.map((key, i) => ({ ...byKey.get(key)!, id: `patch-${i + 1}` }));
}

/**
 * Attaches a proposed disposition to each cspell unknown-word finding, using the
 * editorial pass's proposals where it offered any and the deterministic rule
 * otherwise (Prompt 3c).
 *
 * Reading the post here is deliberate: the fallback rule needs to see the word
 * *in position* to tell a name from a typo, and synthesis is the first point at
 * which both the cspell findings and the editorial proposals exist together.
 * A post that cannot be read is not fatal — the annotation is an aid, and losing
 * it must not cost the human their report.
 */
async function annotateUnknownWords(passes: PassResult[], file: string): Promise<PassResult[]> {
  const proposals = passes.flatMap((p) => {
    const raw = p.metrics?.dictionaryProposals;
    return Array.isArray(raw) ? (raw as DictionaryProposal[]) : [];
  });

  let text = '';
  try {
    text = await fs.readFile(path.join(SITE_DIR, file), 'utf8');
  } catch {
    // Fall through with empty text: every unknown word then reads as `typo`,
    // which is the conservative disposition and still asks the human to look.
  }

  return annotateDispositions(passes, text, proposals);
}

/** Spec §8.9. Mechanical assembly — rollup, ordering, template summary. */
export async function synthesizeReport(input: SynthesizeInput): Promise<ReviewReport> {
  const { result } = await timed('synthesizeReport', async () => {
    const passes = await annotateUnknownWords(
      orderFindings(clampSeverities(input.passes)),
      input.snapshot.file,
    );
    const overall = worstVerdict(passes.map((p) => p.verdict));

    const patches = dedupePatches(passes);

    return {
      schemaVersion: 1,
      slug: input.snapshot.slug,
      collection: input.snapshot.collection ?? 'writing',
      mode: input.mode ?? 'gate',
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
