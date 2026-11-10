/**
 * 1Password references in `agents/steward/.env`.
 *
 * A secret line in that file is a reference such as `op://Steward/<ITEM>/<field>`.
 * The `steward` launcher (`scripts/steward.mjs`) runs the CLI under
 * `op run --env-file`, which swaps each reference for its value in the child's
 * environment before `config.ts` loads. `loadDotEnv` never overrides a variable
 * that is already set, so the resolved value wins over the reference in the file.
 *
 * A reference that still reaches Steward means something launched it without
 * `op run` (`npx tsx`, `node --env-file`, an IDE). Every secret would then be a
 * literal `op://` string, sent as a credential. `unresolvedReferenceRefusal`
 * stops that at boot. Pure: it reads the environment it is given.
 */

/** The prefix of a 1Password secret reference. */
export const OP_REFERENCE_PREFIX = 'op://';

/** True when a dotenv value is a reference, after the quote strip `loadDotEnv` applies. */
export function isOpReference(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().replace(/^["']/, '').startsWith(OP_REFERENCE_PREFIX);
}

/**
 * The refusal text for the first variable that still holds a reference, or null.
 * It names the variable and the fix. It never prints a value.
 */
export function unresolvedReferenceRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = Object.keys(env).find((key) => isOpReference(env[key]));
  if (name === undefined) return null;
  return (
    `Refusing to start: ${name} is still a 1Password reference (op://...), so Steward would use the ` +
    'reference text as the credential. Run the command through `steward <verb>`, which resolves ' +
    'references with `op run`, and not through `npx tsx`, `node --env-file` or an editor run button. ' +
    'If `steward` is not on PATH, run `npm link` once in agents/steward.'
  );
}

/**
 * True when the line `loadDotEnv` would read for `key` holds a reference. The rotate
 * command skips its `.env` write for such a line: the 1Password item is the local copy.
 *
 * Parses as `loadDotEnv` does (trim the line, skip blanks and `#` comments, split at
 * the first `=`, trim the key) and compares keys exactly, so `KEY = op://...` counts and
 * a key that is a prefix of another does not. The first line for a key wins, as there.
 * No RegExp is built from the key.
 */
export function envLineIsReference(text: string, key: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return isOpReference(trimmed.slice(eq + 1));
  }
  return false;
}
