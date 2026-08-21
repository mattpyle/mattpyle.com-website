import { next, waitUntil } from '@vercel/functions';
import { recordHit } from './src/lib/agent-hits.mjs';
import { formatLogLine, formatSurfaceLine, isAgentSurface } from './src/lib/agent-surfaces.mjs';
import { markdownSiblingFor, prefersMarkdown } from './src/lib/markdown-negotiation.mjs';
import { canonicalOnDemandPath } from './src/lib/on-demand-routes.mjs';
import { retiredUrlRedirect } from './src/lib/retired-urls.mjs';
import { trailingSlashRedirectFor } from './src/lib/trailing-slash.mjs';

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
//
// It also owns slash normalisation: a matched page path with no trailing slash 308s to the
// slash form, the canonical shape every canonical tag, sitemap entry, and internal link on
// the site already uses. That rule lives here rather than in vercel.json's `trailingSlash`
// for a measured reason — the platform's version runs BEFORE middleware, so it 308'd
// `Accept: text/markdown` requests instead of letting the negotiation below answer them,
// and it caught `POST /a2a` as well. Here the ordering is ours and the matcher bounds the
// blast radius. Measurements and the full reasoning: src/lib/trailing-slash.mjs.

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

// Fire-and-forget durable counting, in its own failure domain and its own try/catch.
//
// Two separate wrappers rather than one around both the log and the count, on purpose: the console
// line is the debugging view and the counter is the record, and a store outage must not be able to
// take the log line with it. `waitUntil` keeps the round trip off the response path entirely, and
// recordHit() already swallows everything it can; this catch covers the one gap that leaves, a
// throw raised before waitUntil is handed a promise.
function countHit(event: 'surface' | 'markdown', path: string, request: Request): void {
  try {
    waitUntil(recordHit({ event, path, ua: request.headers.get('user-agent') }));
  } catch {
    // Deliberately empty: observation is never worth a failed response.
  }
}

