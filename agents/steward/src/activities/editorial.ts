import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SITE_DIR } from '../config.js';
import { LLM_SETTINGS, callRubric, loadRubric, withLineNumbers, type RubricSend } from '../lib/llm.js';
import type { Finding, PassKind, PassResult, PatchProposal, Verdict } from '../lib/report.js';
import { worstVerdict } from '../lib/report.js';
import { timed } from '../lib/logger.js';
import { TellCategory, TELL_CATEGORIES } from '../lib/tells.js';

// ---------------------------------------------------------------------------
// The claims-structure response schema (spec §9.1).
// ---------------------------------------------------------------------------

export const ClaimsCategory = z.enum([
  'overclaiming',
  'unsupported',
  'buried_lede',
  'answer_first',
  'self_containment',
  'contradiction',
]);

export const ClaimsFinding = z.object({
  category: ClaimsCategory,
  line: z.number(),
  excerpt: z.string(),
  message: z.string(),
  evidence: z.string(),
});

export const ClaimsPatch = z.object({
  line: z.number(),
  oldText: z.string(),
  newText: z.string(),
  rationale: z.string(),
});

/**
 * Proposed dispositions for words the dictionary does not know (Prompt 3c).
 *
 * The editorial pass produces these because it is the only pass that has read
 * the whole post: "Kimi" is obviously a model name in context and obviously
 * nothing in isolation. It cannot be told *which* words cspell flagged — the two
 * passes run in parallel in the fan-out — so it is asked instead to list tokens
 * it believes are names. `annotateDispositions` matches them against cspell's
 * actual unknown-word findings afterwards, and anything unmatched falls back to
 * the deterministic rule.
 */
export const DictionaryProposal = z.object({
  word: z.string(),
  disposition: z.enum(['proper_noun', 'typo']),
  reason: z.string(),
});

export const ClaimsStructureResponse = z.object({
  findings: z.array(ClaimsFinding),
  // The rubric says empty arrays are valid and correct; defaulting them means a
  // model that omits a key entirely is not punished for being right.
  patches: z.array(ClaimsPatch).default([]),
  // Defaulted for the same reason, and additionally so that every report written
  // before this field existed still parses.
  dictionaryProposals: z.array(DictionaryProposal).default([]),
});
export type ClaimsStructureResponse = z.infer<typeof ClaimsStructureResponse>;

// ---------------------------------------------------------------------------
// The two clamps. Design rule 1 / spec §8.6, enforced HERE — in code — rather
// than trusted to the rubric text. A prompt is a request; this is a guarantee.
// ---------------------------------------------------------------------------

/**
 * Clamp 1: editorial findings may never exceed `flag`.
 *
 * LLM judgment does not get to block a publish (design rule 1). The rubric also
 * says so, but a prompt cannot be relied on for an invariant this load-bearing:
 * a model that decides an overclaim is "critical" and emits `block` must not be
 * able to gate the human's publish on its own opinion.
 */
export function clampSeverity(severity: Verdict): Verdict {
  return severity === 'block' ? 'flag' : severity;
}

/** Words, for the token-count half of the patch-size rule. */
function tokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface PatchSizeVerdict {
  accepted: boolean;
  tokenDelta: number;
  lengthDelta: number;
  reason?: string;
}

/**
 * Clamp 2: the hard line against LLM prose rewrites (spec §8.6).
 *
 * An editorial patch is accepted only if it is a *mechanical-class* edit —
 * token count delta <= 3 AND character length delta <= 20. Anything larger is a
 * rewrite wearing a patch's clothing, and gets demoted to a finding with the
 * suggestion preserved in `evidence` rather than silently dropped.
 *
 * Deltas are absolute: a patch that deletes 40 characters is exactly as much a
 * rewrite as one that adds 40.
 */
export function judgePatchSize(oldText: string, newText: string): PatchSizeVerdict {
  const tokenDelta = Math.abs(tokenCount(newText) - tokenCount(oldText));
  const lengthDelta = Math.abs(newText.length - oldText.length);

  if (tokenDelta > 3) {
    return {
      accepted: false,
      tokenDelta,
      lengthDelta,
      reason: `changes ${tokenDelta} tokens (limit 3)`,
    };
  }
  if (lengthDelta > 20) {
    return {
      accepted: false,
      tokenDelta,
      lengthDelta,
      reason: `changes ${lengthDelta} characters (limit 20)`,
    };
  }
  return { accepted: true, tokenDelta, lengthDelta };
}

// ---------------------------------------------------------------------------
// The ai-tells response schema (spec §9.2).
// ---------------------------------------------------------------------------

