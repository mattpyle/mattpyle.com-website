import fs from 'node:fs/promises';
import { CSPELL_CONFIG } from '../config.js';

/**
 * Appends a word to the Steward's project dictionary.
 *
 * **Scope of the sort.** "Kept sorted and deduplicated" is applied *within a
 * dedicated section*, not across the whole file. `cspell.config.yaml` groups its
 * words under comment headings (standards, tools, proper nouns, en-GB
 * collateral) and several entries carry per-word attribution comments recording
 * why they were admitted. A global sort would scatter those groups and orphan
 * every attribution from its word — destroying the provenance that makes the
 * dictionary reviewable. Curated groupings stay hand-maintained; machine-added
 * words land together, sorted among themselves, visibly distinct from the
 * curated ones.
 *
 * The human remains the approver: the Steward only ever *proposes* a dict-add in
 * a report, and this runs when a human types the verb.
 */

const SECTION_HEADING = '  # --- Added via `steward dict-add` ---';
const SECTION_NOTE =
  '  # Machine-appended, human-approved. Kept sorted within this section; the\n' +
  '  # curated groups above are hand-maintained and deliberately not re-sorted.';

export interface AddWordResult {
  word: string;
  added: boolean;
  configPath: string;
}

export async function addWord(rawWord: string): Promise<AddWordResult> {
  const word = rawWord.trim();
  if (!word || /\s/.test(word)) {
    throw new Error(`"${rawWord}" is not a single word. dict-add takes one bare word.`);
  }

  const original = await fs.readFile(CSPELL_CONFIG, 'utf8');
  const lines = original.split(/\r?\n/);
  // Preserve the file's existing line endings. Joining with '\n' unconditionally
  // would rewrite every line of a CRLF checkout on Windows, turning a one-word
  // addition into a whole-file diff that buries the actual change in review.
  const eol = original.includes('\r\n') ? '\r\n' : '\n';

  // Membership is case-insensitive, matching how cspell treats the wordlist —
  // adding "Kimi" when "kimi" is present would be a silent duplicate.
  const existing = new Set(
    lines
      .map((l) => /^\s*-\s+(\S+)\s*$/.exec(l)?.[1])
      .filter((w): w is string => Boolean(w))
      .map((w) => w.toLowerCase()),
  );
  if (existing.has(word.toLowerCase())) {
    return { word, added: false, configPath: CSPELL_CONFIG };
  }

  const headingIdx = lines.findIndex((l) => l.trim() === SECTION_HEADING.trim());

  let next: string[];
  if (headingIdx === -1) {
    // First machine-added word: create the section at the end of the file.
    const body = [...lines];
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    next = [...body, '', SECTION_HEADING, SECTION_NOTE, `  - ${word}`, ''];
  } else {
    // Collect the existing entries of this section and re-sort with the new word.
    let start = headingIdx + 1;
    while (start < lines.length && lines[start].trim().startsWith('#')) start += 1;
    let end = start;
    const entries: string[] = [];
    while (end < lines.length && /^\s*-\s+\S+\s*$/.test(lines[end])) {
      entries.push(lines[end].trim().replace(/^-\s+/, ''));
      end += 1;
    }
    entries.push(word);
    entries.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    next = [...lines.slice(0, start), ...entries.map((w) => `  - ${w}`), ...lines.slice(end)];
  }

  await fs.writeFile(CSPELL_CONFIG, next.join(eol), 'utf8');
  return { word, added: true, configPath: CSPELL_CONFIG };
}
