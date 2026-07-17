import { next, rewrite } from '@vercel/functions';

// Vercel Routing Middleware — a platform-level primitive, distinct from Astro's own
// `astro:middleware`. It runs before cache/static-file serving, which is required here:
// /writing/<slug> is a prerendered static page, and Astro's own middleware (any mode)
// never runs against prerendered routes at all. See changelog.md for the full trail.
const WRITING_SLUG_RE = /^\/writing\/([^/.]+)\/?$/;

interface MediaRange {
  type: string;
  q: number;
}

function parseAccept(header: string): MediaRange[] {
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

function matchesHtml(type: string): boolean {
  return type === 'text/html' || type === 'text/*' || type === '*/*';
}

// Real RFC 7231 q-value negotiation — not a substring match. A wildcard (`*/*`,
// `text/*`) never counts as requesting markdown on its own, so Googlebot and every
// normal crawler/browser always get HTML; only a literal `text/markdown` token can
// trigger it, and only when its q-value genuinely outranks whatever html resolves to.
function prefersMarkdown(acceptHeader: string | null): boolean {
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

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const match = url.pathname.match(WRITING_SLUG_RE);
  if (!match) return next();

  const accept = request.headers.get('accept');
  console.log(`[middleware] writing slug=${match[1]} accept="${accept ?? ''}"`);

  if (prefersMarkdown(accept)) {
    const target = new URL(url);
    target.pathname = `/writing/${match[1]}.md`;
    return rewrite(target);
  }

  return next();
}

export const config = {
  matcher: '/writing/:path*',
};
