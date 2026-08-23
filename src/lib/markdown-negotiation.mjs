// The rules behind site-wide `Accept: text/markdown` negotiation, in one place so the
// middleware, the build-time emit step, the coverage validator and the tests all agree.
//
// Shape of the feature: every HTML page has a `.md` sibling at a URL derived purely from
// its own path. Entry pages keep their curated siblings (src/pages/writing/[slug].md.ts,
// src/pages/changelog/[slug].md.ts); every other page gets one converted at build from
// the rendered HTML. The middleware never consults a manifest — it derives the sibling
// URL, fetches it, and falls back to HTML if it 404s.

/** @typedef {{ type: string, q: number }} MediaRange */

/** @param {string} header @returns {MediaRange[]} */
export function parseAccept(header) {
  return header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawType, ...params] = part.split(';').map((piece) => piece.trim());
      let q = 1;
      for (const param of params) {
        const [key, value] = param.split('=').map((piece) => piece.trim());
        if (key === 'q') {
          const parsed = Number.parseFloat(value);
          if (Number.isFinite(parsed)) q = parsed;
        }
      }
      return { type: rawType.toLowerCase(), q };
    });
}

/** @param {string} type */
function matchesHtml(type) {
  return type === 'text/html' || type === 'text/*' || type === '*/*';
}

// Real RFC 7231 q-value negotiation — not a substring match. A wildcard (`*/*`,
// `text/*`) never counts as requesting markdown on its own, so Googlebot and every
// normal crawler/browser always get HTML; only a literal `text/markdown` token can
// trigger it, and only when its q-value genuinely outranks whatever html resolves to.
/** @param {string | null} acceptHeader */
export function prefersMarkdown(acceptHeader) {
  if (!acceptHeader) return false;
  const ranges = parseAccept(acceptHeader);

  const markdownRange = ranges.find((range) => range.type === 'text/markdown');
  if (!markdownRange || markdownRange.q <= 0) return false;

  const htmlQ = ranges
    .filter((range) => matchesHtml(range.type) && range.q > 0)
    .reduce((best, range) => Math.max(best, range.q), -1);

  if (htmlQ < 0) return true; // html not accepted at all — never 406, serve what was asked for
  return markdownRange.q > htmlQ; // must genuinely outrank; ties favor html
}

// One rule, no whitelist: strip the trailing slash and append `.md`; the root becomes
// /index.md. It lands exactly on the curated routes (/writing/<slug>/ -> /writing/<slug>.md)
// without a special case, and the index pages sit one level up from them
// (/writing/ -> /writing.md), so nothing collides.
//
// A path whose last segment already carries an extension is never negotiable. That is what
// stops the middleware's proxy fetch from recursing: the fetch targets a `.md` URL, which
// maps to null, which falls through to the routing layer.
/** @param {string} pathname @returns {string | null} */
export function markdownSiblingFor(pathname) {
  if (!pathname.startsWith('/')) return null;
  if (pathname === '/') return '/index.md';

  const withoutTrailingSlash = pathname.replace(/\/+$/, '');
  const lastSegment = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf('/') + 1);
  if (!lastSegment || lastSegment.includes('.')) return null;

  return `${withoutTrailingSlash}.md`;
}

// The sibling URLs answered by an on-demand curated route rather than by a converted file.
// Purely-numeric changelog slugs are pagination index pages, not entries, so they convert
// like any other page. Only the emit step and the coverage validator read this; the
// middleware deliberately does not, because its 404 fallback is the safety net.
//
// /activity.md is here for a different reason from the other two. Those are entries whose source
// markdown beats anything a converter could produce; /activity renders on demand (it reads the hit
// store at request time), so there is no built HTML file for the emit step to convert and a
// curated route is the only way it can have a sibling at all.
//
// /scorecard.md held this slot until 2026-08-22 and no longer does: the store read moved to
// /activity, /scorecard went back to prerendering, and its sibling is an ordinary converted file
// again. The exception follows the store read, not the page.
const CURATED_SIBLINGS = [
  /^\/writing\/[^/]+\.md$/,
  /^\/changelog\/(?!\d+\.md$)[^/]+\.md$/,
  /^\/activity\.md$/,
];

/** @param {string} siblingPath @returns {boolean} */
export function hasCuratedSibling(siblingPath) {
  return CURATED_SIBLINGS.some((re) => re.test(siblingPath));
}

// The page paths that must reach the middleware for negotiation to happen at all. Vercel
// reads middleware.ts's `config.matcher` statically at build time and cannot evaluate an
// imported constant, so the literal list lives there and this copy exists to be diffed
// against it by tests/markdown-negotiation.test.mjs. A path missing from the matcher fails
// in the worst direction: the page just quietly serves HTML forever.
//
// Section roots appear in both shapes because the site serves both: the nav links to
// /about, the canonical is /about/.
export const NEGOTIABLE_PAGE_MATCHER = [
  '/',
  '/about',
  '/about/',
  '/activity',
  '/activity/',
  '/scorecard',
  '/scorecard/',
  '/steward',
  '/steward/',
  '/projects/:path*',
  '/webmcp/:path*',
  '/writing/:path*',
  '/changelog/:path*',
];
