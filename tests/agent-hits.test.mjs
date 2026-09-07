import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ABSENT_FAMILY,
  CLIENT_FAMILIES,
  COUNTER_TIME_ZONE,
  EVENTS,
  FALLBACK_FAMILY,
  KEY_VERSION,
  PAGE_CLIENT_FAMILIES,
  MONTHS_KEY,
  ROLLUP_LOCK_KEY,
  UNNAMED_PAGE,
  UNNAMED_WELL_KNOWN,
  classifyClient,
  counterDay,
  counterHour,
  counterPath,
  hitKeys,
  isCounterMonth,
  isPageClient,
  knownFamilies,
  monthFieldFor,
  monthKeyFor,
  monthOf,
  parseHitField,
  parseMonthField,
  readStoreConfig,
  recordHit,
} from '../src/lib/agent-hits.mjs';
import { AGENT_SURFACE_PATHS, WELL_KNOWN_SURFACE_PATHS } from '../src/lib/agent-surfaces.mjs';
import { PAGE_PATHS } from '../src/data/page-paths.mjs';

const middlewareSource = readFileSync(fileURLToPath(new URL('../middleware.ts', import.meta.url)), 'utf8');

// A fetch that records rather than performs, so every network assertion in this file is about what
// the module tried to do, not about a store existing.
function spyFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  impl.calls = calls;
  return impl;
}

const STORE_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

// --- the day and hour buckets -----------------------------------------------------------------

test('buckets are UTC, not local, and this is the deliberate exception', () => {
  // Storage, not a rendered date. Everything people read on this site stays America/Vancouver; a
  // local day written into a key is a lossy choice made at write time that no later render can
  // undo, and UTC matches every system this gets cross-referenced against.
  assert.equal(COUNTER_TIME_ZONE, 'UTC');
  assert.equal(counterDay(new Date('2026-08-05T05:00:00Z')), '2026-08-05');
  assert.equal(counterDay(new Date('2026-08-05T23:59:59Z')), '2026-08-05');
  assert.equal(counterDay(new Date('2026-08-06T00:00:00Z')), '2026-08-06');
});

test('the day is lexically sortable and the hour is zero padded', () => {
  assert.match(counterDay(new Date('2026-01-05T07:30:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(counterHour(new Date('2026-08-04T00:00:00Z')), '00');
  assert.equal(counterHour(new Date('2026-08-04T09:59:59Z')), '09');
  assert.equal(counterHour(new Date('2026-08-04T23:00:00Z')), '23');
});

test('a Vancouver day is reconstructible from the UTC hours, which is the point', () => {
  // The property the schema exists to preserve: an evening in Vancouver spans two UTC days, and
  // the render layer can put it back together because the hour was kept. Vancouver is UTC-7 in
  // August, so 2026-08-04 local starts at 07:00Z on the 4th and ends at 06:00Z on the 5th.
  const evening = new Date('2026-08-05T05:00:00Z'); // 22:00 on the 4th, Vancouver
  assert.equal(counterDay(evening), '2026-08-05');
  assert.equal(counterHour(evening), '05');

  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver' }).format(evening);
  assert.equal(localDay, '2026-08-04');

  // Which UTC (day, hour) pairs a render layer would sum for that local day, both ends inclusive.
  const start = new Date('2026-08-04T07:00:00Z');
  const end = new Date('2026-08-05T06:00:00Z');
  assert.equal(`${counterDay(start)}T${counterHour(start)}` <= `${counterDay(evening)}T${counterHour(evening)}`, true);
  assert.equal(`${counterDay(evening)}T${counterHour(evening)}` <= `${counterDay(end)}T${counterHour(end)}`, true);
});

// --- the classifier ---------------------------------------------------------------------------

test('the named crawlers classify to their own family', () => {
  const cases = [
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot', 'gptbot'],
    ['Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)', 'oai-searchbot'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'chatgpt-user'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'claudebot'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude-User/1.0', 'claude-user'],
    ['Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)', 'claude-searchbot'],
    ['anthropic-ai', 'anthropic-ai'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'perplexitybot'],
    ['Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)', 'perplexity-user'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'googlebot'],
    ['Mozilla/5.0 (compatible; Google-Extended/1.0)', 'google-extended'],
    ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'bingbot'],
    ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'ccbot'],
    ['Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)', 'bytespider'],
    ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta-external'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', 'applebot'],
    ['Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)', 'amazonbot'],
  ];
  for (const [ua, family] of cases) {
    assert.equal(classifyClient(ua), family, ua);
  }
});

test('the live-retrieval clients are families of their own, not one search bucket', () => {
  // The distinction the page class exists to draw: a training crawl and a fetch made because
  // somebody just asked a question are the same company and completely different findings, so
  // they must never share a family. ChatGPT-User, OAI-SearchBot and PerplexityBot are the three
  // named in the card; the two Claude ones are here because they have the same shape.
  const retrieval = {
    'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)': 'chatgpt-user',
    'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)': 'oai-searchbot',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)': 'perplexitybot',
    'Mozilla/5.0 (compatible; Perplexity-User/1.0)': 'perplexity-user',
    'Mozilla/5.0 (compatible; Claude-User/1.0)': 'claude-user',
  };
  const training = {
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)': 'gptbot',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)': 'claudebot',
  };

  for (const [ua, family] of Object.entries({ ...retrieval, ...training })) {
    assert.equal(classifyClient(ua), family, ua);
  }

  const families = [...Object.values(retrieval), ...Object.values(training)];
  assert.equal(new Set(families).size, families.length, 'no two of these may share a family');
});

