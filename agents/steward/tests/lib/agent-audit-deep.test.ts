import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runAudit, samplePages } from '../../src/lib/agent-audit/checks.js';
import {
  reportableViolations,
  runDeepChecks,
  type DeepContext,
  type DeepRunners,
} from '../../src/lib/agent-audit/deep.js';
import { renderMarkdownSummary } from '../../src/lib/agent-audit/render.js';
import { DEFAULT_POLICY } from '../../src/lib/agent-audit/safe-fetch.js';
import type { VettingProxy } from '../../src/lib/agent-audit/vetting-proxy.js';
import type { AuditResult, CheckResult } from '../../src/lib/agent-audit/result.js';
import { isExpectedDraftNonFinding, type AxeViolation, type LighthouseLike } from '../../src/lib/audit-map.js';

/**
 * The deep tier, with the two tool invocations injected.
 *
 * No browser and no live network in the suite: the point of the injection point
 * is that the sampling, the caps, the shared budget, the robots and address
 * gates and the Chrome-unavailable path are all testable without Chrome — which
 * is also the only way the pathological cases (a page that never finishes
 * rendering) can be written at all.
 */

const PAGES = ['/', '/writing/hello/', '/projects/thing/', '/about/'];

/** A Lighthouse result with the category scores a test cares about. */
function lhr(scores: Record<string, number>): LighthouseLike {
  return {
    lighthouseVersion: '13.4.1',
    categories: Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, { score: value / 100 }]),
    ),
  };
}

const GOOD = lhr({ performance: 98, accessibility: 100, seo: 100, 'best-practices': 96, 'agentic-browsing': 100 });

function runners(over: Partial<DeepRunners> = {}): DeepRunners & { calls: string[]; proxies: VettingProxy[] } {
  const calls: string[] = [];
  const proxies: VettingProxy[] = [];
  return {
    calls,
    proxies,
    async lighthouse(url, timeoutMs, proxy) {
      calls.push(`lighthouse ${url}`);
      proxies.push(proxy);
      return over.lighthouse ? over.lighthouse(url, timeoutMs, proxy) : GOOD;
    },
    async axe(url, timeoutMs, proxy) {
      calls.push(`axe ${url}`);
      proxies.push(proxy);
      return over.axe ? over.axe(url, timeoutMs, proxy) : [];
    },
  };
}

function context(over: Partial<DeepContext> = {}): DeepContext {
  return {
    candidates: PAGES.map((p) => `https://example.test${p}`),
    remainingMs: () => 600_000,
    // `example.test` does not resolve, and the address guard is real: the same
    // exemption the fetcher's own tests use points it at a host that is not
    // there. The refusal test below overrides `candidates` with a literal
    // address, which needs no DNS and is not exempt.
    policy: { ...DEFAULT_POLICY, allowedPrivateHosts: ['example.test'] },
    robotsDetail: async () => null,
    ...over,
  };
}

function check(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((c) => c.id === id);
  assert.ok(found, `no check with id "${id}"`);
  return found;
}

test('the sampled pages carry a per-page score for every axis, naming the tool and version', async () => {
  const tools = runners();
  const { checks, renderedPages } = await runDeepChecks(context(), { runners: tools, maxPages: 2 });

  assert.equal(renderedPages, 2);
  assert.deepEqual(tools.calls, [
    'axe https://example.test/',
    'lighthouse https://example.test/',
    'axe https://example.test/writing/hello/',
    'lighthouse https://example.test/writing/hello/',
  ]);

  const perf = check(checks, 'lighthouse-performance');
  assert.equal(perf.status, 'pass');
  assert.equal(perf.evidence.length, 2, 'one evidence line per rendered page');
  assert.match(perf.evidence[0].note ?? '', /Lighthouse 13\.4\.1: performance 98/);
  assert.equal(perf.evidence[1].url, 'https://example.test/writing/hello/');

  const axe = check(checks, 'axe-violations');
  assert.equal(axe.status, 'pass');
  assert.match(axe.evidence[0].note ?? '', /^axe-core \d+\.\d+\.\d+: 0 violation\(s\)/);

  // Every axis is reported, not only the failing ones.
  for (const id of ['lighthouse-accessibility', 'lighthouse-seo', 'lighthouse-best-practices', 'lighthouse-agentic-browsing']) {
    assert.equal(check(checks, id).status, 'pass', id);
  }
});