// The canonical page URL a markdown response points back at: trailing slash, absolute.
function canonicalPageUrl(url: URL): string {
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.origin}${pathname}`;
}

// The last thing every non-markdown request does: 308 to the slash form, or carry on.
//
// This is the single exit point for slash normalisation, and it is a function rather than an
// inline branch because it has to be reachable from two places — the ordinary path, and the
// fallback taken when a sibling was expected but the fetch missed. A page that fell back to
// HTML still owes the redirect.
//
// The query string rides along: /about?utm_source=x must not lose the parameter that a
// client-side analytics read is waiting for. The one case that deliberately drops a query is
// the on-demand canonicalisation at the top of the handler, which has already run by now.
function slashRedirectOrNext(url: URL): Response {
  const slashed = trailingSlashRedirectFor(url.pathname);
  if (!slashed) return next();
  const location = `${slashed}${url.search}`;
  console.log(`[middleware] 308 ${url.pathname}${url.search} -> ${location}`);
  return new Response(null, { status: 308, headers: { Location: location } });
}

export default async function middleware(request: Request) {
  const url = new URL(request.url);

  // Cache-key canonicalisation, before every other branch including the counting ones.
  //
  // On the on-demand routes the query string is part of the CDN cache key, so a unique value forces
  // a fresh render and a fresh store read for the cost of one request. Answering with a 308 means
  // the render only ever happens against a URL the cache already has (src/lib/on-demand-routes.mjs
  // has the measurement). It is first so a busted request is never counted: the follow-up canonical
  // request re-enters this function and gets counted normally, so a redirect costs a count rather
  // than inventing one.
  const canonical = canonicalOnDemandPath(url.pathname, url.search);
  if (canonical) {
    console.log(`[middleware] 308 ${url.pathname}${url.search} -> ${canonical}`);
    return new Response(null, { status: 308, headers: { Location: canonical } });
  }

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
    countHit('surface', url.pathname, request);
    return next();
  }

  // Retired URLs first: a moved URL redirects whatever the Accept header asks for.
  const retiredSection = retiredUrlRedirect(url.pathname);
  if (retiredSection) {
    console.log(`[middleware] 301 ${url.pathname} -> ${retiredSection}`);
    return new Response(null, { status: 301, headers: { Location: retiredSection } });
  }

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
  //
  // Both of these fall through to slashRedirectOrNext() rather than returning next()
  // directly, and that ordering is the point of this whole design: negotiation gets first
  // refusal on a request, and only what it declines can be redirected. A slash-less URL
  // asking for markdown is answered with markdown, never with a 308.
  const sibling = markdownSiblingFor(url.pathname);
  const accept = request.headers.get('accept');
  if (!sibling || !prefersMarkdown(accept)) return slashRedirectOrNext(url);

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
    const status = upstream.status;
    console.log(formatLogLine('markdown', { result: 'miss', path: url.pathname, sibling, status }));
    return slashRedirectOrNext(url);
  }

  // One line per served markdown response, so "does anything ever negotiate?" is a query
  // rather than an assumption. `hit`/`miss` is a `result=` field rather than a bare word after
  // the tag: nothing parses these lines today, so this is the cheap moment to take the shape
  // that a parser would want.
  console.log(formatLogLine('markdown', { result: 'hit', path: url.pathname, sibling, accept }));

  // Counted only past the upstream.ok check above, so the path is a page that exists. That is what
  // bounds this event class's key space to the site's own pages; the caps in counterPath() are the
  // second lock rather than the first.
  countHit('markdown', url.pathname, request);

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
// src/lib/markdown-negotiation.mjs. Section roots appear in both shapes, and since slash
// normalisation moved in here that is load-bearing rather than merely tolerant: the
// slash-less entry is the one that receives the 308 and the slash-less form is now the only
// way to reach it, so dropping either shape would silently remove a redirect. The handler
// self-filters — any `.md` URL and anything with an extension falls through — so matching
// whole subtrees is safe. Fronting every page with a function is the accepted cost of the
// no-whitelist rule; the pass-through design keeps it cheap.
//
// What is NOT here matters just as much now. `/a2a` and `/mcp` are absent on purpose: both are
// extension-less POST endpoints, so any slash rule that reached them would 308 a JSON-RPC call,
// and a client that does not follow redirects on POST would lose the endpoint. For `/a2a` that
// is the URL the Agent Card, agents.md, and the `_a2a._agents` DNS record all publish; for
// `/mcp` it is the URL `/.well-known/mcp-server` and the registry listing will publish, and an
// MCP client is the population least likely to re-issue a POST after a redirect. Leaving them
// unmatched is what keeps them answering at both shapes. Do not add either.
//
// That also settles where `/mcp` is registered: nowhere. ON_DEMAND_PATHS and AGENT_SURFACE_PATHS
// are both mirrored into the matcher by a test, so listing it in either would put it there by
// the back door. It needs neither — query-string canonicalisation exists to protect a cached
// render, and this route is a POST that is never cached; the agent-surface log exists to make a
// *static file* fetch visible, and this route is a function that logs its own line. The
// absent-from-matcher assertion in tests/trailing-slash.test.mjs is the registration.
//
// Then RETIRED_URL_MATCHER from src/lib/retired-urls.mjs: `/builds/:path*` and `/builds.md`,
// which are neither negotiable pages nor agent surfaces. They are the reach of the retired-URL
// redirect above — the section moved to /projects, and an unmatched old URL would 404 at the
// routing layer instead of 301ing. Treat them as permanent: nothing here measures when the old
// URLs stop being fetched.
//
// Then the agent-surface list from src/lib/agent-surfaces.mjs.
//
// Finally `/scorecard.md`, which is neither: it is in ON_DEMAND_PATHS in
// src/lib/on-demand-routes.mjs, and it is here purely so the query-string canonicalisation above
// can reach it. Nothing else in this function acts on it — a `.md` URL maps to no sibling, so it
// falls straight through to next().
export const config = {
  matcher: [
    '/',
    '/about',
    '/about/',
    '/scorecard',
    '/scorecard/',
    '/scorecard.md',
    '/steward',
    '/steward/',
    '/projects/:path*',
    '/builds/:path*',
    '/builds.md',
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
