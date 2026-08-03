import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/dom-stub.mjs';
import {
  GUESTBOOK_STORAGE_KEY,
  MESSAGE_MAX,
  NAME_MAX,
  SEED_ENTRIES,
  addEntry,
  clampMessage,
  clampName,
  formatEntryDate,
  formatEntryNumber,
  nextEntryNumber,
  readEntries,
  readStoredEntries,
  toLocalIsoDate,
} from '../src/lib/guestbook.mjs';
import { WEB_RING, ringMembers } from '../src/lib/web-ring.mjs';
import { NOTE_MAX, WEBMASTER_NOTES_STORAGE_KEY, clampNote, fileNote, readNotes } from '../src/lib/webmaster-notes.mjs';
import { VISITS_STORAGE_KEY, formatVisits, readVisits, recordVisit } from '../src/lib/visit-counter.mjs';

/**
 * The guest book's whole claim is that the [SIGNED BY AGENT] badge is trustworthy. That rests on
 * exactly one property: provenance is set by the code path that wrote the entry, never by an
 * argument. These tests are what keeps that true after the next refactor.
 */

function reset() {
  localStorage.removeItem(GUESTBOOK_STORAGE_KEY);
  localStorage.removeItem(WEBMASTER_NOTES_STORAGE_KEY);
  localStorage.removeItem(VISITS_STORAGE_KEY);
}

test('the seeded book is five entries, newest first, numbered down to one', () => {
  reset();
  assert.equal(SEED_ENTRIES.length, 5);
  assert.deepEqual(SEED_ENTRIES.map((entry) => entry.number), [5, 4, 3, 2, 1]);
  assert.deepEqual(readEntries(), [...SEED_ENTRIES]);
  assert.equal(nextEntryNumber(), 6);
});

test('every seed carries the same shape a written entry does', () => {
  // A seeded easter egg and a real agent entry have to be indistinguishable in structure, or the
  // client renderer and the server renderer diverge the first time somebody signs the book.
  for (const entry of SEED_ENTRIES) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.message, 'string');
    assert.match(entry.date, /^\d{2} [A-Z]{3} \d{4}$/);
    assert.match(entry.iso, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['human', 'agent'].includes(entry.source));
    assert.ok(entry.name.length <= NAME_MAX, `${entry.name} is over the visible name limit`);
    assert.ok(entry.message.length <= MESSAGE_MAX, `seed #${entry.number} is over the message limit`);
  }
});

test('at least one seed is an agent entry, so the badge is on the page before anyone calls the tool', () => {
  assert.ok(SEED_ENTRIES.some((entry) => entry.source === 'agent'));
});

test('a written entry is prepended, numbered next, and stored', () => {
  reset();

  const first = addEntry({ name: 'Ada', message: 'First.' }, 'human');
  assert.equal(first.ok, true);
  assert.equal(first.entry.number, 6);

  const second = addEntry({ name: 'Grace', message: 'Second.' }, 'agent');
  assert.equal(second.entry.number, 7);

  const book = readEntries();
  assert.equal(book.length, 7);
  assert.equal(book[0].name, 'Grace', 'newest first');
  assert.equal(book[1].name, 'Ada');
  assert.equal(book[2].number, 5, 'the seeds sit under this browser\'s own entries');
  assert.equal(readStoredEntries().length, 2, 'seeds are never written to storage');
});

test('provenance comes from the caller, not the fields', () => {
  reset();

  const fromForm = addEntry({ name: 'x', message: 'y', source: 'agent' }, 'human');
  assert.equal(fromForm.entry.source, 'human', 'the form cannot claim to be an agent');

  const fromTool = addEntry({ name: 'x', message: 'y', source: 'human' }, 'agent');
  assert.equal(fromTool.entry.source, 'agent', 'the tool cannot disclaim being one');

  const nonsense = addEntry({ name: 'x', message: 'y' }, 'webmaster');
  assert.equal(nonsense.entry.source, 'human', 'anything but agent resolves to human');
});

test('input is clamped to the visible maxlength, not rejected', () => {
  reset();

  const result = addEntry({ name: 'n'.repeat(NAME_MAX + 60), message: 'm'.repeat(MESSAGE_MAX + 600) }, 'human');
  assert.equal(result.ok, true);
  assert.equal(result.entry.name.length, NAME_MAX);
  assert.equal(result.entry.message.length, MESSAGE_MAX);
});

