/**
 * The small JSON Schema validator the discovery-document validators share.
 *
 * Extracted from scripts/validate-a2a-card.mjs when the Agent Skills index needed the same thing.
 * Two hand-transcribed schemas now sit in scripts/lib/ (a2a-agent-card.schema.json and
 * agent-skills-index.schema.json) and both are checked by this.
 *
 * The design point worth keeping: it implements only the keywords listed in KNOWN_KEYWORDS, and a
 * schema using anything else **throws** rather than being quietly ignored. That is what stops a
 * future re-vendoring or transcription from silently weakening a check — an assertion nobody
 * implemented is an assertion nobody is making, and the loud version of that is a red build.
 *
 * Adding a keyword here means implementing it below, not just naming it.
 */

const KNOWN_KEYWORDS = new Set([
  // Annotations, ignored on purpose.
  '$schema', '$comment', '$defs',
  // Assertions, all implemented below.
  '$ref', 'type', 'properties', 'additionalProperties', 'required', 'items',
  'propertyNames', 'enum', 'pattern', 'anyOf', 'minimum', 'maximum',
  'minLength', 'maxLength',
]);

export function typeOf(value) {
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
  if (typeof value === 'string') {
    // Code points, not UTF-16 units: the spec's limits are character counts, and `.length` would
    // charge two against the budget for anything outside the BMP.
    const characters = [...value].length;
    if (schema.minLength !== undefined && characters < schema.minLength) {
      errors.push(`${path || '/'}: ${characters} characters, under the minimum of ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && characters > schema.maxLength) {
      errors.push(`${path || '/'}: ${characters} characters, over the maximum of ${schema.maxLength}`);
    }
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
      // A2A specification section 5.7: "Arrays marked as required MUST contain at least one
      // element." Applied to both schemas: an empty required array is a broken document either way.
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
        errors.push(`${path}/${name}: property is not allowed by this schema`);
        continue;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(child, schema.additionalProperties, root, `${path}/${name}`, errors);
      }
    }
  }

  return errors;
}
