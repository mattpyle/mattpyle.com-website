/**
 * Validate public/.well-known/agent-card.json against the A2A 1.0 schema, and against the site.
 *
 * Runs in the `build` chain beside the sitemap, article-actions and CSP-hash validators. The card
 * is a hand-written static file that no build step generates, which makes it the one artifact here
 * that can silently rot: nothing else in the repo would notice if it declared an endpoint that
 * does not exist or carried a field the spec dropped.
 *
 * ## Schema provenance
 *
 * scripts/lib/a2a-agent-card.schema.json is a vendored subset of the official bundle published at
 * https://a2a-protocol.org/latest/spec/a2a.json (fetched 2026-08-03), which is itself generated
 * from the normative specification/a2a.proto in github.com/a2aproject/A2A. Vendored rather than
 * fetched so the build never depends on a third party being up, and so a spec change lands as a
 * reviewed diff instead of as a surprise red build.
 *
 * Three deliberate changes from the published bundle, all narrowing:
 *
 * 1. **snake_case spellings dropped.** The published schema accepts both `default_input_modes` and
 *    `defaultInputModes`, because it is mechanically derived from proto field names. Specification
 *    section 5.5 requires camelCase for all JSON serializations, so only that spelling is kept.
 * 2. **`required` added.** The generated bundle carries no `required` arrays: proto3 has no such
 *    concept and the `google.api.field_behavior = REQUIRED` annotations do not survive the
 *    conversion. They are transcribed here from specification/a2a.proto, per section 5.7, which
 *    also supplies the rule that a required array must be non-empty.
 * 3. **Types this card cannot contain are not validated.** SecurityScheme and SecurityRequirement
 *    are large discriminated unions; this agent is unauthenticated and declares neither. Their
 *    `$ref`s are replaced by a `$comment`, so those subtrees pass unexamined. If the card ever
 *    grows a security scheme, vendor them properly rather than trusting this.
 *
 * The shared validator in scripts/lib/json-schema.mjs implements only the keywords the transcribed
 * schemas actually use. That is a feature: an unimplemented keyword appearing in a schema throws
 * rather than being ignored, so a future re-vendoring cannot quietly weaken the check.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate } from './lib/json-schema.mjs';
import { PRODUCTION_ORIGIN } from '../src/data/site-origin.mjs';

const CARD_PATH = fileURLToPath(new URL('../public/.well-known/agent-card.json', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('./lib/a2a-agent-card.schema.json', import.meta.url));

/**
 * Schema conformance plus the checks a schema cannot make: that the card describes *this* site,
 * and that what it promises is what the endpoint actually implements.
 *
 * @param {object} card
 * @param {object} schema
 * @param {{ origin?: string }} [options]
 */
export function validateAgentCard(card, schema, { origin = PRODUCTION_ORIGIN } = {}) {
  const errors = validate(card, schema, schema, '', []);

  const jsonrpc = (card.supportedInterfaces ?? []).filter(
    (entry) => entry.protocolBinding === 'JSONRPC'
  );
  if (jsonrpc.length !== 1) {
    errors.push(`supportedInterfaces: expected exactly one JSONRPC interface, found ${jsonrpc.length}`);
  } else {
    // The card is a static file and cannot be preview-aware, so it always names production. That
    // is right for a discovery document (a preview deployment should not advertise itself as the
    // agent) but it means this URL has to be pinned to the real route by hand.
    if (jsonrpc[0].url !== `${origin}/a2a`) {
      errors.push(`supportedInterfaces[0].url: expected ${origin}/a2a, got ${jsonrpc[0].url}`);
    }
    if (jsonrpc[0].protocolVersion !== '1.0') {
      errors.push(`supportedInterfaces[0].protocolVersion: expected "1.0", got ${JSON.stringify(jsonrpc[0].protocolVersion)}`);
    }
  }

  // src/lib/a2a-responder.mjs implements none of these. A card that claimed otherwise would send
  // clients down code paths that return -32601.
  for (const [name, value] of Object.entries(card.capabilities ?? {})) {
    if (value !== false) errors.push(`capabilities.${name}: the v1 responder implements none of these; must be false`);
  }

  if ((card.skills ?? []).length !== 1) {
    errors.push(`skills: the v1 declares exactly one skill, found ${(card.skills ?? []).length}`);
  }

  return errors;
}

export function readCard(path = CARD_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readSchema(path = SCHEMA_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const errors = validateAgentCard(readCard(), readSchema());
  if (errors.length > 0) {
    console.error('Agent Card validation failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('[a2a-card] public/.well-known/agent-card.json conforms to the A2A 1.0 schema');
}