// The tell taxonomy lives in `lib/tells.ts` so `steward stats` can count these
// categories without importing this module, and with it the API client. A
// command that makes no network calls should not need an API key to run.
// Re-exported here because callers of the pass look for them beside it.
export {
  TellCategory,
  TELL_CATEGORIES,
  FORMAT_DRIVEN_TELLS,
  VOICE_DRIVEN_TELLS,
  UNCLASSIFIED_TELLS,
} from '../lib/tells.js';

export const AiTellFinding = z.object({
  category: TellCategory,
  line: z.number(),
  excerpt: z.string(),
  message: z.string(),
  evidence: z.string(),
});

export const AiTellsResponse = z.object({
  // Clamped on the way out rather than rejected here: a model returning 105 has
  // understood the task and failed at arithmetic, and discarding the whole
  // response (and its findings) over that would lose more than it protects.
  aiLikenessScore: z.number(),
  findings: z.array(AiTellFinding),
  /**
   * The rubric ends "No patches. Style is the author's call." — and this field
   * exists anyway, because Phase 1b established that the model's failure mode is
   * not inventing findings but *over-eagerness to convert a judgment into a
   * patch*. It emitted patches for judgment-class findings when explicitly told
   * not to. Accepting the key and dropping its contents is strictly better than
   * a validation error that throws away a good set of findings alongside the
   * unwanted patches.
   */
  patches: z.array(z.unknown()).default([]),
});
export type AiTellsResponse = z.infer<typeof AiTellsResponse>;

export interface AiTellsMapped {
  findings: Finding[];
  patches: PatchProposal[];
  aiLikenessScore: number;
  tellCounts: Record<TellCategory, number>;
  droppedPatches: number;
}

/**
 * Maps an ai-tells response onto findings, applying the same three clamps as
 * `mapClaimsResponse`.
 *
 * **Clamp 3 does all the work here, and it does it totally.** Every one of the
 * eight tells is a statement about *style*, and style is the author's call
 * (design rule 1) — so by the same test that rejects a patch touching an
 * `overclaiming` finding, every ai-tells category is judgment-class and no patch
 * from this pass can ever be accepted. That makes "this pass proposes no
 * patches" a consequence of the existing clamp rather than a separate rule, and
 * the count of what was dropped is surfaced rather than silently discarded, so
 * a model that starts emitting patches is visible instead of invisible.
 */
export function mapAiTellsResponse(response: AiTellsResponse, file: string): AiTellsMapped {
  const findings: Finding[] = [];

  // Seeded with every category at zero. A tell that did not fire is a real
  // measurement of zero, not a missing key — and the study compares per-category
  // totals across pieces, where an absent key and a zero are very different
  // things to anything doing arithmetic downstream.
  const tellCounts = Object.fromEntries(TELL_CATEGORIES.map((c) => [c, 0])) as Record<
    TellCategory,
    number
  >;

  response.findings.forEach((f, i) => {
    tellCounts[f.category] += 1;
    findings.push({
      id: `ai-tells-${i + 1}`,
      pass: 'ai_tells',
      // Clamp 1. Applied explicitly at the mapping site, same as the claims
      // pass: a model must never be able to block a publish on a stylistic
      // opinion. This pass in particular is pure taste.
      severity: clampSeverity('flag'),
      message: `${f.category}: ${f.message}`,
      file,
      line: f.line,
      excerpt: f.excerpt.slice(0, 200),
      evidence: f.evidence,
    });
  });

  return {
    findings,
    // Clamp 3, absolute for this pass — see the doc comment.
    patches: [],
    aiLikenessScore: clampScore(response.aiLikenessScore),
    tellCounts,
    droppedPatches: response.patches.length,
  };
}

/**
 * The score is a 0-100 composite by definition, so a response outside that range
 * is clamped rather than trusted. Non-finite values become 0 — treating a NaN as
 * a low score is safe (this pass can only ever flag), whereas letting it into
 * the metrics would poison every aggregate computed from it downstream.
 */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

// ---------------------------------------------------------------------------

const RUBRIC_TO_PASS: Record<string, PassKind> = {
  'claims-structure': 'claims_structure',
  'ai-tells': 'ai_tells',
};

export interface EditorialPassOptions {
  /** Test seam: bypasses the network entirely (spec §11 — hermetic tests). */
  send?: RubricSend;
}

/**
 * Maps a validated rubric response onto a `PassResult`, applying both clamps.
 *
 * Pure and exported so the clamps can be unit-tested against canned responses
 * with no network and no file on disk.
 */
/**
 * Categories that represent editorial *judgment* rather than a mechanical
 * defect. A fix for any of these is by definition a prose change.
 */
