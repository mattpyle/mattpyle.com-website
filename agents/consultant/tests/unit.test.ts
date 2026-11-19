/** The pure parts: the projection, the caps, the environment, and the site client's identity. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CAPS, capReached, capsFromEnv, newSession, tokensLeft, withReply } from '../src/caps.js';
import { readConfig } from '../src/config.js';
import { CHECK_TABLE, parseFixLog, searchFixLog } from '../src/fix-log.js';
import { normaliseOrigin, projectReport, projectSiteFacts } from '../src/project.js';
import { CLIENT_NAME, FIX_LOG_MAX_BYTES, FIX_LOG_PATH, SITE_FACTS_PATH, USER_AGENT, mcpSiteClient } from '../src/site.js';
import { CHECK_ID } from '../src/tools.js';
import { MARKER, cleanFixLog, cleanIndex, cleanReport, hostileReport } from './helpers/reports.js';

test('the projection keeps ids, enums and counts', () => {
  const view = projectReport(cleanReport(), 'fast', 'https://example.com');
  assert.equal(view.origin, 'https://example.com');
  assert.deepEqual(
    view.checks.map((c) => [c.id, c.status, c.severity]),
    [
      ['robots-txt', 'pass', 'high'],
      ['llms-txt', 'fail', 'medium'],
      ['markdown-negotiation', 'fail', 'medium'],
    ],
  );
  assert.equal(view.dropped, 0);
  assert.equal(view.categories.length, 2);
});

test('the projection carries no string from a hostile report', () => {
  const view = projectReport(hostileReport(), 'fast', 'https://example.com');
  assert.ok(!JSON.stringify(view).includes(MARKER));
  assert.equal(view.checks.length, 3, 'the checks with clean enums survive');
  assert.equal(view.dropped, 4, 'each check with a hostile enum or id is dropped whole');
  assert.equal(view.categories.length, 2);
  assert.equal(view.integrity, 'degraded');
});

test('the projection survives a report that is not a report', () => {
  for (const junk of [null, 'text', 42, [], { checks: 'x', categories: {} }]) {
    const view = projectReport(junk, 'fast', 'https://example.com');
    assert.deepEqual(view.checks, []);
  }
});

test('origins are normalised from the caller, and anything odd is refused', () => {
  assert.equal(normaliseOrigin('Example.COM/some/path?q=1'), 'https://example.com');
  assert.equal(normaliseOrigin('http://example.com:8080'), 'http://example.com:8080');
  for (const bad of ['', 'ftp://example.com', 'https://user:pw@example.com', 'javascript:alert(1)', 'https://exa mple.com']) {
    assert.equal(normaliseOrigin(bad), null, bad);
  }
});

test('caps: each reason in order', () => {
  const s = newSession({ ...DEFAULT_CAPS, turns: 2, tokens: 1000 });
  assert.equal(capReached(s, 'endTurn'), null);
  assert.equal(capReached(s, 'limitTurns'), 'cap:tool_calls');
  assert.equal(capReached(s, 'limitTotalTokens'), 'cap:tokens');
  s.turns = 2;
  assert.equal(capReached(s, 'endTurn'), 'cap:turns');
  s.totalTokens = 1010;
  assert.equal(capReached(s, 'endTurn'), 'cap:tokens');
  assert.equal(tokensLeft(s), 1);
});

test('caps: the environment overrides integers, and refuses anything else', () => {
  assert.equal(capsFromEnv({ CONSULTANT_CAP_TURNS: '3' }).turns, 3);
  assert.deepEqual(capsFromEnv({}), DEFAULT_CAPS);
  assert.throws(() => capsFromEnv({ CONSULTANT_CAP_TURNS: '2.5' }));
  assert.throws(() => capsFromEnv({ CONSULTANT_CAP_TOKENS: '0' }));
});

// Stand-ins built at run time, so no secret-shaped literal sits in the history the secret scan reads.
const STAND_IN = ['stand', 'in', 'value'].join('-');

const fullEnv = {
  TEMPORAL_ADDRESS: 'localhost:7300',
  TEMPORAL_NAMESPACE: 'default',
  ANTHROPIC_API_KEY: STAND_IN,
};

test('config: the worker starts nothing without address, namespace or model key, and names only variables', () => {
  const result = readConfig({ ANTHROPIC_API_KEY: STAND_IN });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.problems, ['TEMPORAL_ADDRESS is not set', 'TEMPORAL_NAMESPACE is not set']);
  assert.ok(!result.problems.join(' ').includes(STAND_IN));
  const noKey = readConfig({ TEMPORAL_ADDRESS: 'x', TEMPORAL_NAMESPACE: 'y' });
  assert.ok(!noKey.ok && noKey.problems.includes('ANTHROPIC_API_KEY is not set'));
});

test('config: the namespace has no default, and the MCP endpoint must be https', () => {
  const ok = readConfig(fullEnv);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.config.temporal.namespace, 'default');
    assert.equal(ok.config.mcpUrl.href, 'https://www.mattpyle.com/mcp');
    assert.equal(ok.config.taskQueue, 'audit-consultant');
    assert.equal(ok.config.model, 'claude-sonnet-5-5');
  }
  for (const url of ['http://www.mattpyle.com/mcp', 'file:///etc/passwd', 'not a url']) {
    const bad = readConfig({ ...fullEnv, CONSULTANT_MCP_URL: url });
    assert.equal(bad.ok, false, url);
  }
});

test('the site client names itself and refuses a plain-http endpoint', async () => {
  assert.throws(() => mcpSiteClient(new URL('http://www.mattpyle.com/mcp')));
  const seen: { ua: string | null; body: string }[] = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ ua: new Headers(init?.headers).get('user-agent'), body: String(init?.body ?? '') });
    return new Response('{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"Too many audits"}}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  };
  const site = mcpSiteClient(new URL('https://www.mattpyle.com/mcp'), fakeFetch);
  await site.fastAudit('https://example.com').catch(() => undefined);
  assert.ok(seen.length > 0, 'the client made a request');
  assert.equal(seen[0]!.ua, USER_AGENT);
  assert.match(USER_AGENT, /^audit-consultant\/\S+ \(\+https:\/\/www\.mattpyle\.com\/steward\)$/);
  assert.ok(seen.some((s) => s.body.includes(`"name":"${CLIENT_NAME}"`)), 'clientInfo.name is audit-consultant');
});

test('site facts: the overview names the site, its owner, sections and pages', () => {
  const view = projectSiteFacts(cleanIndex(), 'overview');
  assert.equal(view.topic, 'overview');
  assert.ok(view.topic === 'overview');
  assert.equal(view.site.person?.worksFor, 'Temporal Technologies');
  assert.deepEqual(view.sections.map((s) => s.name), ['Writing']);
  assert.deepEqual(view.pages.map((p) => p.url), ['https://www.mattpyle.com/scorecard/']);
  assert.ok(!JSON.stringify(view).includes('sameAs'), 'only named fields are copied');
});

test('site facts: a list keeps named fields, cuts long text, caps the entries and drops a broken one', () => {
  const writing = projectSiteFacts(cleanIndex(), 'writing');
  assert.ok(writing.topic === 'writing');
  assert.equal(writing.total, 1, 'the entry with no url is dropped');
  assert.equal(writing.entries[0]!.date, '2026-09-03');
  assert.ok(!JSON.stringify(writing).includes('secret'));

  const projects = projectSiteFacts(cleanIndex(), 'projects');
  assert.ok(projects.topic === 'projects');
  assert.equal(projects.entries[0]!.kind, 'live');

  const changelog = projectSiteFacts(cleanIndex(), 'changelog');
  assert.ok(changelog.topic === 'changelog');
  assert.equal(changelog.total, 15);
  assert.equal(changelog.entries.length, 12);
  assert.equal(changelog.entries[0]!.title, 'Entry 1', "the index's own order, newest first");
  assert.equal(changelog.entries[0]!.description.length, 400);
});

test('site facts: an index that is not an index projects to nothing', () => {
  for (const junk of [null, 'text', 42, [], { writing: 'x', site: [] }]) {
    const list = projectSiteFacts(junk, 'writing');
    assert.ok(list.topic === 'writing');
    assert.deepEqual(list.entries, []);
    const overview = projectSiteFacts(junk, 'overview');
    assert.ok(overview.topic === 'overview');
    assert.deepEqual(overview.sections, []);
  }
});

test('site facts: the client reads the content index on the endpoint origin, with no credential', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(cleanIndex()), { status: 200 });
  }) as typeof fetch;
  const call = await mcpSiteClient(new URL('https://www.mattpyle.com/mcp'), fetchImpl).siteFacts();
  assert.equal(call.ok, true);
  assert.equal(seen[0]!.url, `https://www.mattpyle.com${SITE_FACTS_PATH}`);
  assert.equal(seen[0]!.headers['User-Agent'], USER_AGENT);
  assert.ok(!('Authorization' in seen[0]!.headers));

  const down = (async () => new Response('no', { status: 503 })) as typeof fetch;
  assert.deepEqual(await mcpSiteClient(new URL('https://www.mattpyle.com/mcp'), down).siteFacts(), { ok: false, reason: 'error' });
});

test('fix log: the parser keeps a title, a lead and an address it built, and drops the rest', () => {
  const entries = parseFixLog(cleanFixLog());
  assert.equal(entries.length, 6, 'the link to another host and the bad slug are dropped');
  assert.deepEqual(entries[0], {
    title: 'agents.md named only GitHub and LinkedIn as ways to reach Matt',
    url: 'https://www.mattpyle.com/fix-log/agents-md-named-only-github-and-linkedin/',
    lead: 'An agent reading the file would send a person to GitHub or LinkedIn.',
    type: 'agent readiness',
  });
  const text = JSON.stringify(entries);
  assert.ok(!text.includes('evil.example') && !text.includes(MARKER), 'no other link on the page is copied');
  for (const e of entries) assert.match(e.url, /^https:\/\/www\.mattpyle\.com\/fix-log\/[a-z0-9-]+\/$/);
  assert.equal(entries[2]!.lead.length, 400, 'a long lead is cut');
  assert.equal(entries[5]!.lead, '', 'a line that is only a link is not a lead');
  for (const junk of [null, 42, {}, '', '<html><body>Not found</body></html>']) assert.deepEqual(parseFixLog(junk), []);
});

test('fix log: a check finds its entries by the table, named before related, and nothing by guess', () => {
  const entries = parseFixLog(cleanFixLog());
  const view = searchFixLog(entries, ['llms-txt', 'agents-md', 'well-known-mcp-server', 'robots-ai-agents', 'axe-violations']);
  assert.ok(view.status === 'complete');
  assert.equal(view.total, 6);
  const by = Object.fromEntries(view.results.map((r) => [r.check, r.entries.map((e) => `${e.match} ${e.title}`)]));
  assert.deepEqual(by['llms-txt'], [
    'named llms.txt listed no RSS feed for following the site',
    'related The site skill said llms-full.txt held every published word',
  ]);
  assert.deepEqual(by['agents-md'], ['named agents.md named only GitHub and LinkedIn as ways to reach Matt']);
  assert.deepEqual(by['well-known-mcp-server'], [], 'MCP does not match inside WebMCP');
  assert.deepEqual(by['robots-ai-agents'], [], 'the words of an id do not match on their own');
  assert.deepEqual(by['axe-violations'], ['related Screen readers spoke the slash in every nav link']);
});

test('fix log: an id with no row needs every word, a common-word id has an empty row, and odd ids are dropped', () => {
  const entries = parseFixLog(cleanFixLog());
  const view = searchFixLog(entries, ['rss-feed', 'feed-missing', 'fetch', ' LLMS-TXT ', 'llms-txt', 'not an id', 7]);
  assert.deepEqual(
    view.results.map((r) => [r.check, r.matched]),
    [['rss-feed', 1], ['feed-missing', 0], ['fetch', 0], ['llms-txt', 2]],
  );
  assert.equal(view.results[0]!.entries[0]!.match, 'related', 'a match with no row is never named');
  assert.equal(searchFixLog(entries, Array.from({ length: 9 }, (_, i) => `check-${i}`)).results.length, 5);
  const many = Array.from({ length: 9 }, (_, i) => ({ ...entries[1]!, url: `https://www.mattpyle.com/fix-log/e-${i}/` }));
  const capped = searchFixLog(many, ['llms-txt']).results[0]!;
  assert.equal(capped.matched, 9);
  assert.equal(capped.entries.length, 3);
});

test('fix log: every id in the table is a check id, and none is listed twice', () => {
  const ids = CHECK_TABLE.flatMap((r) => r.checks);
  for (const id of ids) assert.match(id, CHECK_ID);
  assert.equal(new Set(ids).size, ids.length);
});

test('fix log: the client reads /fix-log.md with no credential, and refuses a bad status or an oversized page', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const endpoint = new URL('https://www.mattpyle.com/mcp');
  const ok = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(cleanFixLog(), { status: 200 });
  }) as typeof fetch;
  const call = await mcpSiteClient(endpoint, ok).fixLog();
  assert.ok(call.ok && typeof call.data === 'string' && call.data.includes('# Fix log'));
  assert.equal(seen[0]!.url, `https://www.mattpyle.com${FIX_LOG_PATH}`);
  assert.equal(seen[0]!.headers['User-Agent'], USER_AGENT);
  assert.ok(!('Authorization' in seen[0]!.headers));

  const down = (async () => new Response('no', { status: 503 })) as typeof fetch;
  assert.deepEqual(await mcpSiteClient(endpoint, down).fixLog(), { ok: false, reason: 'error' });
  const huge = (async () => new Response('x'.repeat(FIX_LOG_MAX_BYTES + 1), { status: 200 })) as typeof fetch;
  assert.deepEqual(await mcpSiteClient(endpoint, huge).fixLog(), { ok: false, reason: 'error' });
  const dead = (async () => {
    throw new Error('ECONNRESET secret-host');
  }) as typeof fetch;
  await assert.rejects(mcpSiteClient(endpoint, dead).fixLog(), (err: Error) => !err.message.includes('secret-host'));
});

test('replies: one entry per turn, oldest first, bounded by the turn cap', () => {
  let s = newSession({ ...DEFAULT_CAPS, turns: 2 });
  s = withReply({ ...s, turns: 1 }, 'first');
  s = withReply({ ...s, turns: 2 }, 'second');
  s = withReply(s, 'second, again');
  assert.deepEqual(s.replies, [{ turn: 1, text: 'first' }, { turn: 2, text: 'second, again' }]);
  assert.deepEqual(s.lastReply, { turn: 2, text: 'second, again' });
  s = withReply({ ...s, turns: 3 }, 'third');
  assert.deepEqual(s.replies.map((r) => r.turn), [2, 3]);
});