test('a longer crawler name is not swallowed by the shorter one it contains', () => {
  // Applebot-Extended contains "Applebot". Ordering is the whole defence, so it gets its own test.
  assert.equal(classifyClient('Mozilla/5.0 (compatible; Applebot-Extended/0.1)'), 'applebot-extended');
});

test('the script tells classify separately from browsers', () => {
  assert.equal(classifyClient('curl/8.7.1'), 'curl');
  assert.equal(classifyClient('Wget/1.21.4'), 'wget');
  assert.equal(classifyClient('python-requests/2.32.3'), 'python');
  assert.equal(classifyClient('node'), FALLBACK_FAMILY); // bare "node" is not a UA shape
  assert.equal(classifyClient('node/24.3.0'), 'node');
  assert.equal(classifyClient('undici/6'), 'node');
  assert.equal(classifyClient('Go-http-client/2.0'), 'go');
});

test('a real browser classifies as browser', () => {
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const safari =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(classifyClient(chrome), 'browser');
  assert.equal(classifyClient(safari), 'browser');
});

test('an unnamed crawler counts as a bot, not as a person', () => {
  // Almost every crawler hides inside a Mozilla/5.0 string. If the generic-bot rule ever falls
  // below the browser rule, this page starts reporting robots as human traffic.
  const unnamed = 'Mozilla/5.0 (compatible; SomeNewBot/1.0; +https://example.com/bot)';
  assert.equal(classifyClient(unnamed), 'other-bot');
  assert.equal(classifyClient('Mozilla/5.0 (compatible; YandexRenderResourcesBot/1.0)'), 'other-bot');
});

test("the site's own auditor is a named family, not a nameless bot", () => {
  // Steward reads 25 pages here every night and audits other people's sites under the same
  // token. If the generic-bot rule ever climbed above it, /activity would show the one crawler
  // this site can name with certainty as `other-bot`.
  const steward = 'steward-audit/0.2.0 (+https://www.mattpyle.com/steward)';
  assert.equal(classifyClient(steward), 'steward-audit');
  assert.notEqual(classifyClient(steward), 'other-bot');
  assert.ok(knownFamilies().includes('steward-audit'));
  // A page load by it is a page load /activity stores.
  assert.equal(isPageClient('steward-audit'), true);
});

test('garbage lands in other and mints no new family', () => {
  const garbage = '<script>alert(1)</script>   ' + 'x'.repeat(4000);
  assert.equal(classifyClient(garbage), FALLBACK_FAMILY);
  assert.ok(knownFamilies().includes(classifyClient(garbage)));
  assert.equal(classifyClient('hello there'), FALLBACK_FAMILY);
});

test('an absent user agent is its own family, not unknown', () => {
  assert.equal(classifyClient(null), ABSENT_FAMILY);
  assert.equal(classifyClient(undefined), ABSENT_FAMILY);
  assert.equal(classifyClient('   '), ABSENT_FAMILY);
});

test('the family list is data and every family is unique', () => {
  const families = knownFamilies();
  assert.equal(new Set(families).size, families.length);
  assert.ok(CLIENT_FAMILIES.every(({ family, match }) => typeof family === 'string' && match instanceof RegExp));
});

