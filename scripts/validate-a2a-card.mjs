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
 * The validator below implements only the keywords the vendored schema actually uses. That is a
 * feature: an unimplemented keyword appearing in the schema throws rather than being ignored, so
 * a future re-vendoring cannot quietly weaken the check.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_ORIGIN } from '../src/data/site-origin.mjs';

const CARD_PATH = fileURLToPath(new URL('../public/.well-known/agent-card.json', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('./lib/a2a-agent-card.schema.json', import.meta.url));

const KNOWN_KEYWORDS = new Set([
  // Annotations, ignored on purpose.
  '$schema', '$comment', '$defs',
  // Assertions, all implemented below.
  '$ref', 'type', 'properties', 'additionalProperties', 'required', 'items',
  'propertyNames', 'enum', 'pattern', 'anyOf', 'minimum', 'maximum',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  return typeOf(value) === type || (type === 'number' && typeOf(value) === 'integer');
}

/**
 * Validate `value` against `schema`, collecting human-readable errors.
 *
 * @param {unknown} value
 * @param {object} schema
 * @param {object} root The document holding `$defs`.
 * @param {string} path JSON-pointer-ish location, for messages.
 * @param {string[]} errors Accumulator.
 */
export function validate(value, schema, root, path = '', errors = []) {
  if (schema.$comment && !schema.$ref && !schema.type && !schema.properties) return errors;

  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      throw new Error(`${path || '/'}: schema uses unimplemented keyword "${keyword}"`);
    }
  }

  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = root.$defs?.[name];
    if (!target) throw new Error(`${path || '/'}: unresolvable $ref ${schema.$ref}`);
    return validate(value, target, root, path, errors);
  }

  if (schema.anyOf) {
    const matched = schema.anyOf.some((branch) => validate(value, branch, root, path, []).length === 0);
    if (!matched) errors.push(`${path || '/'}: matches none of the allowed forms`);
    return errors;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path || '/'}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || '/'}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path || '/'}: does not match ${schema.pattern}`);
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, index) => validate(item, schema.items, root, `${path}[${index}]`, errors));
    }
    return errors;
  }

  if (typeOf(value) === 'object' && (schema.properties || schema.additionalProperties !== undefined)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) {
        errors.push(`${path || '/'}: missing required property "${name}"`);
        continue;
      }
      // Section 5.7: "Arrays marked as required MUST contain at least one element."
      if (Array.isArray(value[name]) && value[name].length === 0) {
        errors.push(`${path}/${name}: required array is empty`);
      }
    }

    for (const [name, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[name];
      if (childSchema) {
        validate(child, childSchema, root, `${path}/${name}`, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${path}/${name}: property is not allowed by the A2A 1.0 schema`);
        continue;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(child, schema.additionalProperties, root, `${path}/${name}`, errors);
      }
    }
  }

  return errors;
}

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
