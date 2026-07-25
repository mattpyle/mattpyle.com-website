/**
 * A tiny JSON tokenizer for the /webmcp try-it console's output panel.
 *
 * No library: the site sets `markdown.syntaxHighlight: false` and ships no highlighter, and one
 * isn't worth a dependency for pretty-printing four tool results.
 *
 * Returns TOKENS, not markup. The caller builds elements and assigns `textContent` — never
 * innerHTML / set:html — so a string inside a tool result can't inject anything, and nothing here
 * has to be CSP-hashed or escaped.
 *
 * The highlighting is EMPHASIS, NOT INFORMATION: every token is legible in the panel's base colour
 * and the JSON reads identically in monochrome, so colouring keys differently from values does not
 * breach never-convey-meaning-by-colour-alone.
 */

/**
 * The categories every editor theme separates: the key you scan for, the string that holds the
 * data, numbers, the `true`/`false`/`null` keywords, the brackets that carry structure, and the
 * commas and colons that should recede.
 *
 * `bracket` tokens carry a `depth`, cycling 0/1/2 by nesting level — VS Code's bracket pair
 * colorization, which is what makes a deep result readable at a glance. `depth` is the nesting
 * level of the pair itself, so an opening brace and its matching closer always share a colour.
 *
 * @typedef {{ text: string, kind: 'key' | 'string' | 'number' | 'keyword' | 'bracket' | 'punctuation' | 'plain', depth?: number }} JsonToken
 */

/** How many colours the bracket ramp cycles through before repeating. Matches VS Code's three. */
export const BRACKET_DEPTH_COLOURS = 3;

// One pass, four alternatives: a quoted string (with an optional trailing colon, which makes it an
// object key rather than a string value), a number, a bare literal, or a structural character.
// Everything between matches — indentation and newlines — is emitted verbatim as `plain`.
const TOKEN_PATTERN = /"(?:\\.|[^"\\])*"(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\],:]/g;

/**
 * Split pretty-printed JSON into styled tokens.
 *
 * @param {string} source
 * @returns {JsonToken[]}
 */
export function tokenizeJson(source) {
  /** @type {JsonToken[]} */
  const tokens = [];
  const push = (text, kind, depth) => {
    if (text) tokens.push(depth === undefined ? { text, kind } : { text, kind, depth });
  };

  let lastIndex = 0;
  let match;
  let nesting = 0;
  TOKEN_PATTERN.lastIndex = 0;

  while ((match = TOKEN_PATTERN.exec(source)) !== null) {
    push(source.slice(lastIndex, match.index), 'plain');
    lastIndex = TOKEN_PATTERN.lastIndex;

    const raw = match[0];
    const colon = match[1];

    if (raw.startsWith('"')) {
      if (colon === undefined) {
        push(raw, 'string');
      } else {
        push(raw.slice(0, raw.length - colon.length), 'key');
        push(colon, 'punctuation');
      }
    } else if (raw === '{' || raw === '[') {
      // Colour the opener at the depth it opens, then descend — so a pair matches.
      push(raw, 'bracket', nesting % BRACKET_DEPTH_COLOURS);
      nesting += 1;
    } else if (raw === '}' || raw === ']') {
      // Ascend first, for the same reason. Math.max guards malformed input rather than
      // producing a negative index that would land on no CSS class at all.
      nesting = Math.max(0, nesting - 1);
      push(raw, 'bracket', nesting % BRACKET_DEPTH_COLOURS);
    } else if (raw === ',' || raw === ':') {
      push(raw, 'punctuation');
    } else if (raw === 'true' || raw === 'false' || raw === 'null') {
      push(raw, 'keyword');
    } else {
      push(raw, 'number');
    }
  }

  push(source.slice(lastIndex), 'plain');
  return tokens;
}

/**
 * Pretty-print any tool return value and tokenize it.
 *
 * @param {unknown} value
 * @returns {JsonToken[]}
 */
export function formatJson(value) {
  // JSON.stringify returns undefined for undefined/functions/symbols. A handler shouldn't return
  // one, but the panel must print something rather than crash on the word "undefined".
  return tokenizeJson(JSON.stringify(value, null, 2) ?? 'undefined');
}