test('every crawler robots.txt names has a family, or is accounted for', () => {
  // The one list that should track the other. A crawler welcomed by name but counted as
  // "other-bot" is a row this page silently cannot show.
  const robotsSource = readFileSync(fileURLToPath(new URL('../src/pages/robots.txt.ts', import.meta.url)), 'utf8');
  const named = [...robotsSource.matchAll(/^User-agent: (?!\*)(.+)$/gm)].map((match) => match[1].trim());
  assert.ok(named.length > 10, 'robots.txt should still name the AI crawlers');
  for (const agent of named) {
    const family = classifyClient(`Mozilla/5.0 (compatible; ${agent}/1.0)`);
    assert.notEqual(family, FALLBACK_FAMILY, `${agent} falls through to ${FALLBACK_FAMILY}`);
    assert.notEqual(family, 'other-bot', `${agent} is welcomed by name but counted as other-bot`);
  }
});

// --- the page class's client rule -------------------------------------------------------------

test('every named family counts for the page class except the one that is a person', () => {
  for (const { family } of CLIENT_FAMILIES) {
    assert.equal(isPageClient(family), family !== 'browser', family);
  }
  // The two fallbacks are not named families and never count: "we could not tell" and "it did not
  // say" are both a client this site cannot claim is a bot.
  assert.equal(isPageClient(FALLBACK_FAMILY), false);
  assert.equal(isPageClient(ABSENT_FAMILY), false);
  assert.equal(PAGE_CLIENT_FAMILIES.includes('browser'), false);
});

// --- the key schema ---------------------------------------------------------------------------

test('every key carries the version prefix', () => {
  const keys = hitKeys({ event: 'surface', path: '/llms.txt', ua: 'curl/8', now: new Date('2026-08-04T20:00:00Z') });
  for (const key of [keys.dayKey, keys.daysKey, keys.totalKey]) {
    assert.ok(key.startsWith(`hits:${KEY_VERSION}:`), key);
  }
});

test('the key schema is exactly three commands in one pipeline', () => {
  // One HTTP round trip per request is the budget. A fourth command is a design change, not a
  // detail, so it fails here first.
  const keys = hitKeys({ event: 'surface', path: '/agents.md', ua: 'curl/8', now: new Date('2026-08-04T20:00:00Z') });
  assert.deepEqual(keys.commands, [
    ['HINCRBY', 'hits:v1:day:2026-08-04', '20|surface|curl|/agents.md', '1'],
    ['SADD', 'hits:v1:days', '2026-08-04'],
    ['INCR', 'hits:v1:total'],
  ]);
});

test('the rollup keys carry the version prefix and no hit ever writes one', () => {
  const keys = hitKeys({ event: 'surface', path: '/llms.txt', ua: 'curl/8', now: new Date('2026-08-04T20:00:00Z') });
  for (const key of [MONTHS_KEY, monthKeyFor('2026-08'), ROLLUP_LOCK_KEY]) {
    assert.ok(key.startsWith(`hits:${KEY_VERSION}:`), key);
  }
  // The write path is the day keys and nothing else; the read path owns the rollup.
  const written = keys.commands.map(([, key]) => key);
  for (const key of [MONTHS_KEY, monthKeyFor('2026-08'), ROLLUP_LOCK_KEY]) {
    assert.ok(!written.includes(key), key);
  }
});

test('a month field is a day field with the hour dropped, and the two cannot be confused', () => {
  const keys = hitKeys({ event: 'surface', path: '/llms.txt', ua: 'curl/8', now: new Date('2026-08-04T20:00:00Z') });
  const parsed = parseHitField(keys.field);
  const monthField = monthFieldFor(parsed);

  assert.equal(monthField, 'surface|curl|/llms.txt');
  assert.equal(monthField.split('|').length, 3);
  assert.deepEqual(parseMonthField(monthField), { event: 'surface', family: 'curl', path: '/llms.txt' });

  // Four parts is a day field and three is a month field, in both directions, so a field can never
  // be read by the wrong parser without a version bump.
  assert.equal(parseMonthField(keys.field), null);
  assert.equal(parseHitField(monthField), null);
});

