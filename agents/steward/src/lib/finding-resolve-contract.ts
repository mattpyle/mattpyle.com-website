/**
 * The contract of the `resolveFindingIds` activity: its name, and what goes in
 * and comes out. Names and types only, with no imports, so the caller, which
 * holds no GitHub credential, takes nothing else from the worker's side.
 *
 * The activity runs on the hosted worker, on `steward-findings`, started as a
 * Standalone Activity by the Discord service. It answers which finding each id
 * names, and returns these fields and nothing more: never a file's text.
 */

export const RESOLVE_FINDING_IDS_ACTIVITY = 'resolveFindingIds';

/** The most ids one call resolves. */
export const MAX_RESOLVE_IDS = 25;

export interface ResolveFindingIdsInput {
  /** The ids as typed, or already normalized: `MP-121`, a full key, or `site/key`. */
  ids: string[];
}

export interface ResolvedFinding {
  site: string;
  key: string;
  /** `MP-121`; null when the finding file has none. */
  keyShort: string | null;
  /** The short title, else the file's heading, else the key. */
  title: string;
  /** The site's `auto_fix` flag. */
  autoFix: boolean;
}

/** One per id, in the order asked. */
export type ResolvedFindingId =
  | { id: string; found: ResolvedFinding }
  | { id: string; missing: true }
  | { id: string; ambiguous: { site: string; key: string }[] };
