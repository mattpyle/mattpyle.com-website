import type { Finding, PassResult } from './report.js';

/**
 * Proposed dispositions for cspell's *unknown word* findings.
 *
 * A bare "X is not in the dictionary" leaves the human to work out, for every
 * hit, whether they are looking at a typo or at a proper noun the dictionary has
 * never met. That triage is most of the work, and the review already has what it
 * needs to make a first guess at it.
 *
 * **The human remains the approver.** This only ever annotates a finding with a
 * suggestion; nothing is added to the dictionary without someone typing
 * `steward dict-add`.
 */

export type Disposition = 'proper_noun' | 'typo';

export interface DictionaryProposal {
  word: string;
  disposition: Disposition;
  reason: string;
}

/** cspell's unknown-word message, from `runCspell`. */
const UNKNOWN_RE = /^"([^"]+)" is not in the dictionary/;

export function unknownWordOf(finding: Finding): string | null {
  if (finding.pass !== 'cspell') return null;
  return UNKNOWN_RE.exec(finding.message)?.[1] ?? null;
}

/**
 * The deterministic fallback, used when the editorial pass did not run (it is
 * skipped, unavailable, or failed) or did not mention this word.
 *
 * The signal is **capitalisation in a position that does not explain it**: a
 * capitalised token mid-sentence is far more likely a name than a misspelling,
 * because a typo of an ordinary word inherits that word's lowercase. A token
 * capitalised only at the start of a sentence or a heading tells us nothing —
 * the position already accounts for the capital — so those fall through to
 * `typo`, which is the safe default: it asks the human to look, rather than
 * nudging them toward admitting a misspelling into the dictionary.
 */
export function fallbackDisposition(word: string, postText: string): DictionaryProposal {
  const midSentence = midSentenceCapital(word, postText);
  if (/^[A-Z]/.test(word) && midSentence) {
    return {
      word,
      disposition: 'proper_noun',
      reason: 'capitalised mid-sentence, where the position does not explain the capital',
    };
  }
  return {
    word,
    disposition: 'typo',
    reason: 'no evidence it is a name; defaulting to typo so a human looks before it is admitted',
  };
}

function midSentenceCapital(word: string, postText: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(.{0,40}?)\\b${escaped}\\b`, 'g');
  for (const m of postText.matchAll(re)) {
    const before = m[1];
    // Start of line, start of the document, or just after sentence-ending
    // punctuation — all positions where a capital is expected regardless.
    if (/(^|[\n\r])\s*[#>\-*\d.]*\s*$/.test(before)) continue;
    if (/[.!?]\s+$/.test(before)) continue;
    if (before.trim() === '') continue;
    return true;
  }
  return false;
}

/**
 * Annotates cspell unknown-word findings in place with a proposed disposition,
 * preferring the editorial pass's judgement (it has read the whole post) and
 * falling back to the deterministic rule above.
 */
export function annotateDispositions(
  passes: PassResult[],
  postText: string,
  proposals: DictionaryProposal[],
): PassResult[] {
  const byWord = new Map(proposals.map((p) => [p.word.toLowerCase(), p]));

  return passes.map((pass) => {
    if (pass.pass !== 'cspell') return pass;
    return {
      ...pass,
      findings: pass.findings.map((finding) => {
        const word = unknownWordOf(finding);
        if (!word) return finding;
        const proposal = byWord.get(word.toLowerCase()) ?? fallbackDisposition(word, postText);
        const label =
          proposal.disposition === 'proper_noun'
            ? `likely proper noun (suggest \`steward dict-add ${word}\`)`
            : 'likely typo';
        return {
          ...finding,
          message: `${finding.message} — ${label}: ${proposal.reason}`,
        };
      }),
    };
  });
}
