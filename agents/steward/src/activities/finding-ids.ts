import { ApplicationFailure } from '@temporalio/activity';
import { ARGUS_REPO } from '../config.js';
import { createFindingDirectory, type FindingDirectory } from '../lib/finding-directory.js';
import { parseFindingRef, type FindingRef } from '../lib/finding-ids.js';
import { MAX_RESOLVE_IDS, type ResolveFindingIdsInput, type ResolvedFindingId } from '../lib/finding-resolve-contract.js';
import { gh } from '../lib/github.js';

/**
 * `resolveFindingIds`: which finding each id names, for a caller that holds no
 * GitHub credential.
 *
 * The Discord service starts it as a Standalone Activity on `steward-findings`
 * and gets back, for each id, the site, key, short id, short title and the
 * site's `auto_fix`, or a miss, or the findings an ambiguous id could mean. It
 * returns no file text.
 *
 * The caller chooses the ids and nothing else. The repository is this worker's
 * own `ARGUS_REPO`, so a caller cannot point the worker's credential at another
 * repository, and each id is parsed again here: a string that is not an id
 * reaches no path and is answered as missing.
 *
 * GitHub reads only, through `gh`, so it satisfies the findings queue's
 * "nothing local" rule. The directory keeps blob text by sha for the life of
 * the worker process: a call reads the tree, one request, and the finding files
 * that changed since the last call. The first call after a worker restart reads
 * every finding file once.
 */

let directory: FindingDirectory | undefined;

export async function resolveFindingIds(input: ResolveFindingIdsInput): Promise<ResolvedFindingId[]> {
  const ids = input?.ids;
  if (!Array.isArray(ids) || ids.length > MAX_RESOLVE_IDS || ids.some((id) => typeof id !== 'string' || id.length > 250)) {
    throw ApplicationFailure.nonRetryable(`resolveFindingIds takes up to ${MAX_RESOLVE_IDS} ids, each a string.`, 'InvalidInput');
  }
  const parsed = ids.map((id) => ({ id, ref: parseFindingRef(id) }));
  const refs = parsed.map((each) => each.ref).filter((ref): ref is FindingRef => ref !== null);
  directory ??= createFindingDirectory({ repo: ARGUS_REPO, ghJson: (pathname) => gh(pathname) });
  const lookups = refs.length > 0 ? await directory.lookup(refs) : [];

  let next = 0;
  return parsed.map(({ id, ref }): ResolvedFindingId => {
    if (!ref) return { id, missing: true };
    const lookup = lookups[next++];
    if ('found' in lookup) {
      const { site, key, keyShort, title, autoFix } = lookup.found;
      return { id, found: { site, key, keyShort, title, autoFix } };
    }
    if ('missing' in lookup) return { id, missing: true };
    return { id, ambiguous: lookup.ambiguous.map(({ site, key }) => ({ site, key })) };
  });
}
