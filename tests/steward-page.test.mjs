import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The auditor's identity, wherever this repo writes it down for a person to read.
 *
 * Three public surfaces quote the User-Agent verbatim — the /steward page, public/agents.md, and
 * the robots.txt refusal snippet each of them prints — and none of them can import the constant.
 * `AUDIT_USER_AGENT` lives in the Steward workspace, whose exports map publishes one entry for one
 * consumer (src/pages/mcp.ts); a prerendered page or a static file reaching into the workspace
 * would put it in the static build's graph, which is the packaging rule the /mcp docblock states.
 *
 * So the copies are pinned here instead. The failure this prevents is specific and silent: a
 * version bump on the User-Agent leaves a page telling a site owner to match a string that no
 * longer arrives, and the only person who finds out is the one who was already inconvenienced
 * enough to go looking.
 *
 * The token is checked as well as the string, because the refusal snippet is the actionable half.
 * A robots.txt rule naming a token the auditor does not send is a refusal that does nothing.
 */

// Line endings normalised: these files are checked out with CRLF on Windows and LF on a runner, and
// every assertion below is about content rather than about how git wrote the file.
const read = relative =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const safeFetch = read('agents/steward/src/lib/agent-audit/safe-fetch.ts');
const checks = read('agents/steward/src/lib/agent-audit/checks.ts');

// The User-Agent is a template literal over `AUDIT_VERSION`, the one place the auditor's version is
// written down, so it is rebuilt here the way the workspace builds it rather than read as a string.
const version = safeFetch.match(/export const AUDIT_VERSION = '([^']+)'/)?.[1];
const userAgentTemplate = safeFetch.match(/export const AUDIT_USER_AGENT = `([^`]+)`/)?.[1];
const userAgent = userAgentTemplate?.replace('${AUDIT_VERSION}', version ?? '');
const token = checks.match(/export const AUDIT_AGENT_TOKEN = '([^']+)'/)?.[1];

test('the constants this test pins are still where it looks for them', () => {
  // Read by regex rather than imported: these are TypeScript, and this suite is plain `node --test`
  // with no loader. A rename that moves either constant has to fail here loudly rather than leave
  // every assertion below quietly comparing undefined to undefined.
  assert.ok(version, 'AUDIT_VERSION not found in agents/steward/src/lib/agent-audit/safe-fetch.ts');
  assert.ok(
    userAgentTemplate,
    'AUDIT_USER_AGENT is not a template literal in agents/steward/src/lib/agent-audit/safe-fetch.ts'
  );
  assert.ok(token, 'AUDIT_AGENT_TOKEN not found in agents/steward/src/lib/agent-audit/checks.ts');
  assert.equal(userAgent.split('/')[0], token);
  assert.equal(userAgent.split('/')[1].split(' ')[0], version);
});

test('the /steward page quotes the User-Agent and the token exactly', () => {
  const page = read('src/pages/steward.astro');
  assert.equal(page.match(/const USER_AGENT = '([^']+)'/)?.[1], userAgent);
  assert.equal(page.match(/const AGENT_TOKEN = '([^']+)'/)?.[1], token);
});

test('agents.md quotes the User-Agent and the refusal token exactly', () => {
  const agents = read('public/agents.md');
  assert.ok(agents.includes(`\`${userAgent}\``), `agents.md does not carry ${userAgent}`);
  assert.ok(
    agents.includes(`User-agent: ${token}\nDisallow: /`),
    `agents.md's refusal snippet does not name ${token}`
  );
});

test('the limits table renders the caps this deployment enforces, not the defaults', () => {
  // The page is the public contract for what an audit costs a caller, so it has to read the same
  // env-or-default resolution the limiter does. Rendering the exported DEFAULT_* constants made it
  // advertise 2 deep audits per caller while production ran 4.
  //
  // Asserted against the source because the numbers only exist once the page is built, and the
  // resolvers' own behaviour is already covered by tests/mcp-deep-rate-limit.test.mjs.
  const page = read('src/pages/steward.astro');

  assert.match(page, /readLimits\(process\.env\)/, 'the fast caps must resolve through readLimits');
  assert.match(
    page,
    /readDeepLimits\(process\.env\)/,
    'the deep caps must resolve through readDeepLimits'
  );
  assert.doesNotMatch(
    page,
    /\{DEFAULT_[A-Z_]+\}/,
    'a DEFAULT_ constant rendered into the page is a cap that ignores the environment'
  );
});

test('the User-Agent points at a page this site actually serves', () => {
  // The URL in a User-Agent comment is the whole reason a site owner ever reaches any of this. A
  // string pointing at a 404 is worse than one pointing nowhere, because it costs somebody a click
  // to find that out.
  const url = userAgent.match(/\(\+(https:\/\/[^)]+)\)/)?.[1];
  assert.equal(url, 'https://www.mattpyle.com/steward');
  assert.ok(
    readFileSync(fileURLToPath(new URL('../src/pages/steward.astro', import.meta.url))).length > 0
  );
});

test('the discovery document names the endpoint and the server', () => {
  const manifest = JSON.parse(read('public/.well-known/mcp-server'));
  assert.equal(manifest.endpoint, 'https://www.mattpyle.com/mcp');
  assert.equal(manifest.docs, 'https://www.mattpyle.com/steward');
  // The same required fields scripts/validate-mcp-discovery.mjs enforces in the build chain,
  // asserted here too so a broken document fails a test run and not only a build.
  for (const field of ['mcp_version', 'name', 'endpoint', 'transport']) {
    assert.equal(typeof manifest[field], 'string', `${field} must be a string`);
  }
});

test('the discovery document describes the fast tier and leaves the deep tier to tools/list', () => {
  // The endpoint grew from one tool to three after this document was first written. The decision
  // that survived the growth is that the document still describes the fast tier only: every agent
  // that goes looking for an MCP server reads it, and a capped minutes-long tool advertised that
  // widely is a different traffic shape from a synchronous one. The build validator asserts the
  // same thing; it is here too so the decision fails a test run and not only a build.
  const { description } = JSON.parse(read('public/.well-known/mcp-server'));
  assert.match(description, /audit_site/);
  assert.doesNotMatch(description, /deep_audit|get_audit/);
});