const JUDGMENT_CATEGORIES: ReadonlySet<string> = new Set([
  'overclaiming',
  'unsupported',
  'buried_lede',
  'answer_first',
  'self_containment',
  'contradiction',
]);

export function mapClaimsResponse(
  response: ClaimsStructureResponse,
  file: string,
): { findings: Finding[]; patches: PatchProposal[] } {
  const findings: Finding[] = [];
  const patches: PatchProposal[] = [];

  /**
   * Clamp 3: no patch may touch text that a judgment-class finding is about.
   *
   * **Why the size clamp alone is not enough.** Observed live: asked to review a
   * post whose lede claimed "this proves agents prefer markdown over HTML", the
   * model flagged it as `overclaiming` *and* proposed a patch rewriting it to
   * "this does not yet prove agents prefer markdown over HTML". That is a
   * semantic reversal of the post's central claim — and it sailed through clamp
   * 2 with a token delta of exactly 3 and a character delta of 12, both inside
   * the limits.
   *
   * Size is a proxy for "mechanical", and this is the case that proves the proxy
   * does not hold: a small edit can reverse a claim's meaning entirely. The
   * category the model itself assigned is the far better signal. If it says a
   * line overclaims, then editing that line is an editorial act, and design rule
   * 1 reserves editorial acts for the human.
   */
  const judgmentLines = new Set<number>();
  const judgmentExcerpts: string[] = [];
  for (const f of response.findings) {
    if (!JUDGMENT_CATEGORIES.has(f.category)) continue;
    judgmentLines.add(f.line);
    if (f.excerpt.trim()) judgmentExcerpts.push(f.excerpt.trim());
  }

  const touchesJudgment = (p: { line: number; oldText: string }): boolean => {
    if (judgmentLines.has(p.line)) return true;
    // Line numbers drift when a model cites a block rather than a line, so also
    // reject on text overlap in either direction.
    const old = p.oldText.trim();
    if (!old) return false;
    return judgmentExcerpts.some((ex) => ex.includes(old) || old.includes(ex));
  };

  response.findings.forEach((f, i) => {
    findings.push({
      id: `claims-${i + 1}`,
      pass: 'claims_structure',
      // Clamp 1. The model never supplies a severity for this rubric, but the
      // clamp is applied explicitly so the invariant is visible at the mapping
      // site rather than implied by the literal below.
      severity: clampSeverity('flag'),
      message: `${f.category.replace(/_/g, ' ')}: ${f.message}`,
      file,
      line: f.line,
      excerpt: f.excerpt.slice(0, 200),
      evidence: f.evidence,
    });
  });

  response.patches.forEach((p, i) => {
    // A no-op patch is dropped entirely, not demoted to a finding.
    //
    // Observed live: asked to review a post whose planted typo had already been
    // fixed, the model emitted a patch with `oldText` identical to `newText` and
    // a rationale explaining that it had found no typo. It passes the size clamp
    // (both deltas are zero) and would apply cleanly while changing nothing —
    // offering the human a patch that does nothing is worse than offering none.
    if (p.oldText === p.newText) return;

    // Clamp 3 — see the comment on `judgmentLines` above. Checked BEFORE the
    // size clamp, because the failure it catches passes the size clamp.
    if (touchesJudgment(p)) {
      findings.push({
        id: `claims-judgment-patch-${i + 1}`,
        pass: 'claims_structure',
        severity: clampSeverity('flag'),
        message: `Suggested edit was refused because it rewrites prose the model itself flagged as an editorial judgment, not a mechanical defect. ${p.rationale}`,
        file,
        line: p.line,
        excerpt: p.oldText.slice(0, 200),
        evidence: `The model proposed replacing this with: "${p.newText}". Rewriting a claim the model flagged as overclaiming, unsupported, or contradictory is an editorial act, and the Steward never makes those automatically (design rule 1) — however small the edit. Decide this one yourself.`,
      });
      return;
    }

    const verdict = judgePatchSize(p.oldText, p.newText);
    if (verdict.accepted) {
      const findingId = `claims-patch-${i + 1}`;
      findings.push({
        id: findingId,
        pass: 'claims_structure',
        severity: clampSeverity('flag'),
        message: `mechanical fix: ${p.rationale}`,
        file,
        line: p.line,
        excerpt: p.oldText.slice(0, 200),
      });
      patches.push({
        id: `patch-${patches.length + 1}`,
        findingId,
        file,
        oldText: p.oldText,
        newText: p.newText,
        rationale: p.rationale,
        source: 'editorial',
      });
      return;
    }

    // Clamp 2 demotion: no patch, but the suggestion survives in `evidence` so
    // the human can still act on it by hand if they agree.
    findings.push({
      id: `claims-oversized-${i + 1}`,
      pass: 'claims_structure',
      severity: clampSeverity('flag'),
      message: `Suggested edit was too large to apply automatically (${verdict.reason}) and is recorded as a suggestion only. ${p.rationale}`,
      file,
      line: p.line,
      excerpt: p.oldText.slice(0, 200),
      evidence: `The model proposed replacing this with: "${p.newText}". Editorial patches are limited to mechanical-class edits (<= 3 tokens, <= 20 characters) — anything larger is a prose rewrite, which the Steward never applies automatically.`,
    });
  });

  return { findings, patches };
}

