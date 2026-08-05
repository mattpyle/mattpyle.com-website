import { next } from '@vercel/functions';
import { formatSurfaceLine, isAgentSurface } from './src/lib/agent-surfaces.mjs';
import { markdownSiblingFor, prefersMarkdown } from './src/lib/markdown-negotiation.mjs';

// Vercel Routing Middleware — a platform-level primitive, distinct from Astro's own
// `astro:middleware`. It runs before cache/static-file serving, which is required here:
// /writing/<slug> is a prerendered static page, and Astro's own middleware (any mode)
// never runs against prerendered routes at all. The full trail is in the retired
// engineering log, docs/_archive/changelog-retired-2026-08-01.md.
//
// Every page has a `.md` sibling at a URL derived from its own path (see
// src/lib/markdown-negotiation.mjs). The two entry collections answer theirs from an
// on-demand route (writing/[slug].md.ts, changelog/[slug].md.ts); every other page's is a
// file converted from the rendered HTML at build. This middleware does not know or care
// which: it derives the URL, fetches it, and falls back to HTML if it is not there. No
// manifest, so nothing to keep in sync and nothing to go stale.

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

// The canonical page URL a markdown response points back at: trailing slash, absolute.
function canonicalPageUrl(url: URL): string {
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.origin}${pathname}`;
}

export default async function middleware(request: Request) {
  const url = new URL(request.url);

  // Agent surfaces: observe and get out of the way. These paths are in the matcher purely so the
  // request reaches a function at all — every one of them is a static file, and a static fetch is
  // invisible in this plan's logs otherwise. No negotiation, no rewrite, no header touched; the
  // request continues to the routing layer byte-identical.
  //
  // Wrapped because these are the site's discovery documents: a bug in a logging line must never
  // be what breaks llms.txt. Anything thrown here is swallowed and the request passes through.
  if (isAgentSurface(url.pathname)) {
    try {
      console.log(
        formatSurfaceLine({
          path: url.pathname,
          ua: request.headers.get('user-agent'),
          accept: request.headers.get('accept'),
        })
      );
    } catch {
      // Deliberately empty: observation is never worth a failed response.
    }
    return next();
  }

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

  // A path that maps to no sibling is not negotiable — which includes every `.md` URL, so
  // the proxy fetch below re-enters this function once and falls straight through. That is
  // the recursion guard: it lives in the mapping, not in a flag on the request.
  const sibling = markdownSiblingFor(url.pathname);
  if (!sibling) return next();

  const accept = request.headers.get('accept');
  if (!prefersMarkdown(accept)) return next();

  const target = new URL(url);
  target.pathname = sibling;

  // NOT rewrite(): confirmed by direct testing that Astro's on-demand `_render`
  // function can't resolve a route when reached via any internal routing-layer
  // rewrite (tried both this platform's rewrite() and a plain vercel.json rewrite,
  // both 404 identically) — it only works for the literal, original top-level
  // request. Fetching the working URL and relaying its response sidesteps that
  // entirely, while still keeping the browser-visible URL unchanged.
  const upstream = await fetch(target, { headers: request.headers });

  // The fallback that makes a manifest unnecessary: no sibling, no negotiation, plain HTML.
  // It also masks a wholly broken emit step, which is what scripts/validate-markdown-siblings.mjs
  // exists to catch at build time.
  if (!upstream.ok) {
    console.log(`[markdown] miss path="${url.pathname}" sibling="${sibling}" status=${upstream.status}`);
    return next();
  }

  // One line per served markdown response, so "does anything ever negotiate?" is a query
  // rather than an assumption.
  console.log(`[markdown] hit path="${url.pathname}" sibling="${sibling}" accept="${accept ?? ''}"`);

  // Headers are built here rather than relayed. The curated siblings are function responses
  // and the converted ones are static files, and a static hit can carry a `content-encoding`
  // that would not survive being paired with an already-decoded body. Reading the body as
  // text and declaring the type outright makes both sources answer identically.
  const body = await upstream.text();
  const link = upstream.headers.get('link') ?? `<${canonicalPageUrl(url)}>; rel="canonical"`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Link: link,
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      Vary: 'Accept',
    },
  });
}

// Two lists concatenated, both kept literal because Vercel reads this matcher statically at
// build time and cannot evaluate an imported constant — so both have a copy elsewhere that a
// test diffs against this one. A path missing here fails in the worst direction: it just
// serves HTML, or goes unlogged, forever.
//
// First, every page path, mirroring NEGOTIABLE_PAGE_MATCHER in
// src/lib/markdown-negotiation.mjs. Section roots appear in both shapes because the site
// serves both (/about from the nav, /about/ as the canonical). The handler self-filters —
// any `.md` URL and anything with an extension falls through to next() — so matching whole
// subtrees is safe. Fronting every page with a function is the accepted cost of the
// no-whitelist rule; the pass-through design keeps it cheap.
//
// Then the agent-surface list from src/lib/agent-surfaces.mjs.
export const config = {
  matcher: [
    '/',
    '/about',
    '/about/',
    '/scorecard',
    '/scorecard/',
    '/builds/:path*',
    '/webmcp/:path*',
    '/writing/:path*',
    '/changelog/:path*',
    '/llms.txt',
    '/llms-full.txt',
    '/agents.md',
    '/robots.txt',
    '/webmcp/tools.json',
    '/webmcp/index.json',
    '/sitemap-index.xml',
    '/sitemap-0.xml',
    '/.well-known/:path*',
  ],
};
