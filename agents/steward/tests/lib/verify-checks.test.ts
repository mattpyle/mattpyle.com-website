import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CheckBroken,
  CheckUnavailable,
  parseVerifyReply,
  readHandoffVerify,
  runChecks,
  validateVerifyBlock,
  verifyBlockGuide,
  withVerifyBlock,
  type CheckRunner,
  type VerifyCheck,
} from '../../src/lib/verify-checks.js';
import { HANDOFF_GENERATOR_TOOLS, handoffGeneratorPrompt, validateHandoff } from '../../src/lib/fixer.js';
import { VERIFY_BLOCK_SYSTEM_PROMPT, handoffGeneratorArgs, verifyBlockPrompt } from '../../src/lib/handoff-generator.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, ORIGIN } from '../helpers/finding-fixtures.js';

/**
 * The verifier's checks: the block's rules, then each of the six kinds run
 * against a mock origin. The four fetch kinds make real requests to it. The
 * two browser kinds run through a probe that answers for the page, since the
 * suite launches no browser; `chrome-probe.ts` is the real one.
 */

const FEED = '<rss><channel><link>https://www.mattpyle.com/changelog/</link><item><link>https://www.mattpyle.com/changelog/a/</link></item></channel></rss>';

let server: http.Server;
let origin: string;
const seen: { url: string; accept: string; agent: string }[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', accept: String(req.headers.accept ?? ''), agent: String(req.headers['user-agent'] ?? '') });
    const wantsMarkdown = String(req.headers.accept ?? '').includes('text/markdown');
    if (req.url === '/audit/') {
      res.writeHead(200, { 'Content-Type': 'text/html', Link: '</audit.md>; rel="alternate"; type="text/markdown"' });
      res.end('<html><head><link rel="alternate" type="text/markdown" href="/audit.md"></head><body>Audit</body></html>');
    } else if (req.url === '/about/' && wantsMarkdown) {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', Vary: 'Accept' });
      res.end('# About\n\n[Temporal](https://temporal.io/)\n');
    } else if (req.url === '/about/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><a href="https://temporal.io/">Temporal (opens in a new tab)</a></body></html>');
    } else if (req.url === '/changelog/rss.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(FEED);
    } else if (req.url === '/old/') {
      res.writeHead(308, { Location: '/about/' });
      res.end();
    } else if (req.url === '/down/') {
      res.writeHead(503);
      res.end('deploying');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>Not found</body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** A probe that answers each expression from a table, and records what it was asked. */
function fakeProbe(answers: (url: string, expression: string) => unknown) {
  const asked: { url: string; expression: string }[] = [];
  let opened = 0;
  let closed = 0;
  const runner: Pick<CheckRunner, 'openProbe'> = {
    openProbe: async () => {
      opened++;
      return {
        evaluate: async (url, expression) => {
          asked.push({ url, expression });
          return answers(url, expression);
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  return { runner, asked, counts: () => ({ opened, closed }) };
}

const noBrowser: Pick<CheckRunner, 'openProbe'> = {
  openProbe: async () => {
    throw new Error('a fetch kind must not open a browser');
  },
};

async function run(checks: VerifyCheck[], probe: Pick<CheckRunner, 'openProbe'> = noBrowser) {
  return runChecks(checks, { fetch, userAgent: 'steward-test/1', ...probe });
}

const check = (path: string, kind: VerifyCheck['kind'], expect: unknown): VerifyCheck => ({ url: `${origin}${path}`, kind, expect });

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

const GOOD: VerifyCheck[] = [
  { url: `${ORIGIN}/steward.md`, kind: 'text', expect: { count: 0, of: 'data-astro-cid' } },
  { url: `${ORIGIN}/`, kind: 'selector', expect: { selector: 'footer nav', attribute: 'aria-label', equals: 'Footer' } },
];

test('a block of known kinds on the production origin is admitted, and an empty one too', () => {
  assert.deepEqual(validateVerifyBlock(GOOD, ORIGIN), { checks: GOOD, problems: [] });
  assert.deepEqual(validateVerifyBlock([], ORIGIN), { checks: [], problems: [] });
  const every: VerifyCheck[] = [
    { url: `${ORIGIN}/x/`, kind: 'status', expect: 404 },
    { url: `${ORIGIN}/`, kind: 'header', expect: { name: 'link', contains: 'text/markdown' } },
    { url: `${ORIGIN}/`, kind: 'header', expect: { name: 'x-robots-tag', absent: true } },
    { url: `${ORIGIN}/`, kind: 'text', expect: { contains: 'Matt' } },
    { url: `${ORIGIN}/rss.xml`, kind: 'text', expect: { capture: '<link>([^<]*)</link>', equals: `${ORIGIN}/` } },
    { url: `${ORIGIN}/about/`, kind: 'markdown', expect: { count: 0, of: 'opens in a new tab' } },
    { url: `${ORIGIN}/`, kind: 'selector', expect: { selector: 'h1', count: 1 } },
    { url: `${ORIGIN}/`, kind: 'selector', expect: { selector: 'h1', text: 'Matt Pyle' } },
    { url: `${ORIGIN}/`, kind: 'js', expect: { expression: 'document.title', equals: 'Matt Pyle' } },
  ];
  assert.deepEqual(validateVerifyBlock(every, ORIGIN).problems, []);
});

test('a block is refused for an unknown kind, a URL off the production origin, or a malformed expect', () => {
  const refused = (raw: unknown, pattern: RegExp) => {
    const result = validateVerifyBlock(raw, ORIGIN);
    assert.match(result.problems.join('; '), pattern);
    assert.deepEqual(result.checks, [], 'a refused block yields nothing to run');
  };
  refused('curl -s https://www.mattpyle.com/', /not a list/);
  refused([{ url: `${ORIGIN}/`, kind: 'shell', expect: 'rm -rf .' }], /unknown kind "shell"/);
  refused([{ url: 'https://example.com/', kind: 'status', expect: 200 }], /names https:\/\/example\.com, not the production origin/);
  refused([{ url: 'https://www.mattpyle.com.evil.test/', kind: 'status', expect: 200 }], /not the production origin/);
  refused([{ url: 'https://www.mattpyle.com@evil.test/', kind: 'status', expect: 200 }], /not the production origin/);
  refused([{ url: 'http://www.mattpyle.com/', kind: 'status', expect: 200 }], /not the production origin/);
  refused([{ url: '/about/', kind: 'status', expect: 200 }], /no full URL/);
  refused([{ url: `${ORIGIN}/`, kind: 'status', expect: 'ok' }], /not an HTTP status code/);
  refused([{ url: `${ORIGIN}/`, kind: 'text', expect: { capture: '(', equals: 'x' } }], /not a regular expression/);
  refused([{ url: `${ORIGIN}/`, kind: 'text', expect: { contains: 'a', count: 1 } }], /none of/);
  refused([{ url: `${ORIGIN}/`, kind: 'js', expect: { expression: 'document.title' } }], /not \{expression, equals\}/);
  refused([{ url: `${ORIGIN}/`, kind: 'status', expect: 200, command: 'curl' }], /not \{url, kind, expect\}/);
  // One bad check refuses the whole block, the good check beside it included.
  refused([...GOOD, { url: 'https://example.com/', kind: 'status', expect: 200 }], /verify check 3/);
  refused(Array.from({ length: 13 }, () => GOOD[0]), /13 checks, over 12/);
});

test('validateHandoff admits a good block and refuses a bad or a missing one', () => {
  const withBlock = (yaml: string) => DEFECT_HANDOFF.replace('verify: []', yaml);
  const good = withBlock(
    ['verify:', `  - url: ${ORIGIN}/scorecard/`, '    kind: text', '    expect: {count: 0, of: "100/100 (Fail)"}'].join('\n'),
  );
  assert.deepEqual(validateHandoff(good, DEFECT_KEY, ORIGIN), []);
  assert.deepEqual(validateHandoff(DEFECT_HANDOFF, DEFECT_KEY, ORIGIN), [], 'an empty list is a block');

  const problems = (markdown: string) => validateHandoff(markdown, DEFECT_KEY, ORIGIN).join('; ');
  assert.match(
    problems(withBlock(['verify:', `  - url: ${ORIGIN}/scorecard/`, '    kind: curl', '    expect: 200'].join('\n'))),
    /unknown kind "curl"/,
  );
  assert.match(
    problems(withBlock(['verify:', '  - url: http://localhost:4321/scorecard/', '    kind: status', '    expect: 200'].join('\n'))),
    /not the production origin/,
  );
  assert.match(problems(DEFECT_HANDOFF.replace('---\nverify: []\n---\n\n', '')), /no "verify" list/);
  // The good block refused against another site's origin: the origin is an argument, not a constant.
  assert.match(validateHandoff(good, DEFECT_KEY, 'https://temporal.io').join('; '), /not the production origin/);
});

test('a block is written into a handoff that has none, and reads back as the same checks', () => {
  const bare = DEFECT_HANDOFF.replace('---\nverify: []\n---\n\n', '');
  assert.equal(readHandoffVerify(bare).present, false);

  const written = withVerifyBlock(bare, GOOD);
  const read = readHandoffVerify(written);
  assert.equal(read.present, true);
  assert.deepEqual(validateVerifyBlock(read.raw, ORIGIN), { checks: GOOD, problems: [] });
  assert.equal(read.body, bare, 'the handoff under the frontmatter is unchanged');
  assert.ok(written.startsWith('---\nverify:\n  - url: '));
  assert.deepEqual(validateHandoff(written, DEFECT_KEY, ORIGIN), []);
  assert.equal(withVerifyBlock(written, GOOD), written, 'writing the same block twice changes nothing');
});

test("a model's reply is read as a verify key, fenced or bare, and anything else is not a block", () => {
  const yaml = ['verify:', `  - url: ${ORIGIN}/steward.md`, '    kind: text', '    expect: {count: 0, of: "data-astro-cid"}'].join('\n');
  for (const reply of [yaml, `\`\`\`yaml\n${yaml}\n\`\`\``, `---\n${yaml}\n---`]) {
    const parsed = parseVerifyReply(reply);
    assert.equal(parsed.present, true);
    assert.deepEqual(validateVerifyBlock(parsed.raw, ORIGIN).checks, [GOOD[0]]);
  }
  assert.deepEqual(parseVerifyReply('verify: []'), { present: true, raw: [] });
  assert.equal(parseVerifyReply('I could not find a measure.').present, false);
});

test('both generators are told the same six kinds and the one origin, and the block generator only reads', () => {
  const whole = handoffGeneratorPrompt({ key: DEFECT_KEY, finding: DEFECT_FINDING, origin: ORIGIN });
  const block = verifyBlockPrompt({ key: DEFECT_KEY, finding: DEFECT_FINDING, handoff: DEFECT_HANDOFF, origin: ORIGIN });
  for (const prompt of [whole, block]) {
    assert.match(prompt, /`url` is a full URL on https:\/\/www\.mattpyle\.com and nowhere else/);
    assert.match(prompt, /`status`, `header`, `text`, `markdown`, `selector`, `js`/);
    assert.match(prompt, /cannot be a check, the retro appearance aside: write `verify: \[\]`/);
    assert.match(prompt, /\nverify:\n  - url: <a URL on the production origin>/);
    assert.match(prompt, /Build the checks from the finding's "How to measure" and nothing else/);
  }
  assert.ok(whole.indexOf('---\nverify:') < whole.indexOf('# Handoff: <title>'), 'the block opens the handoff');
  assert.ok(block.includes(`<finding>\n${DEFECT_FINDING.trim()}\n</finding>`));
  assert.ok(block.includes(`<handoff>\n${DEFECT_HANDOFF.trim()}\n</handoff>`));
  assert.match(block, /The fix is merged and deployed/);

  const argv = handoffGeneratorArgs(block, VERIFY_BLOCK_SYSTEM_PROMPT);
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], VERIFY_BLOCK_SYSTEM_PROMPT);
  assert.equal(argv[argv.indexOf('--tools') + 1], HANDOFF_GENERATOR_TOOLS.join(','));
  assert.ok(argv.includes('--safe-mode') && argv.includes('--strict-mcp-config'));
});

test('the guide is the schema alone: it names no finding section, and its source rule is each caller\'s own', () => {
  const guide = verifyBlockGuide(ORIGIN).join('\n');
  for (const section of ['How to measure', 'What happened', 'What would serve them', 'Why it matters', 'Who wanted what']) {
    assert.ok(!guide.includes(section), `the guide names "${section}"`);
  }
  assert.doesNotMatch(guide, /Build the checks from/);
});

test('the guide teaches the retro check: a js expression that sets the attribute, then measures a non-empty match', () => {
  const guide = verifyBlockGuide(ORIGIN).join('\n');
  assert.match(guide, /The retro appearance is the one page state a check may set\./);
  assert.match(guide, /a `js` check whose expression sets `document\.documentElement\.dataset\.appearance = 'retro'` before it measures/);
  assert.match(guide, /fails on an empty match/);
  assert.match(guide, /a state a visitor has to set up cannot be a check, the retro appearance aside/);

  // The worked example in the rule is itself a block the validator admits.
  const example = /`expect: (\{expression: "\(\(\) => \{ document[^`]*\})`/.exec(guide)?.[1];
  assert.ok(example, 'the rule carries an example expect');
  assert.match(example, /cells\.length > 0 && /);
  const { raw } = parseVerifyReply(`verify:\n  - url: "${ORIGIN}/steward/"\n    kind: "js"\n    expect: ${example}\n`);
  const admitted = validateVerifyBlock(raw, ORIGIN);
  assert.deepEqual(admitted.problems, []);
  assert.equal((admitted.checks[0].expect as { equals: unknown }).equals, true);
});

// ---------------------------------------------------------------------------
// The six kinds
// ---------------------------------------------------------------------------

test('status: the code of a GET that follows no redirect', async () => {
  const rows = await run([check('/audit/', 'status', 200), check('/old/', 'status', 308), check('/nowhere/', 'status', 200)]);
  assert.deepEqual(rows.map((r) => [r.pass, r.expected, r.measured]), [
    [true, 'status 200', 'status 200'],
    [true, 'status 308', 'status 308'],
    [false, 'status 200', 'status 404'],
  ]);
  assert.equal(seen.at(-1)!.agent, 'steward-test/1', 'the request names who is asking');
});

test('header: contains, equals and absent, with the measured value', async () => {
  const rows = await run([
    check('/audit/', 'header', { name: 'link', contains: 'text/markdown' }),
    check('/audit/', 'header', { name: 'Link', equals: '</audit.md>' }),
    check('/audit/', 'header', { name: 'x-robots-tag', absent: true }),
    check('/about/', 'header', { name: 'link', contains: 'text/markdown' }),
  ]);
  assert.deepEqual(rows.map((r) => r.pass), [true, false, true, false]);
  assert.equal(rows[1].measured, '"</audit.md>; rel=\\"alternate\\"; type=\\"text/markdown\\""');
  assert.equal(rows[3].measured, 'absent');
});

test('text: contains, a count of a literal string, and a captured value', async () => {
  const rows = await run([
    check('/audit/', 'text', { count: 1, of: 'rel="alternate" type="text/markdown"' }),
    check('/about/', 'text', { count: 0, of: 'opens in a new tab' }),
    check('/audit/', 'text', { contains: 'Audit' }),
    check('/changelog/rss.xml', 'text', { capture: '<link>([^<]*)</link>', equals: 'https://www.mattpyle.com/changelog/' }),
    check('/changelog/rss.xml', 'text', { capture: '<link>([^<]*)</link>', equals: 'https://www.mattpyle.com/' }),
    check('/changelog/rss.xml', 'text', { capture: '<title>([^<]*)</title>', equals: 'Changelog' }),
    check('/nowhere/', 'text', { count: 0, of: 'opens in a new tab' }),
  ]);
  assert.deepEqual(rows.map((r) => r.pass), [true, false, true, true, false, false, false]);
  assert.equal(rows[1].expected, '0 occurrences of "opens in a new tab"');
  assert.equal(rows[1].measured, '1 occurrences');
  assert.equal(rows[4].measured, '"https://www.mattpyle.com/changelog/"');
  assert.equal(rows[5].measured, 'no match');
  assert.equal(rows[6].measured, 'status 404', 'a string absent from an error page is not a pass');
});

test('markdown: the negotiated body, and a fail when the answer is not markdown', async () => {
  const rows = await run([
    check('/about/', 'markdown', { count: 0, of: 'opens in a new tab' }),
    check('/about/', 'markdown', { contains: '[Temporal](https://temporal.io/)' }),
    check('/audit/', 'markdown', { contains: 'Audit' }),
  ]);
  assert.deepEqual(rows.map((r) => r.pass), [true, true, false]);
  assert.equal(rows[2].measured, 'content-type "text/html", not markdown');
  assert.equal(seen.at(-1)!.accept, 'text/markdown');
});

test('selector: a count, a text and an attribute, each as one expression in the page', async () => {
  const probe = fakeProbe((_url, expression) => {
    if (expression.includes('.length')) return 1;
    if (expression.includes('textContent')) return 'Matt Pyle';
    return expression.includes('"footer nav"') ? 'Footer' : null;
  });
  const rows = await run(
    [
      check('/', 'selector', { selector: 'footer nav', count: 1 }),
      check('/', 'selector', { selector: 'h1', text: 'Matt Pyle' }),
      check('/', 'selector', { selector: 'footer nav', attribute: 'aria-label', equals: 'Footer' }),
      check('/', 'selector', { selector: 'footer nav', attribute: 'aria-label', equals: 'Social links' }),
      check('/', 'selector', { selector: 'nav[aria-label="Social links"]', attribute: 'aria-label', equals: 'Social links' }),
    ],
    probe.runner,
  );
  assert.deepEqual(rows.map((r) => r.pass), [true, true, true, false, false]);
  assert.equal(rows[3].expected, '"footer nav" has aria-label="Social links"');
  assert.equal(rows[3].measured, '"Footer"');
  assert.equal(rows[4].measured, 'no element matches');
  // The selector rides as a JSON string: its quotes cannot close the call.
  assert.equal(probe.asked[4].expression.includes('document.querySelector("nav[aria-label=\\"Social links\\"]")'), true);
  assert.deepEqual(probe.counts(), { opened: 1, closed: 1 }, 'one browser for the block, closed at the end');
});

test('js: the expression as written, compared as a JSON value', async () => {
  const probe = fakeProbe((_url, expression) =>
    expression === 'names()' ? ['rss', 'github'] : expression === 'document.title' ? 'Matt Pyle' : null,
  );
  const rows = await run(
    [
      check('/', 'js', { expression: 'names()', equals: ['rss', 'github'] }),
      check('/', 'js', { expression: 'names()', equals: ['github', 'rss'] }),
      check('/', 'js', { expression: 'document.title', equals: 'Matt Pyle' }),
    ],
    probe.runner,
  );
  assert.deepEqual(rows.map((r) => r.pass), [true, false, true]);
  assert.equal(rows[1].measured, '["rss","github"]');
  assert.deepEqual(probe.asked.map((a) => a.url), [`${origin}/`, `${origin}/`, `${origin}/`]);
});

test('a check that cannot be measured throws, and is never a failed row', async () => {
  await assert.rejects(run([check('/down/', 'text', { count: 0, of: 'x' })]), CheckUnavailable);
  await assert.rejects(run([{ url: 'http://127.0.0.1:1/', kind: 'status', expect: 200 }]), CheckUnavailable);
  // A status check that expects the 5xx is a measurement.
  assert.equal((await run([check('/down/', 'status', 503)]))[0].pass, true);

  const probe = fakeProbe(() => {
    throw new CheckBroken('the expression threw');
  });
  await assert.rejects(run([check('/', 'js', { expression: 'nope(', equals: 1 })], probe.runner), CheckBroken);
  assert.deepEqual(probe.counts(), { opened: 1, closed: 1 }, 'the browser is closed on a throw too');
});
