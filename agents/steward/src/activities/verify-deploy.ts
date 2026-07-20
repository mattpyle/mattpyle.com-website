// pino via lib/logger, not `@temporalio/activity`'s `log`: the latter requires
// an activity context, which makes the activity untestable as a plain function
// — and these activities are unit-tested directly against a mock origin.
import { log } from '../lib/logger.js';
import { PROD_ORIGIN, urlPathFor, type Collection } from '../config.js';

/**
 * One row of the deploy verification matrix (spec §8.8), as recorded on the
 * report.
 */
export interface VerificationRow {
  check: string;
  url: string;
  ok: boolean;
  detail: string;
}

export interface VerifyDeployInput {
  slug: string;
  collection?: Collection;
  /**
   * The published post's title, used for the "the page actually renders this
   * post" assertion.
   *
   * Passed in rather than re-read from disk because by this point the only
   * trustworthy copy is the one on the origin, and the activity must not form an
   * opinion from the local checkout (design rule 7 — the live origin is the only
   * trusted verifier). `publishPost` returns it for exactly this handoff.
   */
  title: string;
  /** Overridden by tests to point the matrix at a local mock server. */
  origin?: string;
}

export interface VerifyDeployResult {
  deployVerified: boolean;
  verification: VerificationRow[];
}

/** A check the matrix will run. `run` is given a fetch-like function. */
interface PlannedCheck {
  check: string;
  url: string;
  run(fetchImpl: typeof fetch): Promise<{ ok: boolean; detail: string }>;
}

function contentType(res: Response): string {
  return (res.headers.get('content-type') ?? '').toLowerCase();
}

/**
 * Builds the per-collection verification matrix.
 *
 * **Exported and pure so the matrix itself is testable**, independently of
 * whether the network cooperates. The rows differ by collection, and getting
 * that wrong is not a cosmetic error — see the RSS note below.
 */
