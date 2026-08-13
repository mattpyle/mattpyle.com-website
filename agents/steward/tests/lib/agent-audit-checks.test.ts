import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runFastAudit } from '../../src/lib/agent-audit/checks.js';
import { HEADER_EXCERPT_MAX, type AuditResult, type CheckResult } from '../../src/lib/agent-audit/result.js';

/**
 * The fast tier against a mock site (no live network in the suite, per the
 * handoff).
 *
 * Same shape as `verify-deploy.test.ts`: the mock serves a *correct*,
 * fully agent-ready site by default and each test breaks exactly one thing, so
 * a failing check is always attributable to the break. The cases that matter
 * most are the ones a presence-only checker would get wrong — an HTML catch-all
 * answering 200 for llms.txt, and a site that returns the wrong page under
 * `Accept: text/markdown`.
 */

type Break =
  | 'no-robots'
  | 'robots-html'
  | 'robots-malformed'
  | 'robots-blocks-claude-user'
  | 'robots-blocks-auditor'
  | 'no-content-signal'
  | 'content-signal-header-only'
  | 'content-signal-both'
  | 'sitemap-undeclared'
  | 'no-sitemap'
  | 'no-llms'
  | 'llms-html'
  | 'llms-unparseable'
  | 'llms-prose-bullet'
  | 'llms-links-inside-prose'
  | 'llms-many-links'
  | 'llms-dead-link'
  | 'huge-link-header'
  | 'agent-card-legacy-url'
  | 'agent-card-no-endpoint'
  | 'many-declared-sitemaps'
  | 'no-agents-md'
  | 'agents-md-html'
  | 'no-vary'
  | 'negotiation-ignored'
  | 'markdown-is-another-page'
  | 'no-link-header'
  | 'no-well-known';

const POST_PATH = '/writing/hello/';
const POST_TITLE = 'Hello World, a post';
const HOME_TITLE = 'Example, an entirely fictional test site';

interface Mock {
  origin: string;
  /** Every path this server was asked for, in order. */
  requests: string[];
  close: () => Promise<void>;
}

interface SiteOptions {
  /** An origin llms.txt should link to, for the cross-origin robots test. */
  offsiteLinkOrigin?: string;
}