test('empty-after-clamping input is an error, not an empty entry', () => {
  reset();

  assert.deepEqual(addEntry({ name: '  ', message: 'ok' }, 'human'), { ok: false, error: 'name' });
  assert.deepEqual(addEntry({ name: 'ok', message: '\n\n' }, 'human'), { ok: false, error: 'message' });
  assert.equal(readStoredEntries().length, 0);
});

test('a name collapses whitespace; a message keeps its line breaks', () => {
  assert.equal(clampName('  Ada   Lovelace \n'), 'Ada Lovelace');
  assert.equal(clampMessage('one\n\ntwo'), 'one\n\ntwo');
  assert.equal(clampMessage('one\n\n\n\n\ntwo'), 'one\n\ntwo');
});

test('a corrupt storage key degrades to the seeded book rather than throwing', () => {
  reset();
  localStorage.setItem(GUESTBOOK_STORAGE_KEY, 'not json at all');
  assert.deepEqual(readEntries(), [...SEED_ENTRIES]);

  localStorage.setItem(GUESTBOOK_STORAGE_KEY, JSON.stringify([{ name: 'no message' }, 42]));
  assert.deepEqual(readEntries(), [...SEED_ENTRIES], 'malformed entries are dropped, not rendered');
});

test('entry numbers and dates print the way the book does', () => {
  assert.equal(formatEntryNumber(6), '#006');
  assert.equal(formatEntryNumber(142), '#142');
  assert.equal(formatEntryDate(new Date(2026, 7, 2)), '02 AUG 2026');
});

test('the machine-readable date is the local calendar day, not the UTC one', () => {
  // 23:30 local on 2 August. In any timezone west of UTC this instant is already 3 August in UTC,
  // so a toISOString()-derived iso would disagree with the visible date on the same entry. The
  // Date is built from local components, so the assertion holds in whatever zone the runner is in.
  const evening = new Date(2026, 7, 2, 23, 30);
  assert.equal(toLocalIsoDate(evening), '2026-08-02');
  assert.equal(formatEntryDate(evening), '02 AUG 2026');

  // Padding: single-digit months and days both keep two characters.
  assert.equal(toLocalIsoDate(new Date(2026, 0, 9, 0, 5)), '2026-01-09');
});

test('a written entry\'s iso and its displayed date are the same day', () => {
  reset();

  // `T12:00:00` with no zone parses as local noon, so this reads the iso back as a calendar day
  // and reprints it. If addEntry ever stamps iso from UTC again, an evening run fails here.
  const { entry } = addEntry({ name: 'Ada', message: 'Signed just now.' }, 'human');
  assert.equal(formatEntryDate(new Date(`${entry.iso}T12:00:00`)), entry.date);
});

test('the ring ships with a real member and labelled open slots', () => {
  assert.ok(WEB_RING.length >= 2);
  assert.equal(ringMembers().length, WEB_RING.filter((m) => m.status === 'member').length);
  assert.ok(ringMembers().length >= 1, 'a ring with no members is not a ring');

  for (const member of WEB_RING) {
    assert.ok(['member', 'open'].includes(member.status));
    assert.equal(typeof member.description, 'string');
    assert.ok(member.description.length > 0);
    // An open slot has no url. A member does. Nothing in between, so no surface can render a
    // dead link or an unlabelled placeholder.
    if (member.status === 'open') assert.equal(member.url, null);
    else assert.match(member.url, /^https:\/\//);
  }
});

test('a filed webmaster note is stored and numbered', () => {
  reset();

  assert.deepEqual(fileNote('   '), { ok: false, error: 'empty' });
  assert.equal(readNotes().length, 0);

  const first = fileNote('Hello webmaster.');
  assert.deepEqual(first, { ok: true, drawer: 1, of: 1 });
  assert.equal(fileNote('Again.').drawer, 2);
  assert.equal(readNotes().length, 2);
  assert.equal(clampNote('x'.repeat(NOTE_MAX + 50)).length, NOTE_MAX);
});

test('the visit counter counts this browser and pads to a fixed width', () => {
  reset();

  assert.equal(readVisits(), 0);
  assert.equal(recordVisit(), 1);
  assert.equal(recordVisit(), 2);
  assert.equal(readVisits(), 2);

  // Fixed width is what keeps replacing the server-rendered value from reflowing the box.
  assert.equal(formatVisits(1), '000001');
  assert.equal(formatVisits(1234), '001234');
  assert.equal(formatVisits(0), '000001', 'a counter never reads zero: you are here');
  assert.equal(formatVisits(99999999).length, 6, 'the box never grows a seventh digit');
});
