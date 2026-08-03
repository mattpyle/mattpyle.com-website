/**
 * The guest book store: the single source of truth for what is in the book and who wrote it.
 *
 * Both writers — the retro form in src/components/Guestbook.astro and the `sign_guestbook`
 * WebMCP tool in src/lib/webmcp-tools.mjs — call addEntry(). There is no second write path,
 * which is what makes the provenance badge trustworthy: `source` is set here from the caller's
 * declared origin, never from a field the visitor or the agent can pass.
 *
 * Client-local, like the appearance switch. Entries live in this browser's localStorage and
 * nowhere else: no fetch, no server, no other visitor. The UI says so at the moment a visitor
 * submits, which is the one moment they are guaranteed to be reading.
 *
 * NO TOP-LEVEL SIDE EFFECTS, ON PURPOSE. src/pages/webmcp/tools.json.ts imports the tool
 * definitions at build time under plain Node, where there is no localStorage and no document;
 * every storage touch below is inside a function and inside a try.
 *
 * SEEDS ARE CODE, NOT DATA. The five easter-egg entries below are rendered server-side and are
 * never written to storage, so the no-JS page and the hydrated page show the same book when
 * storage is empty, and editing a seed later needs no migration. Storage holds only what this
 * visitor added.
 */

export const GUESTBOOK_STORAGE_KEY = 'mattpyle:guestbook';
export const GUESTBOOK_CHANGE_EVENT = 'guestbook:change';

/** Matches the visible maxlength on both fields. Clamp, never reject (design bundle). */
export const NAME_MAX = 40;
export const MESSAGE_MAX = 280;

/** The two recorded origins. The form may only write 'human'; the tool may only write 'agent'. */
export const SOURCES = ['human', 'agent'];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * `DD MMM YYYY`, uppercase, in the visitor's own local time.
 *
 * Hand-rolled rather than Intl.DateTimeFormat because the seeds carry their display string
 * literally (below) and the two have to be the same shape in every locale — an entry an agent
 * wrote must be indistinguishable in structure from a seed, per the design bundle.
 *
 * @param {Date} date
 */
export function formatEntryDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  return `${day} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * `YYYY-MM-DD` for a `<time datetime>`, read off the SAME local calendar day formatEntryDate
 * prints. `toISOString()` is UTC, so an entry signed after 5pm Pacific would carry tomorrow's
 * machine-readable date under today's visible one.
 *
 * @param {Date} date
 */
export function toLocalIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `#008` — the entry number as the book prints it. @param {number} number */
export function formatEntryNumber(number) {
  return `#${String(number).padStart(3, '0')}`;
}

/** @param {unknown} value @param {number} max */
function clamp(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** @param {unknown} value */
export function clampName(value) {
  return clamp(value, NAME_MAX);
}

/**
 * Newlines survive here (a message is prose, a name is not), so this collapses runs of blank
 * lines rather than all whitespace.
 * @param {unknown} value
 */
export function clampMessage(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MESSAGE_MAX);
}

/**
 * The book's permanent floor: five entries, newest first, rendered server-side so the section
 * reads with JavaScript off. Two of them are agent entries, which is what puts the
 * [SIGNED BY AGENT] badge on the page before anybody calls the tool.
 */
export const SEED_ENTRIES = Object.freeze(
  [
    {
      number: 5,
      name: 'an agent with the origin trial on',
      message:
        'Called sign_guestbook from a Chrome that actually implements WebMCP, mostly to find out whether the badge under this line was real. It is.',
      date: '28 JUL 2026',
      iso: '2026-07-28',
      source: 'agent',
    },
    {
      number: 4,
      name: 'Netscape Navigator 4.08',
      message: 'Renders fine. The ridge borders were a good call. Best viewed at 800x600.',
      date: '22 JUL 2026',
      iso: '2026-07-22',
      source: 'human',
    },
    {
      number: 3,
      name: 'a crawler in a hurry',
      message:
        'I read llms-full.txt instead. Same content, no marquee to wait out. Leaving this so you know the plain-text version is the one being used.',
      date: '18 JUL 2026',
      iso: '2026-07-18',
      source: 'agent',
    },
    {
      number: 2,
      name: 'someone who found this by accident',
      message: 'Was looking for the scorecard. Stayed for the counter.',
      date: '15 JUL 2026',
      iso: '2026-07-15',
      source: 'human',
    },
    {
      number: 1,
      name: 'Matt',
      message:
        'First entry. Nothing in this book leaves your browser, so it is less a guest book than a very elaborate note to yourself. Sign it anyway.',
      date: '11 JUL 2026',
      iso: '2026-07-11',
      source: 'human',
    },
  ].map((entry) => Object.freeze(entry))
);

