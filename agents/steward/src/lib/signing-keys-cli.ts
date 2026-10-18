import { SIGNING_KEY_ENV, generateSigningKey, type PublicJwk } from './agent-audit/request-signing.js';

/**
 * `steward keys generate`: a new Web Bot Auth key pair, printed and never written.
 *
 * The operator is the only party who ever holds the private half: the verb prints it once, and
 * the operator stores it in the password manager and pastes it into `agents/steward/.env` and the
 * hosted worker's environment. Nothing here touches a file, a store or the network, so a
 * mistyped run costs nothing but a key to throw away.
 */

export interface GeneratedKeyPair {
  privateJwk: Record<string, string>;
  publicJwk: PublicJwk;
}

/** The text the verb prints, as lines, so a test can read it without a terminal. */
export function describeKeyPair({ privateJwk, publicJwk }: GeneratedKeyPair): string[] {
  return [
    'A new Web Bot Auth key pair for steward-audit. Nothing was written.',
    '',
    `Private key. Store it in the password manager, then set it, as one line, in agents/steward/.env and on the hosted worker:`,
    `${SIGNING_KEY_ENV}=${JSON.stringify(privateJwk)}`,
    '',
    'Public key. Add it to the "keys" array in src/data/steward-signing-keys.json, beside any key still in use:',
    JSON.stringify(publicJwk),
    '',
    `keyid: ${publicJwk.kid}`,
  ];
}

/** Runs the verb. `--json` prints the pair as one JSON object instead of the instructions. */
export function runKeysGenerate(opts: { json?: boolean }, write: (line: string) => void = console.log): void {
  const pair = generateSigningKey();
  if (opts.json) {
    write(JSON.stringify(pair));
    return;
  }
  for (const line of describeKeyPair(pair)) write(line);
}
