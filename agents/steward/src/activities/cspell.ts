import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spellCheckDocument, readConfigFile } from 'cspell-lib';
import type { CSpellSettings } from 'cspell-lib';
import { CSPELL_CONFIG, SITE_DIR } from '../config.js';
import type { PassResult, Finding, PatchProposal } from '../lib/report.js';
import { worstVerdict } from '../lib/report.js';
import { timed } from '../lib/logger.js';

/** Plain Levenshtein. Small inputs (single words), so the naive DP is fine. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * "Unambiguous" (spec §8.2) means: exactly one suggestion sits at the minimum
 * edit distance, and that distance is <= 2.
 *
 * cspell's own `isPreferred` flag is too narrow on its own — `refacrtor` gets no
 * preferred suggestion, yet `refactor` (distance 1) is obviously the fix while
 * the runner-up `reactor` is distance 2. A preferred suggestion always wins.
 */
export function pickSuggestion(
  word: string,
  suggestions: { word: string; isPreferred?: boolean }[],
): string | null {
  const preferred = suggestions.find((s) => s.isPreferred);
  if (preferred) return preferred.word;
  if (suggestions.length === 0) return null;
  const scored = suggestions.map((s) => ({ word: s.word, d: editDistance(word, s.word) }));
  const min = Math.min(...scored.map((s) => s.d));
  if (min > 2) return null;
  const winners = scored.filter((s) => s.d === min);
  return winners.length === 1 ? winners[0].word : null;
}

/**
 * Loads `cspell.config.yaml` through cspell's own config loader rather than
 * parsing the YAML by hand.
 *
 * A hand-rolled `words:` scanner was the first attempt and it silently dropped
 * every word that followed a comment line inside the list — the dictionary
 * looked complete in the file and was half-empty at runtime. For a check that
 * emits `block` verdicts, a silently-narrow dictionary is the worst failure
 * mode there is: it manufactures findings against correct prose.
 */
async function loadSettings(): Promise<CSpellSettings> {
  // cspell 10's `readConfigFile` returns a *wrapper* — `{ url, settings }` — not
  // the settings object. Passing the wrapper straight through silently yields an
  // empty dictionary, which is indistinguishable from a working one until real
  // jargon starts blocking.
  const loaded = await readConfigFile(CSPELL_CONFIG);
  const settings = (loaded as { settings?: CSpellSettings }).settings ?? (loaded as CSpellSettings);
  if (!settings.words?.length) {
    throw new Error(
      `cspell.config.yaml loaded with an empty dictionary (${CSPELL_CONFIG}). Refusing to run: an empty dictionary manufactures block findings against correct prose.`,
    );
  }
  return settings;
}

/**
 * Spec §8.2. Runs cspell in-process (cspell-lib) rather than spawning the CLI:
 * no process spawn to make Windows-safe, and the issue objects carry the
 * suggestion metadata the JSON reporter flattens away.
 */
export async function runCspell(file: string): Promise<PassResult> {
  const { result, startedAt, durationMs } = await timed('runCspell', async () => {
    const abs = path.join(SITE_DIR, file);
    const text = await fs.readFile(abs, 'utf8');
    const settings = await loadSettings();

    const checked = await spellCheckDocument(
      { uri: pathToFileURL(abs).href, text, languageId: 'markdown' },
      { generateSuggestions: true, noConfigSearch: true },
      { ...settings, language: settings.language ?? 'en' },
    );

    const findings: Finding[] = [];
    const patches: PatchProposal[] = [];
    let n = 0;
    for (const issue of checked.issues) {
      n += 1;
      const id = `cspell-${n}`;
      const suggestions = (issue.suggestionsEx ?? []).map((s) => ({
        word: s.word,
        isPreferred: s.isPreferred,
      }));
      const pick = pickSuggestion(issue.text, suggestions);
      // Derived from the document offset rather than cspell's `line.position`,
      // which is present at runtime but absent from the published `TextOffset`
      // type — relying on it means relying on an untyped implementation detail.
      const line = text.slice(0, issue.offset).split('\n').length;
      findings.push({
        id,
        pass: 'cspell',
        severity: pick ? 'block' : 'flag',
        message: pick
          ? `"${issue.text}" — did you mean "${pick}"?`
          : `"${issue.text}" is not in the dictionary${
              suggestions.length ? ` (suggestions: ${suggestions.slice(0, 3).map((s) => s.word).join(', ')})` : ''
            }. Fix it, or add it to cspell.config.yaml if it is jargon.`,
        file,
        line,
        excerpt: (issue.line?.text ?? issue.text).trim().slice(0, 200),
      });
      if (pick) {
        patches.push({
          id: `patch-${patches.length + 1}`,
          findingId: id,
          file,
          oldText: issue.text,
          newText: pick,
          rationale: `cspell: "${issue.text}" is not a word; "${pick}" is the unambiguous correction.`,
          source: 'mechanical',
        });
      }
    }

    return { findings, patches };
  });

  return {
    pass: 'cspell',
    verdict: worstVerdict(result.findings.map((f) => f.severity)),
    findings: result.findings,
    patches: result.patches,
    startedAt,
    durationMs,
    toolVersion: `cspell-lib ${await cspellVersion()}`,
  };
}

async function cspellVersion(): Promise<string> {
  try {
    const pkgUrl = new URL('../../node_modules/cspell-lib/package.json', import.meta.url);
    return JSON.parse(await fs.readFile(pkgUrl, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}