test('a month is the first seven characters of a day, and only a real month passes', () => {
  assert.equal(monthOf('2026-08-04'), '2026-08');
  for (const month of ['2026-08', '2026-01', '2026-12']) assert.equal(isCounterMonth(month), true, month);
  for (const month of ['2026-13', '2026-00', '2026-8', '26-08', '2026-08-04', 'nonsense', '']) {
    assert.equal(isCounterMonth(month), false, month);
  }
});

test('the field is hour, event, family, path and cannot be ambiguous', () => {
  const keys = hitKeys({ event: 'markdown', path: '/about/', ua: null, now: new Date('2026-08-04T20:00:00Z') });
  assert.equal(keys.field, `20|markdown|${ABSENT_FAMILY}|/about`);
  assert.equal(keys.field.split('|').length, 4);
  assert.equal(keys.hour, '20');
  assert.equal(keys.day, '2026-08-04');
});

test('the hour leads the field so one hour is a prefix match and a day sorts chronologically', () => {
  const at = (iso) => hitKeys({ event: 'surface', path: '/llms.txt', ua: 'curl/8', now: new Date(iso) }).field;
  const morning = at('2026-08-04T09:15:00Z');
  const evening = at('2026-08-04T21:15:00Z');
  assert.ok(morning.startsWith('09|'));
  assert.ok(evening.startsWith('21|'));
  assert.ok(morning < evening, 'zero padded hours must sort lexically');
});

test('every event class is countable and nothing else is', () => {
  for (const event of EVENTS) {
    assert.ok(hitKeys({ event, path: '/', ua: 'curl/8' }).field.includes(`|${event}|`));
  }
  assert.throws(() => hitKeys({ event: 'pageview', path: '/', ua: 'curl/8' }), /unknown event class/);
});

test('every advertised surface keeps its own path key', () => {
  for (const path of [...AGENT_SURFACE_PATHS, ...WELL_KNOWN_SURFACE_PATHS]) {
    assert.equal(counterPath('surface', path), path);
    assert.equal(counterPath('surface', `${path}/`), path);
  }
});

test('an unpublished well-known path buckets rather than minting a key', () => {
  // The whole /.well-known subtree reaches the middleware, and a stranger can ask for any name in
  // it. Bucketing is what keeps that from being an unbounded key generator.
  assert.equal(counterPath('surface', '/.well-known/ai-plugin.json'), UNNAMED_WELL_KNOWN);
  assert.equal(counterPath('surface', '/.well-known/whatever-they-invent-next'), UNNAMED_WELL_KNOWN);
  assert.equal(counterPath('surface', `/.well-known/${'x'.repeat(500)}`), UNNAMED_WELL_KNOWN);
});

test('page paths keep their own key and hostile shapes do not', () => {
  assert.equal(counterPath('markdown', '/writing/accessibility-and-ai/'), '/writing/accessibility-and-ai');
  assert.equal(counterPath('markdown', '/'), '/');
  assert.equal(counterPath('markdown', `/writing/${'x'.repeat(200)}`), UNNAMED_PAGE);
  assert.equal(counterPath('markdown', '/a/b/c/d/e/f'), UNNAMED_PAGE);
  assert.equal(counterPath('markdown', '/writing/Foo?bar=1'), UNNAMED_PAGE);
  assert.equal(counterPath('markdown', '/writing/%00'), UNNAMED_PAGE);
});

test('a page hit keys exactly like the other two classes', () => {
  const keys = hitKeys({
    event: 'page',
    path: '/writing/accessibility-and-ai/',
    ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
    now: new Date('2026-08-04T20:00:00Z'),
  });
  assert.deepEqual(keys.commands, [
    ['HINCRBY', 'hits:v1:day:2026-08-04', '20|page|perplexitybot|/writing/accessibility-and-ai', '1'],
    ['SADD', 'hits:v1:days', '2026-08-04'],
    ['INCR', 'hits:v1:total'],
  ]);
  assert.equal(keys.field.split('|').length, 4);
});

test('a published page keeps its own key and anything else buckets', () => {
  // The bound on this class, and the reason it needs one: the middleware counts a page fetch
  // WITHOUT knowing the response status, so a request for a page that does not exist reaches the
  // counter exactly like a crawler reading a real post. The generated list is the only thing
  // standing between that and an unbounded key space.
  for (const path of PAGE_PATHS) {
    assert.equal(counterPath('page', path), path);
    assert.equal(counterPath('page', path === '/' ? '/' : `${path}/`), path);
  }

  assert.equal(counterPath('page', '/writing/no-such-post'), UNNAMED_PAGE);
  assert.equal(counterPath('page', '/writing/a'), UNNAMED_PAGE);
  assert.equal(counterPath('page', `/writing/${'x'.repeat(200)}`), UNNAMED_PAGE);
  assert.equal(counterPath('page', '/writing/Foo?bar=1'), UNNAMED_PAGE);

  // The markdown class is bounded by its own upstream 200 and is deliberately NOT filtered by the
  // list, so a page published since the last build still counts by name there.
  assert.equal(counterPath('markdown', '/writing/no-such-post'), '/writing/no-such-post');
});

