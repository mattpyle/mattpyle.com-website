import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** agents/steward */
export const STEWARD_DIR = path.resolve(here, '..');

/**
 * Loads `agents/steward/.env` into `process.env`.
 *
 * Hand-rolled rather than pulling in `dotenv`: the file holds a handful of
 * `KEY=value` lines and the parsing rules that matter here fit in ten lines.
 *
 * **Already-set variables always win.** An explicit `ANTHROPIC_API_KEY=... npm
 * run …` or a CI secret must not be silently overridden by a stale local file —
 * that failure mode is invisible and sends requests under the wrong credential.
 *
 * Values are never logged. The file is gitignored (`.gitignore`), and nothing in
 * Steward puts a secret into a workflow input or result, where Temporal
 * would persist it in history (spec §13).
 */
function loadDotEnv(): void {
  const envPath = path.join(STEWARD_DIR, '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // No .env is fine — the real environment may already carry the vars.
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

/**
 * The real checkout containing `agents/steward`, derived from this file's own
 * location and therefore **never** affected by `STEWARD_SITE_DIR`.
 *
 * Steward's own artifacts — `reviews/`, caches, the Vale binary — always live
 * under `STEWARD_DIR`, no matter which content tree is being reviewed. Anchoring
 * their paths here rather than on `SITE_DIR` is what keeps them findable when the
 * site root is redirected (Phase 1b shipped a `readArchivedReport` that joined an
 * archive path onto `SITE_DIR` and silently rendered no findings under
 * redirection — that coupling is the bug this constant exists to prevent).
 */
export const REPO_ROOT = path.resolve(STEWARD_DIR, '..', '..');

/** The content tree under review. Overridable so tests/CI can point elsewhere. */
export const SITE_DIR = process.env.STEWARD_SITE_DIR
  ? path.resolve(process.env.STEWARD_SITE_DIR)
  : REPO_ROOT;

export const WORKTREE_DIR =
  process.env.STEWARD_WORKTREE_DIR ??
  path.resolve(SITE_DIR, '..', 'mattpyle.com-steward-worktree');

export const PROD_ORIGIN = process.env.STEWARD_PROD_ORIGIN ?? 'https://www.mattpyle.com';

/**
 * The sitemap URL `resolveAuditUrls` fetches at run time (scorecard-audit-spec.md
 * §5.4). **Not** a canonical page list — the sitemap itself is the source of
 * truth for "what pages are live". This constant is a CLI-resolved default,
 * consumed by the workflow only via the input (design rule 3): a decision the
 * workflow re-read from here at replay would rewrite the past for any run
 * still in flight.
 */
export const SITEMAP_URL = `${PROD_ORIGIN}/sitemap-index.xml`;

/**
 * Used only for `--urls` overrides and offline tests — never a fallback the
 * workflow reaches for on its own. The live audit set always comes from the
 * sitemap; this exists so a manual run or a test can skip the network fetch.
 *
 * **Trailing slashes, because the site's canonical page shape has them**
 * (`build.format: 'directory'`, and `middleware.ts` 308s the slash-less form).
 * They were missing until 2026-08-15. Nothing was measuring a redirect, because
 * nothing imports this — it is specified in `scorecard-audit-spec.md` §5.4 and
 * has never had a caller — but a slash-less list here is a list that would
 * quietly audit six redirects the first time somebody reached for it.
 */
export const SCORECARD_URLS_FALLBACK = [
  '/',
  '/about/',
  '/writing/',
  '/projects/',
  '/changelog/',
  '/scorecard/',
] as const;

/** Default staleness threshold for the publish gate (spec §6), CLI-overridable via `--max-age-days`. */
export const SCORECARD_MAX_AGE_DAYS_DEFAULT = 7;

/**
 * The IANA timezone a scorecard run's calendar date (`iso`) is computed in
 * (spec §5.1). Matt is based in the Pacific timezone, so a run kicked off
 * after ~5pm Pacific dates itself the *next* UTC calendar day if left to
 * `new Date().toISOString()` — this is the fix for that. Resolved once, in
 * `resolveRunStamp`, an activity (not read inline in the workflow) so the
 * result is durable in history and replay-safe.
 */
export const STEWARD_TIMEZONE = process.env.STEWARD_TIMEZONE ?? 'America/Vancouver';

/** Repo-relative path to the public run-log (spec §5.1). */
export const SCORECARD_RUNS_PATH = 'src/data/scorecard-runs.json';

export const GITHUB_REPO = process.env.STEWARD_GITHUB_REPO ?? 'mattpyle/mattpyle.com-website';

/**
 * Where run-health signals are sent: the project ping base of the external
 * dead-man's-switch service, e.g. `https://hc-ping.com/<ping-key>`.
 *
 * **One value for every signal.** `lib/run-health.ts` appends a per-check slug,
 * so a new signal is a code constant rather than another variable to set in two
 * places and forget in one. Unset means alerting is off, which is the state of a
 * fresh clone and of every test process, and every send path treats it as a
 * no-op rather than an error (`lib/health-ping.ts`).
 *
 * Configuration, not a secret in the sense the other three are — but it is still
 * read from the environment at execution time inside an activity and never put
 * into a workflow input, because a URL frozen into history is a URL that cannot
 * be changed for runs already open (spec §13).
 */
export const HEALTHCHECK_BASE = (process.env.STEWARD_HEALTHCHECK_BASE ?? '').replace(/\/+$/, '');

export const MODEL = process.env.STEWARD_MODEL ?? 'claude-sonnet-4-6';

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
export const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';

/**
 * The Temporal Cloud API key, read from `agents/steward/.env` and nowhere else.
 *
 * Never logged, never put into a workflow input or result, and never passed as
 * an argv — the same rule the other two secrets in that file follow (spec §13).
 */
const TEMPORAL_API_KEY = process.env.TEMPORAL_API_KEY ?? '';

/**
 * Which service Steward talks to. The API key is the switch: Cloud refuses an
 * unauthenticated connection, and the local dev server has no use for one, so
 * "a key is present" and "we mean Cloud" are the same condition. Address and
 * namespace alone cannot decide it — both have local defaults that a Cloud
 * setup also has to override, so keying off either would make a half-configured
 * environment look like a complete one.
 */
export const IS_TEMPORAL_CLOUD = TEMPORAL_API_KEY !== '';

/** Loopback forms the dev server binds. Anything else is a remote service. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackAddress(address: string): boolean {
  const host = address.startsWith('[')
    ? address.slice(0, address.indexOf(']') + 1)
    : address.split(':')[0];
  return LOOPBACK_HOSTS.has(host);
}

/**
 * The one connection shape both the client (`@temporalio/client`) and the
 * worker (`@temporalio/worker`) build from, so the two can never drift into
 * talking to different services. Structural, with no `@temporalio` import: this
 * module is on the import path of surfaces that must not pull the SDK in.
 *
 * `metadata['temporal-namespace']` is redundant against the namespace endpoint
 * but not free to omit: API-key auth against a regional endpoint fails with a
 * bare `Request unauthorized` without it, and that error names nothing useful.
 * Sending it always costs one header and removes a failure mode that a future
 * endpoint change would otherwise reintroduce.
 */
export interface TemporalConnectionOptions {
  address: string;
  tls?: boolean;
  apiKey?: string;
  metadata?: Record<string, string>;
}

/**
 * The decision itself, taking its three inputs as arguments rather than reading
 * the module's constants, so it is testable without a child process: the
 * constants above are resolved once at import and cannot be re-read per case.
 */
export function resolveTemporalConnection(
  address: string,
  namespace: string,
  apiKey: string,
): TemporalConnectionOptions {
  if (apiKey === '') {
    if (!isLoopbackAddress(address)) {
      throw new Error(
        `TEMPORAL_ADDRESS is ${address}, which is not the local dev server, but TEMPORAL_API_KEY ` +
          'is unset. Set the key in agents/steward/.env, or point the address back at ' +
          'localhost:7233. Connecting to a remote service without credentials fails later with ' +
          'an error that names neither cause.',
      );
    }
    return { address };
  }
  return {
    address,
    tls: true,
    apiKey,
    metadata: { 'temporal-namespace': namespace },
  };
}

/** The live connection options for this process. */
export function temporalConnectionOptions(): TemporalConnectionOptions {
  return resolveTemporalConnection(TEMPORAL_ADDRESS, NAMESPACE, TEMPORAL_API_KEY);
}

export const QUEUE_LIGHT = 'steward-light';
export const QUEUE_HEAVY = 'steward-heavy';

/**
 * The agent-readiness audit's own queue (always-on-audit-worker card).
 *
 * The split is by **locality**, which is what task queues are for. `reviewPost`
 * reads drafts out of the working copy and applies patches to local files, and
 * the scorecard's publish leg drives git in a local worktree, so their workers
 * have to be where those files are — they stay on `steward-light` and
 * `steward-heavy`. `auditSiteWorkflow` touches nothing local: it fetches a
 * stranger's origin and renders a stranger's pages. Putting it on a queue of its
 * own is what lets one hosted worker poll that queue alone, so a deep audit
 * finishes without Matt's desktop being on.
 *
 * A Chrome-capable image is therefore this queue's requirement, not the light
 * queue's, and the hosted worker's set of registered activities is exactly the
 * ones `workflows/audit-site.ts` names.
 */
export { AUDIT_TASK_QUEUE as QUEUE_AUDIT } from './lib/agent-audit/deep-contract.js';

/**
 * How many activities the **hosted** worker runs at once. One, and it is a
 * correctness rule rather than a tuning preference.
 *
 * Lighthouse is not safe to run twice in one Node process: `marky`, the timing
 * library `lighthouse-logger` uses, keys its marks off Node's *global*
 * `performance.mark`/`measure` namespace, so two concurrent runs corrupt each
 * other's marks. That failed 100% of render activities at concurrency 2 in Phase
 * 1.5/1.6, and `scorecard-audit.ts`'s `AUDIT_CONCURRENCY` docblock is where the
 * evidence lives. That constant serialises the pages *inside one workflow*;
 * nothing serialised anything *across* workflows until this option existed, so
 * two workflows could do what one workflow is forbidden to do. Measured twice on
 * 2026-08-15 while verifying the public deep tier: two deep audits started
 * seconds apart through `/mcp` both rendered at once.
 *
 * **The accepted cost.** This is a worker-wide cap, so every activity on
 * `steward-audit` serialises — one run's cheap fetch checks can wait behind
 * another run's 90-second page render. That wait is honest to callers rather
 * than hidden: `get_audit` answers `queued: true` with a queue position for a run
 * nothing has picked up (`src/lib/mcp-temporal.mjs`), which is exactly this
 * state. Per-activity-type limits or a browser-only queue stay out until queue
 * depth argues for them, which is also the signal for a second replica.
 *
 * Not env-configurable on purpose. An operator raising this from a dashboard
 * field would not be tuning throughput, they would be turning the render
 * activities off, and the failure reads as a wedged Chrome rather than as a
 * setting.
 *
 * Only the hosted worker sets it. `worker.ts` on the laptop is unchanged and
 * operator-attended; its cross-workflow contention is pre-existing and out of
 * scope here.
 */
export const HOSTED_ACTIVITY_CONCURRENCY = 1;

/**
 * The exact line the worker logs once both queues are polling. `steward up`
 * health-gates on this string (lib/stack.ts), so the worker and the stack share
 * this one constant — a reworded log line can no longer silently break startup.
 */
export const WORKER_READY_LOG = 'steward worker polling';

/**
 * The review archive — a dataset, not a scratch directory. Overridable so tests
 * that archive reports write into a temp dir instead of contaminating the real
 * one (Phase 1c: `reviews/archive-test/` was showing up as untracked junk in the
 * dataset after every test run). Production never sets this.
 */
export const REVIEWS_DIR = process.env.STEWARD_REVIEWS_DIR
  ? path.resolve(process.env.STEWARD_REVIEWS_DIR)
  : path.join(STEWARD_DIR, 'reviews');

/**
 * Where a review of an **unpublished** post is archived: gitignored, and never
 * one `git add -A` from public history.
 *
 * A review file quotes the post line by line — `excerpt` fields, the Vale hits,
 * the editorial critique. For a `draft: true` post that is unpublished writing
 * plus its criticism, and committing it publishes both before the author chose
 * to. Git history has the same property the site's draft rules already respect
 * for RSS: what is pushed cannot be recalled.
 *
 * So the archive is split by the post's own draft flag rather than by anything
 * about the review (`archiveReport`, and {@link REVIEWS_DIR} for the published
 * half). A held review moves into the public dataset when the post ships —
 * `promoteReviews` in `lib/promote-reviews.ts`, run by `steward cleanup` and by
 * `steward promote-reviews`.
 *
 * Derived from `REVIEWS_DIR` rather than given its own env var, so the one
 * `STEWARD_REVIEWS_DIR` override tests already use redirects **both** halves of
 * the archive into the temp directory. A test that redirected only one of them
 * would write real draft reviews into the real holding path. Derived from the
 * basename, not just the parent, so two tests with different temp roots do not
 * share a holding directory.
 *
 * Production: `agents/steward/.reviews-drafts/`.
 */
export const DRAFT_REVIEWS_DIR = path.join(
  path.dirname(REVIEWS_DIR),
  `.${path.basename(REVIEWS_DIR)}-drafts`,
);

/**
 * Where full per-run Scorecard records (including per-page raw scores) are
 * archived (spec §5.2) — a sibling of the review archive, same dataset
 * convention: committed on purpose, not scratch (spec §11).
 */
export const SCORECARD_ARCHIVE_DIR = path.join(REVIEWS_DIR, '_scorecard');

/**
 * The same directory as {@link SCORECARD_ARCHIVE_DIR}, addressed the way GitHub
 * addresses it: repo-relative, forward slashes, no host filesystem involved.
 *
 * Two constants rather than one derived from the other because they are not the
 * same fact. `SCORECARD_ARCHIVE_DIR` answers "where does this machine keep the
 * archive", follows `STEWARD_REVIEWS_DIR` into a temp directory under test, and
 * is meaningless in a container with no checkout. This answers "where does the
 * archive live in the repository", which is fixed for every reader and every
 * writer, and is what `archiveScorecardRun` commits against now that it writes
 * through the GitHub API instead of the filesystem.
 */
export const SCORECARD_ARCHIVE_REL = 'agents/steward/reviews/_scorecard';

/**
 * The standing branch `archiveScorecardRun` appends to.
 *
 * One long-lived branch and one long-lived PR, not one per run, and that split
 * is the point: the run-log PR appearing *means something changed* (spec §6),
 * and it would stop meaning that if every no-op night opened one too. The
 * archive is written on every execution including no-ops (spec §5.2), so it
 * needs somewhere to accumulate that carries no signal. Matt merges it whenever.
 */
export const SCORECARD_ARCHIVE_BRANCH = 'steward/scorecard-archive';

/**
 * Where `steward audit-url` writes its two artifacts by default.
 *
 * Under `.cache/`, which is gitignored — deliberately **not** a sibling of
 * `reviews/_scorecard/`, which is committed. The scorecard is this site's own
 * conformance record and belongs in the repo; an audit of somebody else's site
 * is a report about a third party, and a default that quietly stages it for
 * commit is the wrong default. Pass `--json`/`--out` to put one anywhere.
 */
export const AUDIT_OUT_DIR = path.join(STEWARD_DIR, '.cache', 'audits');

/**
 * The shared spelling dictionary, at the REPO ROOT — not under `agents/steward`.
 *
 * One file, two consumers: this activity and the site's `npm run spellcheck`
 * (which reaches it via `import` in `cspell.json`). It moved out of Steward's
 * workspace in Phase 2 Part A, when the publish leg made a divergence between
 * the two dictionaries able to publish a post the site's own CI marks red.
 *
 * **Read directly, not via `import:`.** `readConfigFile` does NOT resolve
 * cspell's `import` key — a config that imports its wordlist comes back with
 * `words: undefined`. Pointing this at a thin config that imports the shared
 * file would empty Steward's dictionary. Verified empirically; it is why
 * the shared file holds the words inline and this constant names it directly.
 *
 * Overridable for the same reason as REVIEWS_DIR above, and one more: `node
 * --test` runs test *files* in parallel processes, so `dictionary.test.ts`
 * writing this file raced `cspell.test.ts` reading it, and the reader caught it
 * mid-write with an empty wordlist (card: cspell-test-isolation-flake). The
 * writing tests point this at a temp copy instead. Production never sets it.
 */
export const CSPELL_CONFIG = process.env.STEWARD_CSPELL_CONFIG
  ? path.resolve(process.env.STEWARD_CSPELL_CONFIG)
  : path.join(REPO_ROOT, 'cspell.shared.yaml');
export const RUBRICS_DIR = path.join(STEWARD_DIR, 'src', 'rubrics');

/**
 * Where a workflow deep-link points. Both UIs take the same
 * `/namespaces/<ns>/workflows/<id>` path, so only the origin moves — a link
 * built against the wrong one is a 404 rather than a wrong workflow.
 */
export const WEB_UI = IS_TEMPORAL_CLOUD ? 'https://cloud.temporal.io' : 'http://localhost:8233';

/**
 * Phase gates (spec §12). Every incomplete surface is off, so each phase ships
 * in a working state rather than a half-wired one.
 */
export const ENABLE_AI_TELLS = false;
/**
 * The deterministic tell citations (§8.6b) — the free half of what
 * `ENABLE_AI_TELLS` used to gate as one lump.
 *
 * **On, and reachable with no flag.** The counters are code, cost nothing, and
 * cite the line they fired on, so a wrong one is disproved in two seconds. The
 * composite `aiLikenessScore` is the part that failed validation (§9.2), and it
 * stays behind `--ai-tells` with the warning attached to it. Keeping one switch
 * over both is what created the deadlock the re-validation has sat in since
 * 2026-07-21: it needs archived corpus data and the switch produced none.
 *
 * Resolved by the CLI into the workflow **input**, never read in the workflow —
 * design rule 10. It decides whether an activity runs.
 */
export const ENABLE_TELL_CITATIONS = true;
export const ENABLE_BUILD_AUDIT = true;
/**
 * The worked-alternatives pass over Vale's E-Prime instances (§8.6).
 *
 * **On by default, and deliberately not gated behind `--ai-tells`.** That flag
 * guards a scorer whose pre-registered validation study failed; this is a
 * different feature with a different purpose, and tying them together would make
 * turning one off turn the other off too.
 *
 * Off costs nothing to reach for: a post with no E-Prime findings skips the pass
 * without an API call regardless of this constant, so this exists for the case
 * where the pass itself turns out to be unwanted rather than as a cost control.
 *
 * Resolved by the CLI into the workflow **input**, never read in the workflow —
 * design rule 10. It decides whether an activity runs, so flipping it here must
 * not rewrite the past for a review that is still parked.
 */
export const ENABLE_EPRIME_ALTERNATIVES = true;
/**
 * Phase 2. Resolved by the CLI into the `approve` **signal payload**, not into
 * the workflow input — the publish decision is consumed after the durable wait,
 * so for an already-parked review the input is immutable and the decision has
 * not yet been made. See the `approve` signal's docblock in
 * `workflows/review-post.ts` for the full reasoning.
 */
export const ENABLE_PUBLISH_LEG = process.env.STEWARD_ENABLE_PUBLISH_LEG === 'false' ? false : true;

/**
 * The content collections Steward reviews.
 *
 * `projects` is deliberately absent. It has no `draft` field in
 * `src/content.config.ts` at all, so neither the gate-mode draft refusal nor the
 * `SHOW_DRAFTS` build has any meaning for it — it is out of scope until someone
 * decides what reviewing a project entry would even mean.
 */
export const COLLECTIONS = ['writing', 'changelog'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export function isCollection(v: string): v is Collection {
  return (COLLECTIONS as readonly string[]).includes(v);
}

/**
 * A content slug: lowercase kebab-case, nothing else. Matches every entry in
 * both collections, and Astro's own slug shape.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The guard behind `CLAUDE.md`'s promise that the private documents never reach
 * an external API.
 *
 * That guarantee is stated as architectural — "every LLM-bound read resolves
 * through `postRelPath`, which hard-codes the content collections" — but
 * hard-coding the *prefix* is not the same as constraining the *slug*. Nothing
 * validated the slug on the way in, and `path.join` normalises away traversal,
 * so `src/content/writing/` + `../../../steward/steward-spec` resolves to a real
 * private file. `snapshot.ts` reads whatever `postRelPath` returns and
 * `editorial.ts` sends it to Anthropic; a single mistyped or pasted CLI argument
 * was enough to leak the spec, the build log, or a vault note.
 *
 * Validating here rather than at each call site is the point: this is the choke
 * point the guarantee already names, so a future activity that resolves a path
 * the documented way inherits the check instead of having to remember it.
 */
export function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug ${JSON.stringify(slug)}. Slugs are lowercase kebab-case ` +
        `(letters, digits, single hyphens) and name an entry inside a content ` +
        `collection — no path separators, no traversal, no extension.`,
    );
  }
}

/** Non-throwing form, for the CLI's own argument checking. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Where a post lives, given a slug. Repo-relative.
 *
 * The collection name is both the content directory and the URL segment for
 * both current collections (`src/content/writing/` → `/writing/<slug>/`), but
 * that is a coincidence of naming rather than a guarantee, which is why
 * `urlPathFor` exists separately instead of callers reusing this.
 *
 * Throws on a slug that is not a plain content slug — see `assertValidSlug`.
 */
export function postRelPath(slug: string, collection: Collection = 'writing'): string {
  assertValidSlug(slug);
  return `src/content/${collection}/${slug}.md`;
}

/** The site URL path a collection's entry renders at. Trailing slash included. */
export function urlPathFor(slug: string, collection: Collection = 'writing'): string {
  assertValidSlug(slug);
  return `/${collection}/${slug}/`;
}

/**
 * Resolves a `reportPath`/`latestPath` from an archive result back to an absolute
 * path. The counterpart to the relativisation in `archiveReport` — both anchor on
 * `REPO_ROOT` so archives stay readable under a redirected `SITE_DIR`.
 */
export function resolveArchivePath(relPath: string): string {
  return path.resolve(REPO_ROOT, relPath);
}

/**
 * The workflow ID for a review.
 *
 * **`writing` keeps the bare `steward-review-<slug>` form on purpose.** Adding
 * the collection unconditionally would have been tidier, and would also have
 * orphaned every review parked under the old scheme — including the live
 * `steward-review-hello-world` execution this session was written alongside.
 * A workflow ID is not an implementation detail once a workflow is running under
 * it; it is the only handle the CLI has. Non-default collections get the
 * qualified form, so a `changelog` and a `writing` entry sharing a slug cannot
 * collide.
 */
export function workflowIdFor(slug: string, collection: Collection = 'writing'): string {
  return collection === 'writing'
    ? `steward-review-${slug}`
    : `steward-review-${collection}-${slug}`;
}

/**
 * The workflow ID for one `auditSiteWorkflow` execution.
 *
 * Re-exported rather than defined here since 2026-08-15: the site's `/mcp`
 * function has to build the same IDs, and it may not import this module, which
 * reads `.env` off disk at load. `lib/agent-audit/deep-contract.ts` is the copy
 * both surfaces share; see its docblock for why that entry was affordable.
 */
export { auditWorkflowIdFor } from './lib/agent-audit/deep-contract.js';

/**
 * Where the MCP server listens.
 *
 * **Loopback by default, and that is a security property rather than a
 * convenience.** The three SSRF gaps on the stage-2 card are open, so this
 * server is only ever reachable through a tunnel a human started and is watching;
 * binding to `0.0.0.0` would put it on the local network as well, which nothing
 * about the demo needs. Override only with a reason.
 */
export const MCP_HOST = process.env.STEWARD_MCP_HOST ?? '127.0.0.1';
export const MCP_PORT = Number(process.env.STEWARD_MCP_PORT ?? 8765);

/**
 * Extra Host headers the MCP listener answers to, beyond loopback.
 *
 * The listener refuses any other Host, which is what stops a page in the
 * operator's browser from POSTing to the port. A tunnel breaks that on its own:
 * cloudflared forwards the public request's Host, so a tunnel session has to name
 * its hostname here or in `--allow-host`. Comma-separated, hostnames only — the
 * port is not compared.
 */
export const MCP_ALLOWED_HOSTS = (process.env.STEWARD_MCP_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

/**
 * Inverse of `workflowIdFor`. Only for read-only tooling that *discovers*
 * workflow IDs from Temporal's visibility store (`steward inbox`, which lists
 * open workflows rather than being told a slug directly) — everywhere else in
 * the CLI goes slug -> id via `workflowIdFor`, never the other way.
 *
 * Assumes no slug for the default `writing` collection begins with another
 * collection's `<collection>-` prefix; true today with `COLLECTIONS =
 * ['writing', 'changelog']` and cheap to revisit if that stops holding.
 */
export function parseWorkflowId(workflowId: string): { slug: string; collection: Collection } {
  const rest = workflowId.replace(/^steward-review-/, '');
  for (const collection of COLLECTIONS) {
    if (collection === 'writing') continue;
    const prefix = `${collection}-`;
    if (rest.startsWith(prefix)) return { slug: rest.slice(prefix.length), collection };
  }
  return { slug: rest, collection: 'writing' };
}
