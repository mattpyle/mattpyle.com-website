/**
 * Image addresses in the markdown an agent receives.
 *
 * A post writes an image as `![alt](../../assets/file.png)`, relative to its own
 * file under `src/content/`, so that Astro's image pipeline picks it up for the
 * HTML page. The routes that emit a body as markdown (src/pages/writing/[slug].md.ts,
 * src/pages/changelog/[slug].md.ts, src/pages/llms-full.txt.ts) would hand that
 * path to an agent as written, and from a served URL it resolves to nothing. This
 * module rewrites each such target to the address the build serves the file at.
 *
 * Pure: the caller passes `lookup`, which maps a repo-relative source path
 * (`src/assets/file.png`) to the built path (`/_astro/file.<hash>.png`). The
 * routes pass the map in src/lib/content-image-urls.ts; the tests and the build
 * validator pass their own. No `astro:` import here, so node can load it.
 *
 * What is rewritten: the target of an inline image, of a reference definition an
 * image uses, and of an HTML `<img src>`. Only relative targets. A site-absolute
 * path (`/images/x.png`), a URL with a scheme, and a fragment are left alone.
 * Alt text and titles are never touched: only the target's bytes change.
 *
 * What is skipped: anything inside a fenced code block or an inline code span.
 * An indented code block is not recognised, the same trade `rewriteVideoTags`
 * makes; a post that documents a relative image path fences it.
 */

import { posix } from 'node:path';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

// `![alt](target "title")`. Alt may hold escaped brackets and one level of
// nested brackets. The target is either `<in angle brackets>` or a run with no
// whitespace, and may hold balanced parentheses one level deep.
const INLINE_IMAGE =
  /!\[(?:[^\]\[\\]|\\.|\[(?:[^\]\[\\]|\\.)*\])*\]\(\s*(<[^<>\n]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/dg;
// `![alt][label]`, `![label][]` and `![label]`.
const REFERENCE_IMAGE = /!\[((?:[^\]\[\\]|\\.)*)\](?:\[((?:[^\]\[\\]|\\.)*)\])?(?!\()/g;
// `[label]: target`, at the start of a line.
const DEFINITION = /^ {0,3}\[((?:[^\]\[\\]|\\.)+)\]:[ \t]*(<[^<>\n]*>|\S+)/dgm;
// `<img ... src="target">`, either quote.
const HTML_IMAGE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/dgi;

/**
 * The character ranges of `body` that are code: fenced blocks, and inline code
 * spans in the text between them.
 *
 * @param {string} body
 * @returns {Array<[number, number]>}
 */
function codeRanges(body) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  /** @type {{ char: string, length: number, start: number } | null} */
  let fence = null;
  let textStart = 0;
  let offset = 0;

  /** @param {number} start @param {number} end */
  const scanText = (start, end) => {
    const text = body.slice(start, end);
    for (const match of text.matchAll(CODE_SPAN)) {
      ranges.push([start + match.index, start + match.index + match[0].length]);
    }
  };

  for (const line of body.split('\n')) {
    const lineEnd = offset + line.length;
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ''
      ) {
        ranges.push([fence.start, lineEnd]);
        fence = null;
        textStart = lineEnd;
      }
    } else if (fenceMatch) {
      scanText(textStart, offset);
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length, start: offset };
    }
    offset = lineEnd + 1;
  }
  // An unclosed fence runs to the end of the document.
  if (fence) ranges.push([fence.start, body.length]);
  else scanText(textStart, body.length);

  return ranges;
}

/** @param {string} label */
function normaliseLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * True for a target that only resolves beside its source file: no scheme, not
 * site-absolute, not protocol-relative, not a fragment.
 *
 * @param {string} target
 */
