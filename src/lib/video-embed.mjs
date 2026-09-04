/**
 * The one definition of the `<Video />` block: what Keystatic writes into a post,
 * and the `<video>` element the site and the agent surfaces render from it.
 *
 * Why a rewrite rather than a component. Posts are plain `.md`, rendered by
 * Sätteri, not MDX — there is no component runtime to resolve a JSX tag against.
 * Keystatic's `fields.mdx` serialiser writes a declared block as a self-closing
 * JSX tag, and in plain markdown that tag parses as a block-level `html` node and
 * reaches the output verbatim. So the tag is the storage format and this module
 * turns it into HTML, in three places: the site's markdown pipeline
 * (astro.config.mjs, through `videoEmbedMdastPlugin`), and the two routes that
 * emit `article.body` for agents (src/pages/writing/[slug].md.ts and
 * src/pages/llms-full.txt.ts, through `rewriteVideoTags`). One definition, three
 * consumers, so an agent reading the markdown sees the element a browser does.
 *
 * The match is deliberately exact: one line, `<Video`, capital V, self-closing,
 * carrying exactly the four required attributes. Anything else is left untouched
 * rather than half-rewritten. A post can still write a literal `<video>` element
 * by hand, and this module will not touch it.
 *
 * The MP4 and its poster live in `public/video/`, referenced site-absolute.
 * `public/` is copied verbatim with no processing, which is what a video wants:
 * Astro's image pipeline has nothing to offer an MP4, and the poster is served as
 * recorded. That means `width` and `height` are the author's job — they are the
 * intrinsic pixel size of the file, and they are required because an element with
 * no dimensions shifts the layout as the poster loads.
 *
 * No `autoplay`: the a11y suite's self-animation check fails a page that moves on
 * load, and `controls` is what makes the element operable by keyboard.
 */

/** The four attributes a `<Video />` tag must carry, in the order the output uses. */
const REQUIRED = ['src', 'poster', 'width', 'height'];

/**
 * One `<Video ... />` tag, whole line, self-closing. Attribute values arrive in
 * either of the two forms the Keystatic serialiser emits: `name="value"` for a
 * text field, `name={value}` for an integer one.
 */
const TAG = /^<Video((?:\s+[A-Za-z][A-Za-z0-9]*=(?:"[^"\n]*"|\{[^{}"\n]*\}))+)\s*\/>$/;
const ATTR = /([A-Za-z][A-Za-z0-9]*)=(?:"([^"\n]*)"|\{([^{}"\n]*)\})/g;

/** @param {string} value */
function escapeAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse one candidate line into its attributes.
 *
 * @param {string} line
 * @returns {Record<string, string> | null} null when the line is not exactly the
 *   supported form, or does not carry exactly the four required attributes with
 *   integer dimensions.
 */
function parseVideoTag(line) {
  // One line, and only one. `\s` inside TAG matches a newline, so a tag split
  // across lines would otherwise pass — and it reaches the pipeline as an inline
  // node inside a paragraph, not the block-level node the serialiser writes.
  if (line.includes('\n')) return null;

  const match = TAG.exec(line);
  if (!match) return null;

  /** @type {Record<string, string>} */
  const attributes = {};
  for (const attr of match[1].matchAll(ATTR)) {
    const [, name, quoted, braced] = attr;
    // A repeated attribute is ambiguous, not a last-one-wins situation.
    if (name in attributes) return null;
    attributes[name] = quoted ?? braced ?? '';
  }

  const names = Object.keys(attributes);
  if (names.length !== REQUIRED.length) return null;
  if (!REQUIRED.every((name) => name in attributes)) return null;

  // Dimensions are pixel counts. A non-integer would render as an invalid
  // attribute value and fail the HTML validator.
  for (const name of ['width', 'height']) {
    if (!/^[1-9][0-9]*$/.test(attributes[name].trim())) return null;
    attributes[name] = attributes[name].trim();
  }
  if (attributes.src.trim() === '' || attributes.poster.trim() === '') return null;

  return attributes;
}

/**
 * The HTML for one `<Video ... />` tag.
 *
 * @param {string} line A single line, already trimmed of surrounding whitespace.
 * @returns {string | null} The `<video>` element, or null when the line is not a
 *   `<Video />` tag this module rewrites.
 */
export function videoEmbedHtml(line) {
  const attributes = parseVideoTag(line);
  if (!attributes) return null;

  const src = escapeAttribute(attributes.src);
  const poster = escapeAttribute(attributes.poster);
  const width = escapeAttribute(attributes.width);
  const height = escapeAttribute(attributes.height);

  return (
    `<video controls muted playsinline preload="metadata"` +
    ` width="${width}" height="${height}" poster="${poster}">` +
    `<source src="${src}" type="video/mp4"></video>`
  );
}

/**
 * Rewrite every `<Video ... />` line in a markdown body. Used by the two agent
 * routes, which emit `article.body` verbatim and would otherwise hand an agent a
 * JSX tag no markdown reader understands.
 *
 * Line by line, so a tag inside a fenced code block is the one false positive
 * this can produce — a post that documents the tag has to indent it or split it
 * across lines. That is the same trade the rest of the body-level rewrites on
 * this site make, and it is cheaper than parsing the body twice.
 *
 * @param {string} body
 * @returns {string}
 */
export function rewriteVideoTags(body) {
  if (!body.includes('<Video')) return body;
  return body
    .split('\n')
    .map((line) => videoEmbedHtml(line.trim()) ?? line)
    .join('\n');
}

/**
 * The Sätteri mdast plugin the site's markdown pipeline runs. A block-level
 * `<Video ... />` line parses as a single `html` node, and the replacement goes
 * back as an `html` node so it reaches the output untouched.
 *
 * Typed against Sätteri's own definition, and type-only: this module is imported
 * by two routes that go into the Vercel function bundle, and a value import of
 * `satteri` would drag its native binding in with it.
 *
 * @type {import('satteri').MdastPluginDefinition}
 */
export const videoEmbedMdastPlugin = {
  name: 'video-embed',
  html(node, ctx) {
    const html = videoEmbedHtml(node.value.trim());
    if (html) ctx.replaceNode(node, { type: 'html', value: html });
  },
};
