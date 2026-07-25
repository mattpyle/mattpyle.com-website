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

/** @typedef {{ text: string, kind: 'key' | 'string' | 'literal' | 'punctuation' | 'plain' }} JsonToken */

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
  const push = (text, kind) => {
    if (text) tokens.push({ text, kind });
  };

  let lastIndex = 0;
  let match;
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
    } else if (raw.length === 1 && '{}[],:'.includes(raw)) {
      push(raw, 'punctuation');
    } else {
      // numbers, true, false, null — one visual class, per the contrast table on /webmcp
      push(raw, 'literal');
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
