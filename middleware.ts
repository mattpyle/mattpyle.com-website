import { next } from '@vercel/functions';

// Vercel Routing Middleware — a platform-level primitive, distinct from Astro's own
// `astro:middleware`. It runs before cache/static-file serving, which is required here:
// /writing/<slug> is a prerendered static page, and Astro's own middleware (any mode)
// never runs against prerendered routes at all. The full trail is in the retired
// engineering log, docs/_archive/changelog-retired-2026-08-01.md.
//
// Both collections expose an on-demand `.md` sibling (writing/[slug].md.ts,
// changelog/[slug].md.ts) that this middleware proxies to on a genuine text/markdown
// preference. Purely-numeric changelog slugs (/changelog/2) are pagination index pages,
// not entries — excluded so they never proxy to a non-existent /changelog/2.md.
const NEGOTIABLE = [
  { section: 'writing', re: /^\/writing\/([^/.]+)\/?$/ },
  { section: 'changelog', re: /^\/changelog\/(?!\d+\/?$)([^/.]+)\/?$/ },
];

// Slugs that shipped publicly and then moved. Inbound links and cached RSS entries
// hold the old URL forever, so it 301s rather than 404s.
//
// This lives in the middleware, not vercel.json's `redirects`, because the middleware
// runs before the platform's routing rules: a config-level redirect would be shadowed
// for an `Accept: text/markdown` request, which reaches the negotiation below first
// and proxies to a `.md` route that no longer exists. That is the one request shape
// most likely to be held by an agent, so it is the one that must not 404. Keeping a
// single map here also keeps the two request shapes (page and `.md`) from drifting.
const RETIRED_WRITING_SLUGS: Record<string, string> = {
  'i-turned-on-a-screen-reader': 'accessibility-and-ai',
};

// Matches both shapes a retired writing URL arrives in: the page (with or without a
// trailing slash) and its `.md` sibling.
const RETIRABLE = /^\/writing\/([^/.]+?)(\.md)?\/?$/;

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

export default async function middleware(request: Request) {
  const url = new URL(request.url);

  // Retired slugs first: a moved URL redirects whatever the Accept header asks for.
  const retirable = url.pathname.match(RETIRABLE);
  if (retirable) {
    const target = RETIRED_WRITING_SLUGS[retirable[1]];
    if (target) {
      // Canonical shapes: the page carries a trailing slash, the markdown sibling
      // is an extension on a slash-less path.
      const location = retirable[2] ? `/writing/${target}.md` : `/writing/${target}/`;
      console.log(`[middleware] 301 ${url.pathname} -> ${location}`);
      return new Response(null, { status: 301, headers: { Location: location } });
    }
  }

  let section: string | undefined;
  let slug: string | undefined;
  for (const candidate of NEGOTIABLE) {
    const match = url.pathname.match(candidate.re);
    if (match) {
      section = candidate.section;
      slug = match[1];
      break;
    }
  }
  if (!section || !slug) return next();

  const accept = request.headers.get('accept');
  console.log(`[middleware] ${section} slug=${slug} accept="${accept ?? ''}"`);

  if (prefersMarkdown(accept)) {
    const target = new URL(url);
    target.pathname = `/${section}/${slug}.md`;
    console.log(`[middleware] proxying to "${target.toString()}"`);
    // NOT rewrite(): confirmed by direct testing that Astro's on-demand `_render`
    // function can't resolve a route when reached via any internal routing-layer
    // rewrite (tried both this platform's rewrite() and a plain vercel.json rewrite,
    // both 404 identically) — it only works for the literal, original top-level
    // request. Fetching the working URL and relaying its response sidesteps that
    // entirely, while still keeping the browser-visible URL unchanged.
    const upstream = await fetch(target, { headers: request.headers });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  }

  return next();
}

// Both collections expose the negotiated .md variant, so the middleware must run for
// both path prefixes. The handler self-filters (numeric changelog slugs and .md URLs
// fall through to next()), so matching the whole subtree is safe.
export const config = {
  matcher: ['/writing/:path*', '/changelog/:path*'],
};