test('the generated page list is canonical, so a lookup can never miss on a slash', () => {
  for (const path of PAGE_PATHS) {
    assert.ok(path.startsWith('/'), path);
    assert.equal(path === '/' || !path.endsWith('/'), true, path);
    assert.equal(path, path.toLowerCase(), path);
  }
  assert.ok(PAGE_PATHS.includes('/'), 'the homepage is a page');
  assert.equal(new Set(PAGE_PATHS).size, PAGE_PATHS.length);
});

test('a garbage request cannot widen the key space in any component', () => {
  const keys = hitKeys({
    event: 'markdown',
    path: '/x/y/z/q/r/s/t',
    ua: 'definitely-not-a-real-client ' + 'z'.repeat(9000),
    now: new Date('2026-08-04T20:00:00Z'),
  });
  assert.equal(keys.field, `20|markdown|${FALLBACK_FAMILY}|${UNNAMED_PAGE}`);
  assert.ok(keys.field.length < 64);
});

// --- the transport ----------------------------------------------------------------------------

test('no env vars means no store, no throw, and no fetch attempted', async () => {
  // The env-absent path is the one that has to hold: this ships before the integration is
  // provisioned, and local dev never has a store at all.
  const fetchImpl = spyFetch();
  const result = await recordHit({ event: 'surface', path: '/llms.txt', ua: 'curl/8', env: {}, fetchImpl });
  assert.deepEqual(result, { ok: false, reason: 'no-store' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('half a config is no config', async () => {
  const fetchImpl = spyFetch();
  const env = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' };
  assert.equal(readStoreConfig(env), null);
  await recordHit({ event: 'surface', path: '/llms.txt', ua: 'curl/8', env, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test('either env var pair configures the store, and a trailing slash is trimmed', () => {
  assert.deepEqual(readStoreConfig({ ...STORE_ENV }), { url: 'https://example.upstash.io', token: 'token' });
  assert.deepEqual(readStoreConfig({ KV_REST_API_URL: 'https://a/', KV_REST_API_TOKEN: 'b' }), {
    url: 'https://a',
    token: 'b',
  });
});

test('a hit is one POST to the pipeline endpoint carrying all three commands', async () => {
  const fetchImpl = spyFetch();
  const result = await recordHit({
    event: 'surface',
    path: '/llms.txt',
    ua: 'curl/8.7.1',
    now: new Date('2026-08-04T20:00:00Z'),
    env: STORE_ENV,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://example.upstash.io/pipeline');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(call.init.body), [
    ['HINCRBY', 'hits:v1:day:2026-08-04', '20|surface|curl|/llms.txt', '1'],
    ['SADD', 'hits:v1:days', '2026-08-04'],
    ['INCR', 'hits:v1:total'],
  ]);
});

test('the request body carries no user agent, no header and no per-request detail', async () => {
  // The privacy promise, asserted rather than described. Whatever else changes in here, the raw
  // user agent must never appear in what goes over the wire.
  const ua = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
  const fetchImpl = spyFetch();
  await recordHit({ event: 'surface', path: '/agents.md', ua, env: STORE_ENV, fetchImpl });
  const body = fetchImpl.calls[0].init.body;
  assert.equal(body.includes(ua), false);
  assert.equal(body.includes('anthropic.com'), false);
  assert.equal(body.includes('Mozilla'), false);
  assert.ok(body.includes('claudebot'));
});

test('a store error is undercounting, never a throw', async () => {
  const failing = spyFetch(new Error('ECONNRESET'));
  const result = await recordHit({ event: 'surface', path: '/llms.txt', ua: 'curl/8', env: STORE_ENV, fetchImpl: failing });
  assert.equal(result.ok, false);

  const rejected = await recordHit({
    event: 'surface',
    path: '/llms.txt',
    ua: 'curl/8',
    env: STORE_ENV,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.deepEqual(rejected.reason, 'status-500');
});

test('a named bot reading a page is counted', async () => {
  const fetchImpl = spyFetch();
  const result = await recordHit({
    event: 'page',
    path: '/writing/accessibility-and-ai/',
    ua: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
    now: new Date('2026-08-04T20:00:00Z'),
    env: STORE_ENV,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body)[0], [
    'HINCRBY',
    'hits:v1:day:2026-08-04',
    '20|page|chatgpt-user|/writing/accessibility-and-ai',
    '1',
  ]);
});

test('a browser reading a page is not counted, and no fetch is attempted', async () => {
  // The promise the class is allowed to exist under. This is not undercounting and not a fail-open
  // path: a person reading a post is never a row in this store, and the assertion is that nothing
  // even went over the wire to find out.
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const fetchImpl = spyFetch();
  const result = await recordHit({ event: 'page', path: '/about/', ua: chrome, env: STORE_ENV, fetchImpl });
  assert.deepEqual(result, { ok: false, reason: 'not-a-bot' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('an unrecognised or absent client reading a page is not counted either', async () => {
  for (const ua of ['hello there', null, undefined, '   ']) {
    const fetchImpl = spyFetch();
    const result = await recordHit({ event: 'page', path: '/about/', ua, env: STORE_ENV, fetchImpl });
    assert.equal(result.reason, 'not-a-bot', String(ua));
    assert.equal(fetchImpl.calls.length, 0, String(ua));
  }
});

test('the bots-only rule is on the page class alone', async () => {
  // A browser fetching /llms.txt is a real and interesting record, and always has been. The client
  // condition belongs to the new class, not to the counter.
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  for (const event of ['surface', 'markdown']) {
    const fetchImpl = spyFetch();
    const result = await recordHit({ event, path: '/llms.txt', ua: chrome, env: STORE_ENV, fetchImpl });
    assert.equal(result.ok, true, event);
    assert.equal(fetchImpl.calls.length, 1, event);
  }
});

test('a bad event class fails inside recordHit rather than reaching the caller', async () => {
  const fetchImpl = spyFetch();
  const result = await recordHit({ event: 'nope', path: '/llms.txt', ua: 'curl/8', env: STORE_ENV, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

// --- the wiring -------------------------------------------------------------------------------

test('the middleware counts an ordinary page serve, and only when it serves one', () => {
  // The count sits on the next() branch of slashRedirectOrNext, never beside the 308: a redirected
  // request was not served a page, and the canonical follow-up re-enters and is counted normally.
  assert.match(middlewareSource, /if \(isPage\) countHit\('page', url\.pathname, request\);\s*\n\s*return next\(\);/);
  // isPage is false for a path with no markdown sibling, which is every `.md` URL — so the proxy
  // fetch below cannot count its own internal request as a second page view.
  assert.match(middlewareSource, /slashRedirectOrNext\(url, request, Boolean\(sibling\)\)/);
  assert.doesNotMatch(middlewareSource, /countHit\('page', [^)]*\);\s*\n\s*const location/);
});

test('the middleware counts both event classes and still logs each one', () => {
  // The counter and the console line are separate failure domains on purpose. If a later edit
  // merges them into one try block, a store outage takes the debugging view with it.
  assert.match(middlewareSource, /countHit\('surface', url\.pathname, request\)/);
  assert.match(middlewareSource, /countHit\('markdown', url\.pathname, request\)/);
  assert.match(middlewareSource, /console\.log\(\s*formatSurfaceLine\(/);
  // Both [markdown] lines go through the shared helper rather than a template literal, so a
  // request-controlled value cannot forge a field or a whole extra line. `hit` and `miss` are a
  // `result=` field for the same reason: the line is built from data, not concatenated prose.
  assert.match(middlewareSource, /console\.log\(formatLogLine\('markdown', \{ result: 'hit'/);
  assert.match(middlewareSource, /console\.log\(formatLogLine\('markdown', \{ result: 'miss'/);
  assert.doesNotMatch(middlewareSource, /console\.log\(`\[markdown\]/);
});

test('counting is fired through waitUntil and wrapped', () => {
  assert.match(middlewareSource, /waitUntil\(recordHit\(/);
  assert.match(middlewareSource, /try \{\s*waitUntil\(recordHit\([\s\S]*?\} catch \{/);
});
