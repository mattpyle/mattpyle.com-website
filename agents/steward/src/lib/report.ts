import { z } from 'zod';

export const Verdict = z.enum(['pass', 'flag', 'block']);
export type Verdict = z.infer<typeof Verdict>;

export const PassKind = z.enum([
  'cspell',
  'vale',
  'frontmatter',
  'build_audit',
  'claims_structure',
  'ai_tells',
]);
export type PassKind = z.infer<typeof PassKind>;

export const ReviewState = z.enum([
  'running',
  'awaiting_verdict',
  'applying_patches',
  'stale',
  /**
   * Phase 1a terminal state: the human approved, the decision is recorded, and
   * the workflow completed without publishing (ENABLE_PUBLISH_LEG is off).
   * Deviation from spec §6.1 — see README.
   */
  'approved',
  'publishing',
  'verifying_deploy',
  'published',
  'rejected',
  'failed',
]);
export type ReviewState = z.infer<typeof ReviewState>;

/** Passes whose findings are allowed to carry a `block` severity (design rule 1). */
export const MECHANICAL_PASSES: PassKind[] = ['cspell', 'frontmatter', 'build_audit'];

export const Finding = z.object({
  id: z.string(),
  pass: PassKind,
  severity: Verdict,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  excerpt: z.string().optional(),
  evidence: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const PatchProposal = z.object({
  id: z.string(),
  findingId: z.string(),
  file: z.string(),
  oldText: z.string(),
  newText: z.string(),
  rationale: z.string(),
  source: z.enum(['mechanical', 'editorial']),
});
export type PatchProposal = z.infer<typeof PatchProposal>;

export const PassResult = z.object({
  pass: PassKind,
  verdict: Verdict,
  findings: z.array(Finding),
  startedAt: z.iso.datetime(),
  durationMs: z.number(),
  toolVersion: z.string().optional(),
  rubric: z
    .object({ path: z.string(), sha256: z.string(), model: z.string() })
    .optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  /** Patches this pass proposes. Assembled into the report by synthesizeReport. */
  patches: z.array(PatchProposal).optional(),
});
export type PassResult = z.infer<typeof PassResult>;

export const ReviewReport = z.object({
  schemaVersion: z.literal(1),
  slug: z.string(),
  file: z.string(),
  contentSha256: z.string(),
  reviewedAt: z.iso.datetime(),
  workflowId: z.string(),
  runId: z.string(),
  passes: z.array(PassResult),
  patches: z.array(PatchProposal),
  overall: Verdict,
  summary: z.string(),
  human: z.object({
    decision: z.enum(['approved', 'approved_force', 'rejected']).optional(),
    reason: z.string().optional(),
    decidedAt: z.iso.datetime().optional(),
    patchesApplied: z.array(z.string()).optional(),
  }),
  publish: z.object({
    branch: z.string().optional(),
    prUrl: z.string().optional(),
    deployVerified: z.boolean().optional(),
    verification: z
      .array(
        z.object({
          check: z.string(),
          url: z.string(),
          ok: z.boolean(),
          detail: z.string(),
        }),
      )
      .optional(),
  }),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

export interface DraftSnapshot {
  slug: string;
  /** Repo-relative path. */
  file: string;
  contentSha256: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ReviewStateResult {
  state: ReviewState;
  overall?: Verdict;
  summary?: string;
  reportPath?: string;
  staleReason?: string;
  pendingPatches?: { id: string; rationale: string }[];
}

const RANK: Record<Verdict, number> = { pass: 0, flag: 1, block: 2 };

/** Worst verdict wins. Empty input is a pass. */
export function worstVerdict(verdicts: Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((worst, v) => (RANK[v] > RANK[worst] ? v : worst), 'pass');
}

export function verdictRank(v: Verdict): number {
  return RANK[v];
}

/**
 * A pass that failed after all its retries. Spec §7.3 step 2: a broken linter
 * must not silently produce a cleaner report, so the absence of results is
 * itself a flag.
 *
 * Lives here (a pure module) rather than in an activity because the *workflow*
 * builds it, in the catch around each fan-out stub. `nowIso` is passed in for
 * the same reason — the workflow supplies `workflow.now()`, never `Date.now()`.
 */
export function toolFailurePass(pass: PassKind, error: string, nowIso: string): PassResult {
  return {
    pass,
    verdict: 'flag',
    findings: [
      {
        id: `${pass}-failed`,
        pass,
        severity: 'flag',
        message: `The ${pass} check failed to run and produced no results: ${error}. This is not a clean bill of health — re-run once the tool is fixed.`,
      },
    ],
    patches: [],
    startedAt: nowIso,
    durationMs: 0,
  };
}