/**
 * Spec §8.6. One LLM editorial pass over one post.
 *
 * Two rubrics: `claims-structure` (Phase 1b) and `ai-tells` (Phase 2a, reached
 * only when the caller sets `enableAiTells` on the workflow input).
 */
export async function editorialPass(
  file: string,
  rubricName: string,
  options: EditorialPassOptions = {},
): Promise<PassResult> {
  const pass = RUBRIC_TO_PASS[rubricName];
  if (!pass) throw new Error(`Unknown rubric "${rubricName}".`);

  if (rubricName === 'ai-tells') return aiTellsPass(file, options);

  const { result, startedAt, durationMs } = await timed('editorialPass', async () => {
    const rubric = await loadRubric(rubricName);
    const text = await fs.readFile(path.join(SITE_DIR, file), 'utf8');

    const { data, attempts } = await callRubric({
      rubric,
      userContent: withLineNumbers(text),
      schema: ClaimsStructureResponse,
      send: options.send,
    });

    return {
      ...mapClaimsResponse(data, file),
      dictionaryProposals: data.dictionaryProposals,
      rubric,
      attempts,
    };
  });

  return {
    pass,
    verdict: worstVerdict(result.findings.map((f) => f.severity)),
    findings: result.findings,
    patches: result.patches,
    startedAt,
    durationMs,
    rubric: {
      path: result.rubric.path,
      sha256: result.rubric.sha256,
      model: LLM_SETTINGS.model,
    },
    metrics: {
      validationAttempts: result.attempts,
      // Carried on the pass so `synthesizeReport` can match them against
      // cspell's unknown-word findings. They are not findings themselves —
      // proposing a disposition is not the same as reporting a defect.
      dictionaryProposals: result.dictionaryProposals,
    },
  };
}

/**
 * The `ai-tells` pass (spec §8.6, §9.2).
 *
 * Structurally the claims pass with a different rubric and a different response
 * shape, kept as a separate function rather than a branch inside the other one
 * because the two differ in what they *return*, not merely in what they ask:
 * this one carries `aiLikenessScore` and a per-category breakdown in `metrics`
 * and can never carry patches.
 *
 * **The per-category breakdown is not decoration.** The composite score alone
 * cannot distinguish "this reads as AI" from "this is a changelog entry", since
 * three of the eight tells are the changelog's house format. Reporting the
 * breakdown per piece is what lets the analysis re-rank on the voice-driven
 * tells alone — testing whether the scorer measures provenance or genre —
 * without retuning the rubric between runs, which the study design forbids.
 */
async function aiTellsPass(file: string, options: EditorialPassOptions): Promise<PassResult> {
  const { result, startedAt, durationMs } = await timed('editorialPass', async () => {
    const rubric = await loadRubric('ai-tells');
    const text = await fs.readFile(path.join(SITE_DIR, file), 'utf8');

    const { data, attempts } = await callRubric({
      rubric,
      userContent: withLineNumbers(text),
      schema: AiTellsResponse,
      send: options.send,
    });

    return { mapped: mapAiTellsResponse(data, file), rubric, attempts };
  });

  return {
    pass: 'ai_tells',
    verdict: worstVerdict(result.mapped.findings.map((f) => f.severity)),
    findings: result.mapped.findings,
    patches: result.mapped.patches,
    startedAt,
    durationMs,
    rubric: {
      path: result.rubric.path,
      sha256: result.rubric.sha256,
      model: LLM_SETTINGS.model,
    },
    metrics: {
      validationAttempts: result.attempts,
      // Spec §8.6: the composite is a *metric*, not a finding. Nothing about a
      // score of 70 is a defect the author must answer for — design rule 1 —
      // and putting it in `metrics` keeps it out of the findings table while
      // still archiving it for the study.
      aiLikenessScore: result.mapped.aiLikenessScore,
      tellCounts: result.mapped.tellCounts,
      // Surfaced so that a model which starts proposing patches despite the
      // rubric is visible in the archive rather than silently clamped. Expected
      // to be 0; a non-zero value is itself a finding about the model.
      droppedPatches: result.mapped.droppedPatches,
    },
  };
}