export function buildVerificationPlan(
  slug: string,
  collection: Collection,
  origin: string,
  title: string,
): PlannedCheck[] {
  const base = origin.replace(/\/+$/, '');
  const canonicalPath = urlPathFor(slug, collection); // "/writing/<slug>/"
  const canonicalUrl = `${base}${canonicalPath}`;
  const mdUrl = `${base}/${collection}/${slug}.md`;

  const checks: PlannedCheck[] = [
    {
      check: 'html',
      url: canonicalUrl,
      async run(f) {
        const res = await f(canonicalUrl);
        if (res.status !== 200) return { ok: false, detail: `expected 200, got ${res.status}` };
        const ct = contentType(res);
        if (!ct.includes('text/html')) return { ok: false, detail: `content-type is "${ct}"` };
        const body = await res.text();
        if (!body.includes(title)) {
          return { ok: false, detail: `200 text/html, but the body does not contain the title "${title}"` };
        }
        return { ok: true, detail: `200 text/html, title present` };
      },
    },
    {
      // The negotiated markdown variant. `middleware.ts` proxies a genuine
      // `Accept: text/markdown` preference on the canonical URL to the `.md`
      // sibling. Both collections are wired for this, and CLAUDE.md documents
      // the wiring as easy to miss — which is precisely why it is asserted.
      check: 'markdown-negotiated',
      url: canonicalUrl,
      async run(f) {
        const res = await f(canonicalUrl, { headers: { Accept: 'text/markdown' } });
        if (res.status !== 200) return { ok: false, detail: `expected 200, got ${res.status}` };
        const vary = res.headers.get('vary') ?? '';
        if (!/accept/i.test(vary)) {
          return {
            ok: false,
            detail: `Vary header is "${vary}" — must include Accept, or the edge cache will serve HTML and markdown interchangeably`,
          };
        }
        const body = await res.text();
        if (!body.startsWith('---')) {
          return { ok: false, detail: `body does not start with frontmatter (got "${body.slice(0, 40)}…")` };
        }
        return { ok: true, detail: '200, Vary: Accept present, frontmatter body' };
      },
    },
    {
      check: 'markdown-direct',
      url: mdUrl,
      async run(f) {
        const res = await f(mdUrl);
        if (res.status !== 200) return { ok: false, detail: `expected 200, got ${res.status}` };
        const body = await res.text();
        if (!body.startsWith('---')) {
          return { ok: false, detail: `body does not start with frontmatter (got "${body.slice(0, 40)}…")` };
        }
        return { ok: true, detail: '200, frontmatter body' };
      },
    },
    {
      check: 'llms.txt',
      url: `${base}/llms.txt`,
      async run(f) {
        const res = await f(`${base}/llms.txt`);
        if (res.status !== 200) return { ok: false, detail: `expected 200, got ${res.status}` };
        const body = await res.text();
        return body.includes(slug)
          ? { ok: true, detail: 'slug present' }
          : { ok: false, detail: `200, but the slug "${slug}" is absent` };
      },
    },
    {
      check: 'sitemap',
      url: `${base}/sitemap-index.xml`,
      async run(f) {
        const idxRes = await f(`${base}/sitemap-index.xml`);
        if (idxRes.status !== 200) {
          return { ok: false, detail: `sitemap-index.xml: expected 200, got ${idxRes.status}` };
        }
        const idx = await idxRes.text();
        const locs = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
        if (locs.length === 0) return { ok: false, detail: 'sitemap-index.xml referenced no sitemaps' };
        for (const loc of locs) {
          const subRes = await f(loc);
          if (subRes.status !== 200) continue;
          const sub = await subRes.text();
          if (sub.includes(canonicalUrl)) {
            return { ok: true, detail: `canonical URL present in ${loc}` };
          }
        }
        return {
          ok: false,
          detail: `canonical URL ${canonicalUrl} not found in any of ${locs.length} referenced sitemap(s)`,
        };
      },
    },
    {
      check: 'og-image',
      url: `${base}/og/${collection}/${slug}.png`,
      async run(f) {
        const url = `${base}/og/${collection}/${slug}.png`;
        const res = await f(url);
        if (res.status !== 200) return { ok: false, detail: `expected 200, got ${res.status}` };
        const ct = contentType(res);
        return ct.includes('image/png')
          ? { ok: true, detail: '200 image/png' }
          : { ok: false, detail: `content-type is "${ct}", expected image/png` };
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // RSS is a WRITING-ONLY row, and this is a correctness rule, not a nicety.
  //
  // `src/pages/rss.xml.ts` calls `getCollection('writing')` and nothing else:
  // the feed is published writing, not site-change notifications. Spec §8.8's
  // original matrix asserted `GET /rss.xml` contains the slug unconditionally.
  // Run against a changelog entry that row would fail forever — and *correctly*,
  // which is the dangerous part: the retry loop would sleep and retry ten times
  // against a condition the site is never going to satisfy, and then park the
  // review claiming the deploy had not propagated. A permanently-failing check
  // is worse than a missing one, because it looks like a transient failure.
  //
  // Established from the surfaces table in the Prompt 3b build log, which was
  // built by reading the generators rather than assuming parity between the two
  // collections.
  // ---------------------------------------------------------------------------
  if (collection === 'writing') {
    checks.push({
      check: 'rss',
      url: `${base}/rss.xml`,
      async run(f) {
        const res = await f(`${base}/rss.xml`);
        if (res.status !== 200) return { ok: false, detail: `expected 200, got ${res.status}` };
        const body = await res.text();
        return body.includes(slug)
          ? { ok: true, detail: 'slug present' }
          : { ok: false, detail: `200, but the slug "${slug}" is absent` };
      },
    });
  }

  return checks;
}

/**
 * `verifyDeploy` (spec §8.8) — the curl matrix against the live origin.
 *
 * Design rule 7: local builds and green tests do not count. This activity is
 * the only thing that may declare a publish complete.
 *
 * **Returns a result; it does not throw on a failed row.** A page that is not
 * live yet is the *expected* state immediately after a PR opens — the human has
 * not merged, or Vercel has not finished building. Failure here is data for the
 * workflow's sleep/retry loop (spec §7.3 step 5), not an activity error. The
 * activity throws only when it could not perform the check at all.
 */
export async function verifyDeploy(input: VerifyDeployInput): Promise<VerifyDeployResult> {
  const collection = input.collection ?? 'writing';
  const origin = input.origin ?? PROD_ORIGIN;
  const plan = buildVerificationPlan(input.slug, collection, origin, input.title);

  const verification: VerificationRow[] = [];
  for (const planned of plan) {
    try {
      const { ok, detail } = await planned.run(fetch);
      verification.push({ check: planned.check, url: planned.url, ok, detail });
    } catch (err) {
      // A network-level error is still a row, not an activity failure: "the
      // origin refused the connection" is exactly what a mid-deploy site does.
      verification.push({
        check: planned.check,
        url: planned.url,
        ok: false,
        detail: `request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const deployVerified = verification.every((r) => r.ok);
  log.info(
    {
      activity: 'verifyDeploy',
      slug: input.slug,
      collection,
      deployVerified,
      failed: verification.filter((r) => !r.ok).map((r) => r.check),
    },
    'verifyDeploy complete',
  );

  return { deployVerified, verification };
}