test('a score below 90 fails, naming the page it was measured on', async () => {
  const tools = runners({
    async lighthouse(url) {
      return url.endsWith('/writing/hello/')
        ? lhr({ performance: 41, accessibility: 100, seo: 100, 'best-practices': 100, 'agentic-browsing': 100 })
        : GOOD;
    },
  });
  const { checks } = await runDeepChecks(context(), { runners: tools, maxPages: 2 });

  const perf = check(checks, 'lighthouse-performance');
  assert.equal(perf.status, 'fail');
  assert.match(perf.observed, /performance scored 41 on \/writing\/hello\//);
  assert.ok(perf.fix && perf.fix.length > 30, 'a failing deep check carries no fix');
  // The passing axes are unaffected by the one failing page.
  assert.equal(check(checks, 'lighthouse-accessibility').status, 'pass');
});

test('axe violations are counted per page and the rules are in the evidence', async () => {
  const violation: AxeViolation = { id: 'link-name', impact: 'serious', nodes: [{ html: '<a></a>' }, { html: '<a></a>' }] };
  const tools = runners({ async axe(url) { return url === 'https://example.test/' ? [violation] : []; } });
  const { checks } = await runDeepChecks(context(), { runners: tools, maxPages: 2 });

  const axe = check(checks, 'axe-violations');
  assert.equal(axe.status, 'fail');
  assert.match(axe.observed, /1 violation\(s\) on 1 of 2 rendered page\(s\)/);
  assert.match(axe.evidence[0].note ?? '', /link-name \(serious\) × 2/);
});

test('the page cap is reported rather than applied silently', async () => {
  const { notes, renderedPages } = await runDeepChecks(context(), { runners: runners(), maxPages: 2 });
  assert.equal(renderedPages, 2);
  assert.ok(
    notes.some((n) => /4 page\(s\) were available to sample and the first 2 were rendered/.test(n)),
    notes.join(' | '),
  );
});

test('a page disallowed by robots.txt is not rendered, and is not a finding against the site', async () => {
  const tools = runners();
  const { checks } = await runDeepChecks(
    context({
      candidates: ['https://example.test/private/'],
      robotsDetail: async () => 'robots.txt: "Disallow: /private/" under User-agent: *',
    }),
    { runners: tools },
  );

  assert.deepEqual(tools.calls, [], 'a disallowed page was handed to the browser anyway');
  const perf = check(checks, 'lighthouse-performance');
  assert.equal(perf.status, 'not-applicable');
  assert.match(perf.observed, /disallowed to this auditor by robots\.txt/);
});

test('a page inside a private range is refused before the browser is launched', async () => {
  // The SSRF gate the deep tier has to run itself: Chrome navigates on its own,
  // so nothing else would have checked this address.
  const tools = runners();
  const { checks, renderedPages } = await runDeepChecks(
    context({ candidates: ['http://169.254.169.254/latest/meta-data/'] }),
    { runners: tools },
  );

  assert.deepEqual(tools.calls, [], 'the browser was pointed at a link-local address');
  assert.equal(renderedPages, 0);
  const perf = check(checks, 'lighthouse-performance');
  assert.equal(perf.status, 'error');
  assert.match(perf.evidence.map((e) => e.note).join(' '), /link-local/);
});

test('both tools are launched through one vetting proxy, and it does not outlive the run', async () => {
  // The wiring, held in place by a test because the failure it prevents is
  // silent: a Chrome launched without these flags reaches the network directly
  // and every deep check still produces a perfectly ordinary-looking score.
  const tools = runners();
  await runDeepChecks(context(), { runners: tools, maxPages: 1 });

  const distinct = new Set(tools.proxies);
  assert.equal(distinct.size, 1, 'axe and Lighthouse were pointed at different proxies');
  const [proxy] = [...distinct];
  assert.ok(
    proxy.chromeFlags.some((f) => new RegExp(`^--proxy-server=http://127\\.0\\.0\\.1:${proxy.port}$`).test(f)),
    proxy.chromeFlags.join(' '),
  );
  // Without this, Chrome reaches loopback directly and the guard never sees it.
  assert.ok(proxy.chromeFlags.includes('--proxy-bypass-list=<-loopback>'));
  // `--proxy-server` does not govern WebRTC, and a page can open a peer
  // connection and send STUN over UDP to private addresses without the proxy
  // ever seeing it. This flag confines WebRTC to transports the proxy carries,
  // and it is a browser setting rather than something this code enforces, so a
  // test is the only thing holding it on.
  assert.ok(proxy.chromeFlags.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  // axe's CLI splits `--chrome-options` on commas and semicolons and wants the
  // flags undashed; all three have to survive that form.
  assert.deepEqual(
    proxy.chromeOptions,
    proxy.chromeFlags.map((f) => f.slice(2)),
  );
  assert.equal(proxy.chromeOptions.length, 3);
  for (const option of proxy.chromeOptions) assert.doesNotMatch(option, /[,;]/);

  await assert.rejects(
    () => fetch(`http://127.0.0.1:${proxy.port}/`),
    'the proxy was still listening after the run finished',
  );
});

test("what the browser was refused is reported in the run's notes", async () => {
  // The injected runner stands in for Chrome and makes exactly the request a
  // rendered page makes for a subresource — through the proxy it was handed,
  // because that is the only route out.
  const tools = runners({
    async axe(_url, _ms, proxy) {
      await proxiedGet(proxy.port, 'http://169.254.169.254/latest/meta-data/');
      return [];
    },
  });
  const { notes } = await runDeepChecks(context(), { runners: tools, maxPages: 1 });

  assert.ok(
    notes.some((n) => /the browser was refused http:\/\/169\.254\.169\.254\/.*link-local/.test(n)),
    notes.join(' | '),
  );
});

/** One absolute-URI request through a proxy, the way a browser sends it. */
function proxiedGet(port: number, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: new URL(url).host }, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('a page that never finishes rendering cannot hold the tier past its slice', async () => {
  // The pathological target: both tools hang forever. Without a deadline of its
  // own the deep tier would sit here until the process was killed.
  const tools = runners({
    lighthouse: () => new Promise<LighthouseLike>(() => {}),
    axe: () => new Promise<AxeViolation[]>(() => {}),
  });
  const started = Date.now();
  const { checks, notes, renderedPages } = await runDeepChecks(context(), {
    runners: tools,
    maxPages: 3,
    pageTimeoutMs: 300,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 10_000, `the tier took ${elapsed}ms against a 300ms page slice`);
  // A page running out of time says nothing about the next page, so the rest of
  // the sample is still attempted — each on its own bounded slice.
  assert.equal(renderedPages, 3);
  const perf = check(checks, 'lighthouse-performance');
  assert.equal(perf.status, 'error');
  assert.match(perf.observed, /ran out of its slice of the time budget/);
  assert.doesNotMatch(perf.observed, /the browser did not produce a result/);
  assert.ok(notes.some((n) => /did not finish rendering inside its/.test(n)), notes.join(' | '));
});

test('a timeout on the first page is not reported as the browser failing', async () => {
  // The two states look identical in a stack trace and mean opposite things: one
  // is a fact about the page, the other is a fact about the machine. A reader
  // deciding between "re-run with a longer budget" and "go and fix Chrome" is
  // reading this line.
  const slow = { url: 'https://example.test/' };
  const tools = runners({
    lighthouse: (url) =>
      url === slow.url ? new Promise<LighthouseLike>(() => {}) : Promise.resolve(GOOD),
    axe: (url) => (url === slow.url ? new Promise<AxeViolation[]>(() => {}) : Promise.resolve([])),
  });
  const { checks } = await runDeepChecks(context(), { runners: tools, maxPages: 2, pageTimeoutMs: 300 });

  // The second page rendered fine, so there is a real score to report.
  const perf = check(checks, 'lighthouse-performance');
  assert.equal(perf.status, 'pass');
  assert.match(perf.observed, /on all 1 rendered page\(s\): \/writing\/hello\//);
  // The page that ran out of time is still in the evidence, with what happened
  // to it, so a pass over one page is not read as a pass over two.
  const timedOut = perf.evidence.find((e) => e.url === slow.url);
  assert.ok(timedOut, 'the timed-out page is missing from the evidence');
  assert.match(timedOut.note ?? '', /exceeded|no time left/);
});

test('axe findings are reported unfiltered — the draft-OG filter is this repo\'s, not a stranger\'s', () => {
  // `runAxe` returns both lists, and taking the filtered one applies
  // `isExpectedDraftNonFinding` — written for an unpublished draft of this
  // site's, whose OG image does not exist yet — to somebody else's live page.
  // Their broken image would be quietly dropped and their audit would report a
  // clean axe run.
  const ogImageViolation: AxeViolation = {
    id: 'image-alt',
    impact: 'critical',
    nodes: [{ html: '<img src="/og/writing/hello.png">' }],
  };
  assert.ok(isExpectedDraftNonFinding(ogImageViolation), 'the fixture no longer trips the filter');

  const fromRunAxe = {
    raw: [ogImageViolation],
    violations: [ogImageViolation].filter((v) => !isExpectedDraftNonFinding(v)),
  };
  assert.equal(fromRunAxe.violations.length, 0, 'the filtered list is what the bug reported');
  assert.deepEqual(reportableViolations(fromRunAxe), [ogImageViolation]);
});

test('a budget too small to buy a page skips it and says so', async () => {
  const tools = runners();
  const { checks, notes, renderedPages } = await runDeepChecks(
    context({ remainingMs: () => 1_000 }),
    { runners: tools, maxPages: 2 },
  );

  assert.deepEqual(tools.calls, []);
  assert.equal(renderedPages, 0);
  assert.equal(check(checks, 'axe-violations').status, 'error');
  assert.ok(notes.some((n) => /shared time budget had 1\.0s left/.test(n)), notes.join(' | '));
});

test('Lighthouse without the agentic-browsing category reports not-applicable, not a failure', async () => {
  const tools = runners({ async lighthouse() { return lhr({ performance: 95, accessibility: 95, seo: 95, 'best-practices': 95 }); } });
  const { checks } = await runDeepChecks(context(), { runners: tools, maxPages: 1 });

  const agentic = check(checks, 'lighthouse-agentic-browsing');
  assert.equal(agentic.status, 'not-applicable');
  assert.match(agentic.observed, /no "agentic-browsing" score/);
  assert.equal(check(checks, 'lighthouse-performance').status, 'pass');
});

// --- the whole verb, both tiers --------------------------------------------

/** A minimal correct site: enough for the fast tier to find pages to sample. */
async function mockSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = (req.url ?? '/').split('?')[0];
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    if (url === '/robots.txt') {
      return send(200, 'text/plain', `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
    }
    if (url === '/sitemap.xml') {
      return send(
        200,
        'application/xml',
        `<?xml version="1.0"?><urlset>${PAGES.map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`,
      );
    }
    if (PAGES.includes(url)) {
      if (/text\/markdown/.test(String(req.headers.accept ?? ''))) {
        return send(200, 'text/markdown', `---\ntitle: "Page ${url}"\n---\n\nBody.\n`, { vary: 'Accept' });
      }
      return send(200, 'text/html', `<!doctype html><title>Page ${url}</title><h1>Page ${url}</h1>`, {
        vary: 'Accept',
      });
    }
    return send(404, 'text/plain', 'nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function bothTiers(
  t: { after: (fn: () => unknown) => void },
  over: Partial<DeepRunners> = {},
): Promise<AuditResult> {
  const mock = await mockSite();
  t.after(() => mock.close());
  return runAudit(mock.origin, {
    policy: { allowedPrivateHosts: ['127.0.0.1'], totalBudgetMs: 60_000 },
    deep: { runners: runners(over), maxPages: 2 },
    loadDeep: () => import('../../src/lib/agent-audit/deep.js'),
  });
}

test('a deep run reports both tiers in one document', async (t) => {
  const result = await bothTiers(t);

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.categories.length, 4);
  const rendered = result.categories.find((c) => c.category === 'rendered-experience');
  assert.equal(rendered?.passed, 6, 'five Lighthouse axes and axe should all pass');
  // The cost line stays honest: the browser's own requests are not in `requests`.
  assert.equal(result.browserPages, 2);
  assert.ok(result.requests > 0);
  assert.match(renderMarkdownSummary(result), /2 page\(s\) rendered in a browser/);
  assert.match(renderMarkdownSummary(result), /Rendered experience/);
});

test('--fast completes with no browser and says the category is empty rather than clean', async (t) => {
  const mock = await mockSite();
  t.after(() => mock.close());
  const result = await runAudit(mock.origin, {
    policy: { allowedPrivateHosts: ['127.0.0.1'], totalBudgetMs: 30_000 },
    deep: false,
  });

  assert.equal(result.checks.filter((c) => c.category === 'rendered-experience').length, 0);
  assert.equal(result.browserPages, undefined);
  assert.ok(result.notes.some((n) => /--fast/.test(n)), result.notes.join(' | '));
  assert.doesNotMatch(renderMarkdownSummary(result), /rendered in a browser/);
});

test('the deep tier refuses to run without a loader rather than importing one', async (t) => {
  // The property this protects is a packaging one, and it is invisible at
  // runtime: `checks.ts` holds no value reference to `deep.js`, so a bundler
  // reading its import graph cannot reach Chrome, Lighthouse or axe, and the
  // site's /mcp function can carry the fast tier alone. A default loader here
  // would restore the reference and undo it silently.
  const mock = await mockSite();
  t.after(() => mock.close());
  await assert.rejects(
    runAudit(mock.origin, {
      policy: { allowedPrivateHosts: ['127.0.0.1'], totalBudgetMs: 30_000 },
      deep: { runners: runners(), maxPages: 1 },
    }),
    /loadDeep/,
  );
});

test('with the browser unavailable the fast tier still completes and the deep checks error', async (t) => {
  const unavailable = () => Promise.reject(new Error('Unable to connect to Chrome: ENOENT chrome.exe'));
  const result = await bothTiers(t, { lighthouse: unavailable, axe: unavailable });

  // Nothing about the fast tier is disturbed.
  for (const id of ['robots-txt', 'sitemap', 'markdown-negotiation-home']) {
    const check = result.checks.find((c) => c.id === id);
    assert.equal(check?.status, 'pass', `${id}: ${check?.observed}`);
  }
  const deep = result.checks.filter((c) => c.category === 'rendered-experience');
  assert.equal(deep.length, 6);
  for (const c of deep) {
    assert.equal(c.status, 'error', c.id);
    assert.match(c.observed, /Unable to connect to Chrome/);
  }
  // Still a valid document, and the summary still renders.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)) as unknown);
  assert.match(renderMarkdownSummary(result), /Agent-readiness audit/);
  assert.ok(
    result.notes.some((n) => /the remaining pages were not attempted/.test(n)),
    result.notes.join(' | '),
  );
});

// --- sampling ---------------------------------------------------------------

test('the sample is the homepage plus the site\'s own sitemap pages, deduplicated', () => {
  const pages = samplePages('https://example.test', [
    'https://example.test/',
    'https://example.test/writing/hello/',
    'https://example.test/writing/hello/',
    'https://other.test/elsewhere/',
    'https://example.test/search?q=x',
    'not a url',
  ]);
  assert.deepEqual(pages, ['https://example.test/', 'https://example.test/writing/hello/']);
});

test('every rendered-experience check declares a decision class, whatever happened', async () => {
  const classes = (checks: CheckResult[]) =>
    Object.fromEntries(checks.map((c) => [c.id, c.decisionClass]));

  const measured = await runDeepChecks(context(), { runners: runners(), maxPages: 2 });
  assert.deepEqual(classes(measured.checks), {
    'lighthouse-agentic-browsing': 'emergingConvention',
    'lighthouse-accessibility': 'provenBlocker',
    'lighthouse-seo': 'bestPractice',
    'lighthouse-performance': 'bestPractice',
    'lighthouse-best-practices': 'bestPractice',
    'axe-violations': 'provenBlocker',
  });

  // The class is the check's, not the run's: a browser that never started still
  // produces six checks and each one still says what kind of thing it tests.
  const dead = await runDeepChecks(context(), {
    runners: runners({
      lighthouse: () => Promise.reject(new Error('chrome not found')),
      axe: () => Promise.reject(new Error('chrome not found')),
    }),
    maxPages: 2,
  });
  assert.deepEqual(classes(dead.checks), classes(measured.checks));
});