async function mockSite(broken?: Break, opts: SiteOptions = {}): Promise<Mock> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = (req.url ?? '/').split('?')[0];
    requests.push(url);
    const accept = String(req.headers.accept ?? '');
    const wantsMarkdown = /text\/markdown/.test(accept);

    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const htmlCatchAll = () => send(200, 'text/html', `<!doctype html><title>Not found</title>`);

    if (url === '/robots.txt') {
      if (broken === 'no-robots') return send(404, 'text/plain', 'nope');
      if (broken === 'robots-html') return htmlCatchAll();
      const lines = ['User-agent: *', 'Disallow: /admin/'];
      if (broken === 'robots-malformed') lines.push('Disallow /oops');
      if (broken === 'robots-blocks-claude-user') lines.push('', 'User-agent: Claude-User', 'Disallow: /');
      if (broken === 'robots-blocks-auditor') lines.push('', 'User-agent: steward-audit', 'Disallow: /');
      if (broken === 'many-declared-sitemaps') {
        // Five declarations, none of them a sitemap. Nothing in robots.txt
        // limits how many of these a site may write down.
        for (let i = 1; i <= 5; i++) lines.push('', `Sitemap: ${origin}/extra-sitemap-${i}.xml`);
      } else if (broken !== 'sitemap-undeclared' && broken !== 'no-sitemap') {
        lines.push('', `Sitemap: ${origin}/sitemap-index.xml`);
      }
      if (broken !== 'no-content-signal' && broken !== 'content-signal-header-only') {
        lines.push('Content-Signal: search=yes, ai-train=no');
      }
      return send(200, 'text/plain', `${lines.join('\n')}\n`);
    }

    if (url === '/sitemap-index.xml') {
      if (broken === 'no-sitemap') return send(404, 'text/plain', 'nope');
      return send(
        200,
        'application/xml',
        `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      );
    }
    if (url === '/sitemap-pages.xml') {
      return send(
        200,
        'application/xml',
        `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url><url><loc>${origin}${POST_PATH}</loc></url></urlset>`,
      );
    }
    if (url === '/sitemap.xml' || /^\/extra-sitemap-\d\.xml$/.test(url)) {
      return send(404, 'text/plain', 'nope');
    }

    if (url === '/llms.txt') {
      if (broken === 'no-llms') return send(404, 'text/plain', 'nope');
      if (broken === 'llms-html') return htmlCatchAll();
      if (broken === 'llms-unparseable') {
        return send(200, 'text/plain', 'just some prose, no headings and no links\n');
      }
      if (opts.offsiteLinkOrigin) {
        return send(
          200,
          'text/plain',
          `# Example

> A fictional test site.

## Elsewhere

- [Off-site](${opts.offsiteLinkOrigin}/page): on another host
`,
        );
      }
      const target = broken === 'llms-dead-link' ? '/writing/deleted/' : POST_PATH;
      let extra = '';
      if (broken === 'llms-prose-bullet') extra = '- **A thing with no URL**: prose only\n';
      if (broken === 'llms-links-inside-prose') {
        // stripe.com's shape: a bullet that carries links, just not at the front.
        extra =
          `- Read the [changelog](${origin}${POST_PATH}) or the [archive](${origin}/) for more.\n`;
      }
      if (broken === 'llms-many-links') {
        // More links than the sample, all of them live: the case whose pass line
        // used to read "3 of 8 link(s) return 200".
        for (let i = 1; i <= 7; i++) extra += `- [Extra ${i}](${origin}${POST_PATH}): a post\n`;
      }
      return send(
        200,
        'text/plain',
        `# Example\n\n> A fictional test site.\n\n## Writing\n\n- [${POST_TITLE}](${origin}${target}): a post\n${extra}`,
      );
    }

    if (url === '/agents.md') {
      if (broken === 'no-agents-md') return send(404, 'text/plain', 'nope');
      if (broken === 'agents-md-html') return htmlCatchAll();
      return send(
        200,
        'text/markdown',
        '# For agents\n\nThis site publishes markdown variants of every page. Fetch them with Accept: text/markdown.\n',
      );
    }

    if (url === '/.well-known/mcp-server') {
      if (broken === 'no-well-known') return send(404, 'text/plain', 'nope');
      return send(200, 'application/json', JSON.stringify({ endpoint: `${origin}/mcp` }));
    }
    if (url === '/.well-known/agent-card.json') {
      if (broken === 'no-well-known') return send(404, 'text/plain', 'nope');
      if (broken === 'agent-card-legacy-url') {
        // The pre-1.0 shape: a top-level `url` and no supportedInterfaces.
        return send(200, 'application/json', JSON.stringify({ name: 'Example agent', url: `${origin}/a2a` }));
      }
      if (broken === 'agent-card-no-endpoint') {
        return send(200, 'application/json', JSON.stringify({ name: 'Example agent' }));
      }
      // A2A 1.0: the endpoint lives in supportedInterfaces, not at the top level.
      return send(
        200,
        'application/json',
        JSON.stringify({
          name: 'Example agent',
          supportedInterfaces: [{ transport: 'JSONRPC', url: `${origin}/a2a` }],
        }),
      );
    }
    if (url === '/.well-known/agent.json') return send(404, 'text/plain', 'nope');

    if (url === '/' || url === POST_PATH) {
      const title = url === '/' ? HOME_TITLE : POST_TITLE;
      const vary: Record<string, string> = broken === 'no-vary' ? {} : { vary: 'Accept' };
      // The headers that decide whether a missing `Vary` is actually poisoning
      // anything. Present on both variants, as they are on a real CDN.
      const caching = { 'cache-control': 'public, max-age=0, must-revalidate', age: '7', 'x-cache': 'HIT' };
      // Cloudflare sets this response header on the markdown it generates, and
      // retool.com sends it on every response with nothing in its robots.txt.
      const signal: Record<string, string> =
        broken === 'content-signal-header-only' || broken === 'content-signal-both'
          ? { 'content-signal': 'ai-train=yes, search=yes, ai-input=yes' }
          : {};
      if (wantsMarkdown && broken !== 'negotiation-ignored') {
        const body =
          broken === 'markdown-is-another-page'
            ? '---\ntitle: "Some other page entirely"\n---\n\nWrong content.\n'
            : `---\ntitle: "${title}"\n---\n\nBody of ${title}.\n`;
        return send(200, 'text/markdown', body, { ...vary, ...caching, ...signal });
      }
      const alternate = `<${origin}${url === '/' ? '/index.md' : `${url.replace(/\/$/, '')}.md`}>; rel="alternate"; type="text/markdown"`;
      const link: Record<string, string> =
        broken === 'no-link-header'
          ? {}
          : {
              link:
                broken === 'huge-link-header'
                  ? // A real preload header, the shape stripe.com and temporal.io
                    // both send: kilobytes of it, on the homepage.
                    `${Array.from({ length: 120 }, (_, i) => `<${origin}/_astro/chunk-${i}.js>; rel=preload; as=script`).join(', ')}, ${alternate}`
                  : alternate,
            };
      return send(200, 'text/html', `<!doctype html><title>${title}</title><h1>${title}</h1>`, {
        ...vary,
        ...caching,
        ...signal,
        ...link,
      });
    }

    return send(404, 'text/html', '<!doctype html><title>Not found</title>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A second origin, which llms.txt can link to. Its robots.txt disallows
 * everything, and every other path would answer 200 if it were asked.
 */
async function mockThirdParty(): Promise<Mock> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    requests.push(url);
    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(['User-agent: *', 'Disallow: /', ''].join('\n'));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Off-site page</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function audit(t: { after: (fn: () => unknown) => void }, broken?: Break): Promise<AuditResult> {
  const mock = await mockSite(broken);
  t.after(() => mock.close());
  return runFastAudit(mock.origin, {
    // Only the mock host is exempt from the address guard — see safe-fetch.ts.
    policy: { allowedPrivateHosts: ['127.0.0.1'], totalBudgetMs: 30_000 },
  });
}

function check(result: AuditResult, id: string): CheckResult {
  const found = result.checks.find((c) => c.id === id);
  assert.ok(found, `no check with id "${id}"`);
  return found;
}

test('a fully agent-ready site passes every check', async (t) => {
  const result = await audit(t);
  const failed = result.checks.filter((c) => c.status !== 'pass');
  assert.deepEqual(
    failed.map((c) => `${c.id}: ${c.observed}`),
    [],
  );
  assert.equal(result.schemaVersion, 2);
  assert.ok(result.requests > 0);
  // Per-category counts, no composite score anywhere in the document. The
  // fourth category is the deep tier's, empty on a fast-only run.
  assert.equal(result.categories.length, 4);
  assert.ok(!('score' in result));
});

test('every check carries evidence and every failure carries a fix', async (t) => {
  const result = await audit(t, 'no-llms');
  for (const c of result.checks) {
    assert.ok(c.observed.length > 0, `${c.id} has no observed line`);
    if (c.status === 'fail') {
      assert.ok(c.fix && c.fix.length > 30, `${c.id} failed without a usable fix statement`);
    }
  }
  const llms = check(result, 'llms-txt');
  assert.equal(llms.status, 'fail');
  assert.equal(llms.evidence[0].status, 404);
});

test('a missing surface is a finding, not a crash', async (t) => {
  const result = await audit(t, 'no-agents-md');
  assert.equal(check(result, 'agents-md').status, 'fail');
  // Nothing else is disturbed by the absence.
  assert.equal(check(result, 'llms-txt').status, 'pass');
});

test('an HTML catch-all answering 200 for llms.txt is a fail, not a pass', async (t) => {
  // The behaviour-vs-presence case: a checker that reads the status code alone
  // reports this site as having llms.txt.
  const result = await audit(t, 'llms-html');
  const llms = check(result, 'llms-txt');
  assert.equal(llms.status, 'fail');
  assert.match(llms.observed, /HTML page/);
});

test('the same trap is caught on agents.md', async (t) => {
  const result = await audit(t, 'agents-md-html');
  assert.equal(check(result, 'agents-md').status, 'fail');
  assert.match(check(result, 'agents-md').observed, /HTML page/);
});

test('an llms.txt that does not follow the format fails with the reason', async (t) => {
  const result = await audit(t, 'llms-unparseable');
  const llms = check(result, 'llms-txt');
  assert.equal(llms.status, 'fail');
  assert.match(llms.observed, /no links in any section/);
  // With no links parsed there is nothing to follow, which is not the site's
  // second failure — it is the first one, once.
  assert.equal(check(result, 'llms-txt-links').status, 'not-applicable');
});

test('a dead link in llms.txt is caught by following it', async (t) => {
  const result = await audit(t, 'llms-dead-link');
  assert.equal(check(result, 'llms-txt').status, 'pass', 'the file itself is well-formed');
  const links = check(result, 'llms-txt-links');
  assert.equal(links.status, 'fail');
  assert.match(links.observed, /\(404\)/);
});

test('markdown negotiation: ignoring Accept is a fail on both pages', async (t) => {
  const result = await audit(t, 'negotiation-ignored');
  for (const id of ['markdown-negotiation-home', 'markdown-negotiation-content']) {
    assert.equal(check(result, id).status, 'fail', id);
    assert.match(check(result, id).observed, /ignored/);
  }
});

test('markdown negotiation: markdown without Vary: Accept is a fail', async (t) => {
  const result = await audit(t, 'no-vary');
  const home = check(result, 'markdown-negotiation-home');
  assert.equal(home.status, 'fail');
  assert.match(home.observed, /Vary header/);
});

test('markdown negotiation: serving the wrong page as markdown is caught', async (t) => {
  // The check that presence-only tooling cannot make: content-type says
  // markdown, status is 200, and the body is a different page.
  const result = await audit(t, 'markdown-is-another-page');
  const post = check(result, 'markdown-negotiation-content');
  assert.equal(post.status, 'fail');
  assert.match(post.observed, /different page/);
});

test('the content page is taken from the sitemap, not guessed', async (t) => {
  const result = await audit(t, 'no-sitemap');
  assert.equal(check(result, 'sitemap').status, 'fail');
  const post = check(result, 'markdown-negotiation-content');
  assert.equal(post.status, 'not-applicable');
  assert.match(post.observed, /does not guess/);
});

test('a sitemap that exists but is undeclared is a finding, and is still used', async (t) => {
  const result = await audit(t, 'sitemap-undeclared');
  const sitemap = check(result, 'sitemap');
  assert.equal(sitemap.status, 'fail');
  assert.match(sitemap.observed, /robots\.txt does not declare it/);
  // Found by probing the conventional path, so the content-page check still runs.
  assert.equal(check(result, 'markdown-negotiation-content').status, 'pass');
});

test('no robots.txt fails robots and stands down the checks that read it', async (t) => {
  const result = await audit(t, 'no-robots');
  assert.equal(check(result, 'robots-txt').status, 'fail');
  assert.equal(check(result, 'robots-ai-agents').status, 'not-applicable');
  assert.equal(check(result, 'content-signals').status, 'not-applicable');
  // The sitemap is still found by probing, and reported as undeclared.
  assert.equal(check(result, 'sitemap').status, 'fail');
});

test('robots.txt that returns HTML is a fail', async (t) => {
  const result = await audit(t, 'robots-html');
  assert.match(check(result, 'robots-txt').observed, /HTML page/);
});

test('a malformed robots.txt line is reported with its line number', async (t) => {
  const result = await audit(t, 'robots-malformed');
  const robots = check(result, 'robots-txt');
  assert.equal(robots.status, 'fail');
  assert.ok(robots.evidence.some((e) => /line 3/.test(e.note ?? '')), 'the line number is not in the evidence');
});

test('blocking a user-triggered AI agent is a high-severity failure', async (t) => {
  const result = await audit(t, 'robots-blocks-claude-user');
  const ai = check(result, 'robots-ai-agents');
  assert.equal(ai.status, 'fail');
  assert.equal(ai.severity, 'high');
  assert.match(ai.observed, /Claude-User/);
});

test('the auditor obeys a robots.txt that disallows it', async (t) => {
  const result = await audit(t, 'robots-blocks-auditor');
  // Everything past robots.txt is not-applicable — refused, not failed. The
  // site is not judged on surfaces the auditor was told not to look at.
  for (const id of ['llms-txt', 'agents-md', 'markdown-negotiation-home', 'sitemap', 'a2a-agent-card']) {
    assert.equal(check(result, id).status, 'not-applicable', id);
  }
  assert.ok(
    result.notes.some((n) => /disallows this auditor/.test(n)),
    'the run notes do not say why everything stood down',
  );
  // Two requests: robots.txt, and nothing else.
  assert.equal(result.requests, 1);
});

test('a prose-only bullet in llms.txt is its own low-severity finding', async (t) => {
  // Deliberately not a failure of `llms-txt` itself: the file is well-formed
  // and every link works, and ranking one unlinked bullet alongside "the file
  // is HTML" would make the fix list useless.
  const result = await audit(t, 'llms-prose-bullet');
  assert.equal(check(result, 'llms-txt').status, 'pass');
  const items = check(result, 'llms-txt-list-items');
  assert.equal(items.status, 'fail');
  assert.equal(items.severity, 'low');
  assert.match(items.evidence[0].note ?? '', /A thing with no URL/);
});

test('an A2A card is accepted in both the 1.0 and the pre-1.0 shape', async (t) => {
  // The default mock serves the 1.0 shape (endpoint under supportedInterfaces).
  const modern = await audit(t);
  assert.equal(check(modern, 'a2a-agent-card').status, 'pass');
  const legacy = await audit(t, 'agent-card-legacy-url');
  assert.equal(check(legacy, 'a2a-agent-card').status, 'pass');
});

test('an A2A card with no endpoint at all is a fail', async (t) => {
  const result = await audit(t, 'agent-card-no-endpoint');
  const card = check(result, 'a2a-agent-card');
  assert.equal(card.status, 'fail');
  assert.match(card.observed, /does not name the agent and an endpoint/);
});

test('only the first few declared sitemaps are fetched, and the summary says so', async (t) => {
  // robots.txt is a file the audited site controls, and nothing limits how many
  // `Sitemap:` lines it may hold. Following all of them turns one line in a
  // stranger's robots.txt into unbounded requests from this tool.
  const mock = await mockSite('many-declared-sitemaps');
  t.after(() => mock.close());
  const result = await runFastAudit(mock.origin, {
    policy: { allowedPrivateHosts: ['127.0.0.1'], totalBudgetMs: 30_000 },
  });

  const fetchedSitemaps = mock.requests.filter((u) => /^\/extra-sitemap-\d\.xml$/.test(u));
  assert.equal(fetchedSitemaps.length, 3, 'more than the cap were fetched');
  const sitemap = check(result, 'sitemap');
  assert.equal(sitemap.status, 'fail');
  assert.ok(
    sitemap.evidence.some((e) => /declares 5 sitemaps; only the first 3 were fetched/.test(e.note ?? '')),
    'the cap was applied silently',
  );
});

test('an off-origin llms.txt link is judged by that host\'s robots.txt, not this one\'s', async (t) => {
  // The audited site allows everything; the third party disallows everything.
  // Reading the audited site's robots.txt for another host's path would both
  // apply rules that host never wrote and fetch it having consulted nothing it did.
  const third = await mockThirdParty();
  t.after(() => third.close());
  const mock = await mockSite(undefined, { offsiteLinkOrigin: third.origin });
  t.after(() => mock.close());

  const result = await runFastAudit(mock.origin, {
    policy: { allowedPrivateHosts: ['127.0.0.1'], totalBudgetMs: 30_000 },
  });

  const links = check(result, 'llms-txt-links');
  assert.equal(links.status, 'not-applicable', 'a link that was never fetched was reported as resolving');
  assert.ok(
    links.evidence.some((e) => (e.note ?? '').includes(`${third.origin}/robots.txt`)),
    'the evidence does not name whose robots.txt refused the link',
  );
  // The third party was asked for its robots.txt and then left alone.
  assert.deepEqual(third.requests, ['/robots.txt']);
});

test('the optional surfaces are reported at low severity', async (t) => {
  const result = await audit(t, 'no-well-known');
  for (const id of ['well-known-mcp-server', 'a2a-agent-card']) {
    assert.equal(check(result, id).status, 'fail', id);
    assert.equal(check(result, id).severity, 'low', id);
  }
});

test('a missing Link header is a low-severity finding', async (t) => {
  const result = await audit(t, 'no-link-header');
  const link = check(result, 'link-headers');
  assert.equal(link.status, 'fail');
  assert.equal(link.severity, 'low');
});

// --- report quality, from the stage-0 validation runs ----------------------

test('a kilobyte-long header value is bounded in the evidence', async (t) => {
  // stripe.com and temporal.io both answer with a ~6KB preload Link header, and
  // quoting it verbatim buried the finding it was evidence for.
  const result = await audit(t, 'huge-link-header');
  const link = check(result, 'link-headers');
  const value = link.evidence[0].headers?.link ?? '';
  assert.ok(value.length > 0, 'the Link header is not in the evidence at all');
  assert.ok(value.length <= HEADER_EXCERPT_MAX + 1, `the header value was quoted at ${value.length} characters`);
  assert.ok(value.endsWith('…'), 'the truncation is silent');
});

test('the two negotiation evidence lines say which request each came from', async (t) => {
  // With Accept ignored, both responses are the same HTML from the same URL, so
  // without the labels the two lines are identical text.
  const result = await audit(t, 'negotiation-ignored');
  const home = check(result, 'markdown-negotiation-home');
  const notes = home.evidence.map((e) => e.note ?? '');
  assert.ok(notes.some((n) => /plain request, Accept: text\/html/.test(n)), notes.join(' | '));
  assert.ok(notes.some((n) => /markdown request, Accept: text\/markdown/.test(n)), notes.join(' | '));
});

test('the negotiation evidence records the cache headers the Vary finding depends on', async (t) => {
  const result = await audit(t, 'no-vary');
  const home = check(result, 'markdown-negotiation-home');
  assert.equal(home.status, 'fail');
  const headers = home.evidence[0].headers ?? {};
  for (const name of ['cache-control', 'age', 'x-cache']) {
    assert.ok(name in headers, `the evidence does not record ${name}`);
  }
  // The finding reads as conditional on a cache actually storing the response.
  assert.match(home.observed, /shared cache that stores this response/);
  assert.match(home.fix ?? '', /depends on whether/);
});

test('the llms.txt link check says how many links it sampled', async (t) => {
  // "3 of 8 link(s) return 200" parses as five broken links. Three were sampled,
  // and all three answered.
  const result = await audit(t, 'llms-many-links');
  const links = check(result, 'llms-txt-links');
  assert.equal(links.status, 'pass');
  assert.match(links.observed, /all 3 sampled link\(s\) return 200/);
  assert.match(links.observed, /8 link\(s\) in the file/);
});

test('a bullet with links inside prose is reported differently from one with none', async (t) => {
  // Two different problems: a bullet with no link is invisible to any parser; a
  // bullet whose links sit mid-sentence is off-format, and its links are still
  // collectable. The fix copy must not claim invisibility about the second.
  const prose = await audit(t, 'llms-prose-bullet');
  const proseItems = check(prose, 'llms-txt-list-items');
  assert.equal(proseItems.status, 'fail');
  assert.match(proseItems.observed, /contain no link at all/);
  assert.match(proseItems.evidence[0].note ?? '', /^no link: /);
  assert.match(proseItems.fix ?? '', /nothing for a client to collect/);

  const inside = await audit(t, 'llms-links-inside-prose');
  const insideItems = check(inside, 'llms-txt-list-items');
  assert.equal(insideItems.status, 'fail');
  assert.match(insideItems.observed, /carry 2 link\(s\) but do not lead with one/);
  assert.match(insideItems.evidence[0].note ?? '', /^2 link\(s\), none leading: /);
  assert.doesNotMatch(insideItems.fix ?? '', /nothing for a client to collect/);
  assert.match(insideItems.fix ?? '', /not invisible/);
});

test('a missing Content-Signal line is a low-severity finding', async (t) => {
  const result = await audit(t, 'no-content-signal');
  const signals = check(result, 'content-signals');
  assert.equal(signals.status, 'fail');
  assert.equal(signals.severity, 'low');
  // The observed line names both places that were looked at, so a site that
  // sends the header can tell this was not simply missed.
  assert.match(signals.observed, /no Content-Signal directive in robots\.txt, and no Content-Signal response header/);
});

test('a Content-Signal response header is an expressed signal, not an absent one', async (t) => {
  // retool.com answers with `Content-Signal: ai-train=yes, search=yes,
  // ai-input=yes` on every response and says nothing in robots.txt; reading
  // robots.txt alone reported it as having expressed no preference.
  const result = await audit(t, 'content-signal-header-only');
  const signals = check(result, 'content-signals');
  assert.equal(signals.status, 'pass');
  assert.match(signals.observed, /expressed as a Content-Signal response header, but not in robots\.txt/);
  assert.equal(signals.evidence[0].headers?.['content-signal'], 'ai-train=yes, search=yes, ai-input=yes');
});

test('both places carrying the signal is reported as both', async (t) => {
  const result = await audit(t, 'content-signal-both');
  const signals = check(result, 'content-signals');
  assert.equal(signals.status, 'pass');
  assert.match(signals.observed, /in robots\.txt, and repeats the signal as a response header/);
  assert.equal(signals.evidence.length, 2);
});

test('the check keeps its place in the report even though it is decided last', async (t) => {
  // It reads the homepage response, which is not fetched until the negotiation
  // check; it still belongs next to the other things robots.txt says.
  const result = await audit(t);
  assert.deepEqual(
    result.checks.slice(0, 3).map((c) => c.id),
    ['robots-txt', 'robots-ai-agents', 'content-signals'],
  );
});