/**
 * @typedef {object} GuestbookEntry
 * @property {number} number
 * @property {string} name
 * @property {string} message
 * @property {string} date  — the display string, `DD MMM YYYY`.
 * @property {string} iso   — the same date for a <time datetime> attribute.
 * @property {'human'|'agent'} source
 */

/** @param {any} value */
function isEntry(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    typeof value.date === 'string' &&
    Number.isInteger(value.number) &&
    SOURCES.includes(value.source)
  );
}

/**
 * This visitor's own entries, oldest first (write order). Anything malformed is dropped rather
 * than thrown: a corrupt key degrades to the seeded book, never to a broken page.
 */
export function readStoredEntries() {
  try {
    const raw = localStorage.getItem(GUESTBOOK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** The whole book as it is displayed: newest first, this visitor's entries above the seeds. */
export function readEntries() {
  return [...readStoredEntries()].reverse().concat(SEED_ENTRIES);
}

/** The number the next entry will carry. */
export function nextEntryNumber() {
  return SEED_ENTRIES.length + readStoredEntries().length + 1;
}

/**
 * Append an entry to this browser's book and announce it.
 *
 * `source` is the caller's own origin, decided by which code path is calling — it is deliberately
 * NOT read from `fields`, so the form cannot claim to be an agent and the tool cannot disclaim
 * being one. Anything other than 'agent' resolves to 'human'.
 *
 * AT-LEAST-ONCE DELIVERY IS ASSUMED. Measured in build-log Session 16: the Model Context Tool
 * Inspector replays its entire call history when its content script re-injects, and nothing in
 * the WebMCP protocol flags a replayed write. So an entry whose clamped name and message match
 * THE MOST RECENT STORED ENTRY is not written twice; the existing entry comes back with
 * `duplicate: true` instead. Only the most recent is compared, on purpose: the same signature
 * after somebody else's entry is a person signing again, not a replay, and it is written. The
 * guard lives here rather than in the tool so the form inherits it too.
 *
 * `source` is part of that comparison. A replay arrives from the code path that made the original
 * call, so it always matches; what the check excludes is handing a form submission an entry the
 * tool wrote, which would put the [SIGNED BY AGENT] badge on a human's words.
 *
 * @param {{ name?: unknown, message?: unknown }} fields
 * @param {string} source
 * @returns {{ ok: true, entry: GuestbookEntry, duplicate?: true } | { ok: false, error: 'name' | 'message' }}
 */
export function addEntry(fields, source) {
  const name = clampName(fields?.name);
  const message = clampMessage(fields?.message);

  if (!name) return { ok: false, error: 'name' };
  if (!message) return { ok: false, error: 'message' };

  const resolvedSource = source === 'agent' ? 'agent' : 'human';

  const existing = readStoredEntries();
  const latest = existing[existing.length - 1];
  if (latest && latest.name === name && latest.message === message && latest.source === resolvedSource) {
    // No write, and no guestbook:change event: nothing about the book changed, so there is
    // nothing for the rendered panel to re-render.
    return { ok: true, entry: latest, duplicate: true };
  }

  const now = new Date();
  const entry = {
    number: nextEntryNumber(),
    name,
    message,
    date: formatEntryDate(now),
    iso: toLocalIsoDate(now),
    source: resolvedSource,
  };

  existing.push(entry);
  try {
    localStorage.setItem(GUESTBOOK_STORAGE_KEY, JSON.stringify(existing));
  } catch {
    // Storage unavailable (private mode, quota). The entry is still returned and still rendered
    // for this page view; it just will not survive a reload. Degrade, do not throw.
  }

  // Lets the guest book re-render itself when the write came from somewhere else on the page —
  // most importantly the `sign_guestbook` tool, which an agent can call while the visitor is
  // looking at the book.
  try {
    document.dispatchEvent(new CustomEvent(GUESTBOOK_CHANGE_EVENT, { detail: { entry } }));
  } catch {
    // No document (build-time import, or a test without the DOM stub). Nothing to announce to.
  }

  return { ok: true, entry };
}
