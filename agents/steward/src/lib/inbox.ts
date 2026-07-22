import type { ReviewState } from './report.js';

/**
 * `steward inbox` (backlog #5) — the state -> "waiting on you?" derivation.
 *
 * Pure and side-effect-free on purpose: the CLI resolves `staleReason` and
 * `prUrl` (the latter via `readArchivedReport`, which is I/O and must fail
 * loud per design rule 11 rather than being caught here) and hands them in.
 * This is the one piece of `inbox` worth unit-testing — the rest is console
 * rendering, which the project doesn't heavily test elsewhere either.
 *
 * The `publishing` state is ambiguous by itself: the workflow parks there in
 * two different shapes (see `review-post.ts`'s `runVerification`) — a
 * `staleReason` mentioning "CI is FAILING", or one starting "PR open,
 * awaiting merge". Both are "your turn", but with different fixes, so the
 * text of `staleReason` is what disambiguates them, not the state alone.
 */

export interface InboxHint {
  /** Sorts to the top of the table when true. */
  yourTurn: boolean;
  hint: string;
}

export interface DeriveInboxHintInput {
  state: ReviewState;
  staleReason?: string;
  /** From the archived report's `publish.prUrl`, only resolved for the `publishing` state. */
  prUrl?: string;
}

/** `https://github.com/owner/repo/pull/42` -> `PR #42 (https://…)`. Falls back to the bare URL, then to "the PR". */
function prLabel(prUrl?: string): string {
  if (!prUrl) return 'the PR';
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? `PR #${match[1]} (${prUrl})` : prUrl;
}

export function deriveInboxHint({ state, staleReason, prUrl }: DeriveInboxHintInput): InboxHint {
  switch (state) {
    case 'awaiting_verdict':
      return { yourTurn: true, hint: 'your turn: read the report, approve or reject' };

    case 'stale':
      return { yourTurn: true, hint: 'your turn: send `rereview` to re-check the edited file' };

    case 'applying_patches':
      return { yourTurn: false, hint: 'in progress: applying patches' };

    case 'running':
      return { yourTurn: false, hint: 'in progress: fan-out running' };

    case 'verifying_deploy':
      return { yourTurn: false, hint: 'in progress: verifying production deploy' };

    case 'publishing':
      if (!staleReason) {
        // Not parked — the publish just started and hasn't opened the PR yet,
        // or is mid-verification-loop between polls.
        return { yourTurn: false, hint: 'in progress: publishing' };
      }
      if (/CI is FAILING/.test(staleReason)) {
        return {
          yourTurn: true,
          hint: `your turn: ${prLabel(prUrl)} CI is failing — fix it, then \`approve\` again to resume`,
        };
      }
      // The other parked shape: "PR open, awaiting merge: <url> …".
      return { yourTurn: true, hint: `your turn: merge ${prLabel(prUrl)}, then re-approve` };

    // Terminal states. A workflow in one of these has completed, so it should
    // never appear in the OPEN-reviews inbox — but `--all` renders recently
    // closed reviews too, and this keeps the function total over the enum
    // rather than throwing on a value the caller is allowed to pass.
    case 'approved':
    case 'published':
    case 'rejected':
    case 'audited':
    case 'failed':
      return { yourTurn: false, hint: 'closed' };

    default: {
      const exhaustive: never = state;
      return { yourTurn: false, hint: `unrecognised state: ${String(exhaustive)}` };
    }
  }
}
