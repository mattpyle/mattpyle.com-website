/**
 * The webmaster's filing cabinet: notes written to "Email the Webmaster", stored in the visitor's
 * own browser and read by nobody.
 *
 * This is the joke and it admits it. The 1997 gesture is preserved exactly (a form, a send button,
 * a confirmation) and the confirmation states plainly that the note never left the browser. The
 * real contact channel is a LinkedIn link under the confirmation, which is the moment it is
 * actually useful.
 *
 * Storing the note rather than discarding it is what makes the copy true: it really is filed in a
 * cabinet only this visitor can open. No fetch, no server, no mailto.
 *
 * NO TOP-LEVEL SIDE EFFECTS — this file sits on a chain that Node imports at build time.
 */

import { toLocalIsoDate } from './guestbook.mjs';

export const WEBMASTER_NOTES_STORAGE_KEY = 'mattpyle:webmaster-notes';

export const NOTE_MAX = 500;

/** @param {unknown} value */
export function clampNote(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, NOTE_MAX);
}

/** Every note this browser has filed, oldest first. A corrupt key reads as an empty cabinet. */
export function readNotes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WEBMASTER_NOTES_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((note) => note && typeof note.message === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * File a note. Returns the drawer number so the confirmation can name a concrete absurd object.
 *
 * @param {unknown} message
 * @returns {{ ok: true, drawer: number, of: number } | { ok: false, error: 'empty' }}
 */
export function fileNote(message) {
  const text = clampNote(message);
  if (!text) return { ok: false, error: 'empty' };

  const notes = readNotes();
  // Local, not UTC: the same reason the guest book's iso is (a note filed in the evening in
  // Pacific must not be stamped with tomorrow's date).
  notes.push({ message: text, iso: toLocalIsoDate(new Date()) });
  try {
    localStorage.setItem(WEBMASTER_NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // Storage unavailable. The note is filed for this page view only, which is a difference of
    // degree rather than of kind: it was never going anywhere.
  }

  return { ok: true, drawer: notes.length, of: notes.length };
}
