/** The pure parts: the projection, the caps, the environment, and the site client's identity. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CAPS, capReached, capsFromEnv, newSession, tokensLeft } from '../src/caps.js';
import { readConfig } from '../src/config.js';
import { normaliseOrigin, projectReport } from '../src/project.js';
import { CLIENT_NAME, USER_AGENT, mcpSiteClient } from '../src/site.js';
import { MARKER, cleanReport, hostileReport } from './helpers/reports.js';

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
