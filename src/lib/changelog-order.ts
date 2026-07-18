export type ChangelogSignificance = 'major' | 'minor' | 'patch';

export interface ChangelogSortableEntry {
  id: string;
  data: {
    title: string;
    date: Date;
    publishedAt?: Date;
    type: string;
    significance: ChangelogSignificance;
  };
}

const significancePriority: Record<ChangelogSignificance, number> = {
  major: 0,
  minor: 1,
  patch: 2,
};

/**
 * Newest-first public changelog order.
 *
 * `date` is the day the change shipped. `publishedAt`, when present, records
 * when its changelog entry was actually published and resolves same-day ties.
 * Older entries do not invent timestamps: they fall through to stable editorial
 * signals, then title and id so the result never depends on collection order.
 */
export function compareChangelogEntries(
  a: ChangelogSortableEntry,
  b: ChangelogSortableEntry,
): number {
  const dateDifference = b.data.date.getTime() - a.data.date.getTime();
  if (dateDifference !== 0) return dateDifference;

  const aPublishedAt = a.data.publishedAt?.getTime();
  const bPublishedAt = b.data.publishedAt?.getTime();
  if (aPublishedAt !== undefined && bPublishedAt !== undefined) {
    const publishedDifference = bPublishedAt - aPublishedAt;
    if (publishedDifference !== 0) return publishedDifference;
  } else if (aPublishedAt !== undefined) {
    return -1;
  } else if (bPublishedAt !== undefined) {
    return 1;
  }

  const significanceDifference =
    significancePriority[a.data.significance] - significancePriority[b.data.significance];
  if (significanceDifference !== 0) return significanceDifference;

  const launchDifference = Number(b.data.type === 'launch') - Number(a.data.type === 'launch');
  if (launchDifference !== 0) return launchDifference;

  const titleDifference = a.data.title.localeCompare(b.data.title, 'en', {
    sensitivity: 'base',
  });
  if (titleDifference !== 0) return titleDifference;

  return a.id.localeCompare(b.id, 'en', { sensitivity: 'base' });
}