export function isRelativeTarget(target) {
  if (target === '') return false;
  if (target.startsWith('/') || target.startsWith('#')) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

/**
 * @typedef {object} ImageTarget
 * @property {number} start Index of the target's first character in the body.
 * @property {number} end Index after its last character.
 * @property {string} target The address as written, without angle brackets.
 * @property {'inline' | 'reference' | 'html'} kind
 * @property {number} line 1-based line of the target.
 */

/**
 * Every image target in a markdown body, outside code, in document order.
 *
 * @param {string} body
 * @returns {ImageTarget[]}
 */
export function findImageTargets(body) {
  const ranges = codeRanges(body);
  /** @param {number} index */
  const inCode = (index) => ranges.some(([start, end]) => index >= start && index < end);

  /** @type {ImageTarget[]} */
  const found = [];
  /** @param {[number, number]} span @param {ImageTarget['kind']} kind */
  const add = ([start, end], kind) => {
    let target = body.slice(start, end);
    if (kind !== 'html' && target.startsWith('<') && target.endsWith('>')) {
      start += 1;
      end -= 1;
      target = target.slice(1, -1);
    }
    found.push({ start, end, target, kind, line: body.slice(0, start).split('\n').length });
  };

  for (const match of body.matchAll(INLINE_IMAGE)) {
    if (inCode(match.index)) continue;
    add(/** @type {[number, number]} */ (match.indices?.[1]), 'inline');
  }

  const labels = new Set();
  for (const match of body.matchAll(REFERENCE_IMAGE)) {
    if (inCode(match.index)) continue;
    labels.add(normaliseLabel(match[2] ? match[2] : match[1]));
  }
  if (labels.size > 0) {
    for (const match of body.matchAll(DEFINITION)) {
      if (inCode(match.index) || !labels.has(normaliseLabel(match[1]))) continue;
      add(/** @type {[number, number]} */ (match.indices?.[2]), 'reference');
    }
  }

  for (const match of body.matchAll(HTML_IMAGE)) {
    if (inCode(match.index)) continue;
    const span = match.indices?.[1] ?? match.indices?.[2];
    add(/** @type {[number, number]} */ (span), 'html');
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * The repo-relative source path a relative target names, from the entry that
 * wrote it. `src/content/writing/post.md` + `../../assets/a.png` -> `src/assets/a.png`.
 *
 * @param {string} filePath The entry's path from the repo root, either separator.
 * @param {string} target
 */
export function sourcePathFor(filePath, target) {
  const clean = target.replace(/[?#].*$/, '');
  let decoded = clean;
  try {
    decoded = decodeURI(clean);
  } catch {
    // A stray `%` is a literal character in a file name, not an escape.
  }
  return posix.normalize(posix.join(posix.dirname(filePath.replaceAll('\\', '/')), decoded));
}

/**
 * Rewrite every relative image target in a markdown body to its public address.
 *
 * @param {string} body
 * @param {object} options
 * @param {string | undefined} options.filePath The entry's path from the repo root
 *   (`entry.filePath`). Relative targets resolve against its directory.
 * @param {(sourcePath: string) => string | undefined} options.lookup Built path
 *   (`/_astro/...`) for a repo-relative source path, or undefined.
 * @param {string} options.origin Site origin, no trailing slash.
 * @param {(problem: { target: string, line: number, sourcePath: string | null, filePath: string | undefined }) => void} [options.onUnresolved]
 *   Called for a relative target with no built address; the target is then left
 *   as written. Omitted, the helper throws, which is what a prerendered route
 *   wants: the build fails and names the entry.
 * @returns {string}
 */
export function rewriteImagePaths(body, { filePath, lookup, origin, onUnresolved }) {
  const targets = findImageTargets(body).filter((image) => isRelativeTarget(image.target));
  if (targets.length === 0) return body;

  let out = '';
  let cursor = 0;
  for (const image of targets) {
    const sourcePath = filePath ? sourcePathFor(filePath, image.target) : null;
    const built = sourcePath ? lookup(sourcePath) : undefined;
    if (!built) {
      const problem = { target: image.target, line: image.line, sourcePath, filePath };
      if (!onUnresolved) {
        throw new Error(
          `markdown-images: ${filePath ?? 'an entry with no file path'} body line ${image.line}: ` +
            `image "${image.target}" has no built address` +
            (sourcePath ? ` (looked for ${sourcePath} among the images under src/assets)` : '') +
            '. Put the file in src/assets/ and reference it relative to the entry.'
        );
      }
      onUnresolved(problem);
      continue;
    }
    const url = `${origin}${encodeURI(built)}`;
    out += body.slice(cursor, image.start) + url;
    cursor = image.end;
  }
  return out + body.slice(cursor);
}
