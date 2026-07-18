import assert from 'node:assert/strict';
import test from 'node:test';
import { compareChangelogEntries } from '../src/lib/changelog-order.ts';

function entry({
  id,
  title = id,
  date = '2026-07-17',
  publishedAt,
  significance = 'minor',
  type = 'feature',
}) {
  return {
    id,
    data: {
      title,
      date: new Date(`${date}T00:00:00.000Z`),
      ...(publishedAt ? { publishedAt: new Date(publishedAt) } : {}),
      significance,
      type,
    },
  };
}

test('orders changelog entries by date before same-day tie-breakers', () => {
  const entries = [
    entry({ id: 'older-major', date: '2026-07-16', significance: 'major' }),
    entry({ id: 'newer-patch', date: '2026-07-17', significance: 'patch' }),
  ];

  assert.deepEqual(entries.sort(compareChangelogEntries).map(({ id }) => id), [
    'newer-patch',
    'older-major',
  ]);
});

test('uses publication timestamp when a same-day entry has one', () => {
  const entries = [
    entry({ id: 'unknown-time', significance: 'major' }),
    entry({ id: 'earlier', publishedAt: '2026-07-17T18:00:00Z' }),
    entry({ id: 'later', publishedAt: '2026-07-17T19:00:00Z' }),
  ];

  assert.deepEqual(entries.sort(compareChangelogEntries).map(({ id }) => id), [
    'later',
    'earlier',
    'unknown-time',
  ]);
});

test('falls back to significance, launch type, title, then id', () => {
  const entries = [
    entry({ id: 'patch', significance: 'patch' }),
    entry({ id: 'minor-zulu', title: 'Zulu' }),
    entry({ id: 'minor-alpha-b', title: 'Alpha' }),
    entry({ id: 'minor-alpha-a', title: 'Alpha' }),
    entry({ id: 'minor-launch', title: 'Launch', type: 'launch' }),
    entry({ id: 'major', significance: 'major' }),
  ];

  assert.deepEqual(entries.sort(compareChangelogEntries).map(({ id }) => id), [
    'major',
    'minor-launch',
    'minor-alpha-a',
    'minor-alpha-b',
    'minor-zulu',
    'patch',
  ]);
});
