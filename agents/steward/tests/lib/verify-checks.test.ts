import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CheckBroken,
  CheckUnavailable,
  DEFAULT_VIEWPORT,
  parseVerifyReply,
  parseViewport,
  readHandoffVerify,
  runChecks,
  validateGeneratedBlock,
  validateVerifyBlock,
  validateVerifyCoverage,
  verifyBlockGuide,
  withVerifyBlock,
  type CheckRunner,
  type VerifyCheck,
  type Viewport,
} from '../../src/lib/verify-checks.js';
import { HANDOFF_GENERATOR_TOOLS, handoffGeneratorPrompt, validateHandoff } from '../../src/lib/fixer.js';
import {
  VERIFY_BLOCK_SYSTEM_PROMPT,
  handoffGeneratorArgs,
  verifyBlockPrompt,
  verifyBlockRetryPrompt,
} from '../../src/lib/handoff-generator.js';
import { DEFECT_FINDING, DEFECT_HANDOFF, DEFECT_KEY, MAPPED_HANDOFF, ORIGIN } from '../helpers/finding-fixtures.js';

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
  const sizes: Viewport[] = [];
  let opened = 0;
  let closed = 0;
  const runner: Pick<CheckRunner, 'openProbe'> = {
    openProbe: async () => {
      opened++;
      return {
        evaluate: async (url, expression, viewport) => {
          asked.push({ url, expression });
          sizes.push(viewport);
          return answers(url, expression);
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  return { runner, asked, sizes, counts: () => ({ opened, closed }) };
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

test('a selector or js check may name a viewport, and keeps it', () => {
  const phone: VerifyCheck[] = [
    { url: `${ORIGIN}/`, kind: 'js', expect: { expression: 'innerWidth', equals: 390 }, viewport: '390x844' },
    { url: `${ORIGIN}/`, kind: 'selector', expect: { selector: '.nav-more', count: 1 }, viewport: '1280x800' },
  ];
  assert.deepEqual(validateVerifyBlock(phone, ORIGIN), { checks: phone, problems: [] });
  // As Argus writes it: an unquoted value in YAML is a string too.
  const { raw } = parseVerifyReply(`verify:\n  - url: "${ORIGIN}/"\n    kind: "js"\n    expect: {expression: "innerWidth", equals: 390}\n    viewport: 390x844\n`);
  assert.equal(validateVerifyBlock(raw, ORIGIN).checks[0].viewport, '390x844');
  assert.ok(!('viewport' in validateVerifyBlock(GOOD, ORIGIN).checks[1]), 'a check with none gets none');
});

test('a viewport on a status, header, text or markdown check is refused', () => {
  const fetchKinds: [VerifyCheck['kind'], unknown][] = [
    ['status', 200],
    ['header', { name: 'link', contains: 'text/markdown' }],
    ['text', { contains: 'Matt' }],
    ['markdown', { contains: 'Matt' }],
  ];
  for (const [kind, expect] of fetchKinds) {
    const result = validateVerifyBlock([{ url: `${ORIGIN}/`, kind, expect, viewport: '390x844' }], ORIGIN);
    assert.deepEqual(result.problems, [`verify check 1 (${kind}): a viewport applies to selector and js checks only`]);
    assert.deepEqual(result.checks, []);
  }
});

test('a malformed viewport is refused', () => {
  for (const viewport of ['390', '390X844', '390 x 844', ' 390x844', '390x844px', 'phone', '50x844', '390x5000', '0390x844', 390, null, '']) {
    const result = validateVerifyBlock(
      [{ url: `${ORIGIN}/`, kind: 'js', expect: { expression: 'innerWidth', equals: 390 }, viewport }],
      ORIGIN,
    );
    assert.match(result.problems.join('; '), /verify check 1 \(js\): viewport .* is not "<width>x<height>", each 100 to 4096/, String(viewport));
    assert.deepEqual(result.checks, []);
  }
  assert.deepEqual(parseViewport('390x844'), { width: 390, height: 844 });
  assert.deepEqual(parseViewport(DEFAULT_VIEWPORT), { width: 1280, height: 800 });
});

const PAGES = ['/writing/a/', '/writing/b/', '/writing/c/'].map((path) => `${ORIGIN}${path}`);

test('a status, header, text or markdown check may name a list of URLs, and keeps it', () => {
  const lists: VerifyCheck[] = [
    { url: PAGES, kind: 'header', expect: { name: 'link', contains: 'text/markdown' } },
    { url: PAGES, kind: 'status', expect: 200 },
    { url: PAGES, kind: 'text', expect: { contains: 'Matt' } },
    { url: [PAGES[0]], kind: 'markdown', expect: { contains: '# ' } },
    { url: Array.from({ length: 20 }, (_, i) => `${ORIGIN}/writing/${i}/`), kind: 'status', expect: 200 },
  ];
  assert.deepEqual(validateVerifyBlock(lists, ORIGIN), { checks: lists, problems: [] });
  // As Argus writes it: a YAML list under `url`.
  const yaml = ['verify:', '  - url:', ...PAGES.map((url) => `      - "${url}"`), '    kind: "header"', '    expect: {name: "link", contains: "text/markdown"}'].join('\n');
  assert.deepEqual(validateVerifyBlock(parseVerifyReply(yaml).raw, ORIGIN).checks, [lists[0]]);
});

test('a single-string url round-trips as a string, through the validator and the handoff', () => {
  const [one] = validateVerifyBlock([GOOD[0]], ORIGIN).checks;
  assert.equal(one.url, `${ORIGIN}/steward.md`);
  const read = readHandoffVerify(withVerifyBlock('# Handoff\n', [GOOD[0], { ...GOOD[0], url: PAGES }]));
  assert.deepEqual(validateVerifyBlock(read.raw, ORIGIN).checks, [GOOD[0], { ...GOOD[0], url: PAGES }]);
  assert.equal(typeof (read.raw as VerifyCheck[])[0].url, 'string');
});

test('a list of URLs is refused when empty, over 20, off the production origin, or on a browser kind', () => {
  const refused = (url: unknown, kind: VerifyCheck['kind'], expect: unknown, ...problems: string[]) => {
    const result = validateVerifyBlock([{ url, kind, expect }], ORIGIN);
    assert.deepEqual(result.problems, problems);
    assert.deepEqual(result.checks, []);
  };
  const header = { name: 'link', contains: 'text/markdown' };
  refused([], 'header', header, 'verify check 1 has an empty list of URLs');
  refused(Array.from({ length: 21 }, (_, i) => `${ORIGIN}/writing/${i}/`), 'header', header, 'verify check 1 lists 21 URLs, over 20');
  refused(
    [PAGES[0], 'https://example.com/writing/b/', PAGES[2]],
    'header',
    header,
    'verify check 1 URL 2 names https://example.com, not the production origin https://www.mattpyle.com',
  );
  refused([PAGES[0], '/writing/b/', 7], 'header', header, 'verify check 1 URL 2 is not a full URL', 'verify check 1 URL 3 is not a full URL');
  refused(PAGES, 'selector', { selector: 'h1', count: 1 }, 'verify check 1 (selector): a list of URLs applies to status, header, text and markdown checks only');
  refused(PAGES, 'js', { expression: 'document.title', equals: 'x' }, 'verify check 1 (js): a list of URLs applies to status, header, text and markdown checks only');
});

test('a list check counts as one check toward the cap of twelve', () => {
  const twelve = Array.from({ length: 12 }, () => ({ url: PAGES, kind: 'status', expect: 200 }));
  assert.deepEqual(validateVerifyBlock(twelve, ORIGIN).problems, []);
  assert.match(validateVerifyBlock([...twelve, twelve[0]], ORIGIN).problems.join('; '), /13 checks, over 12/);
});

test('the guide names the list form, its cap and the kinds it applies to', () => {
  assert.ok(
    verifyBlockGuide(ORIGIN).includes(
      'One fact measured across many pages is one check: its `url` is a list of up to 20 full URLs, and it passes when every URL passes. A list applies to `status`, `header`, `text` and `markdown`.',
    ),
  );
});

test('a coverage map is admitted when every surface has checks or a reason and every check is named', () => {
  const map = [
    { surface: '/llms.txt', checks: [1, 2] },
    { surface: '/agents.md', checks: [2] },
    { surface: 'the A2A answer', reason: 'A2A is a POST; no check kind sends one' },
  ];
  assert.deepEqual(validateVerifyCoverage(map, 2), { coverage: map, problems: [] });
  // An empty block maps every surface to a reason.
  assert.deepEqual(validateVerifyCoverage([map[2]], 0).problems, []);
});

test('a coverage map is refused for each way it can leave the rules', () => {
  const refused = (raw: unknown, checkCount: number, pattern: RegExp) => {
    const { coverage, problems } = validateVerifyCoverage(raw, checkCount);
    assert.match(problems.join('; '), pattern);
    assert.deepEqual(coverage, [], 'a refused map holds no entry');
  };
  // No coverage at all.
  refused(undefined, 1, /there is no coverage map/);
  refused(null, 1, /there is no coverage map/);
  refused({ surface: '/llms.txt', checks: [1] }, 1, /coverage is not a list/);
  refused([], 0, /coverage names no surface/);
  // An entry with both, or neither, of checks and reason.
  refused([{ surface: '/llms.txt', checks: [1], reason: 'also this' }], 1, /entry 1 \(\/llms\.txt\) has both checks and a reason/);
  refused([{ surface: '/llms.txt', checks: [1] }, { surface: '/agents.md' }], 1, /entry 2 \(\/agents\.md\) has neither checks nor a reason/);
  refused([{ checks: [1] }], 1, /entry 1 has no surface/);
  refused([{ surface: '/llms.txt', checks: [] }], 0, /not a non-empty list/);
  // A check number the block does not have.
  refused([{ surface: '/llms.txt', checks: [1, 3] }], 2, /names check 3, which the block does not have/);
  refused([{ surface: '/llms.txt', checks: [0] }], 1, /names check 0, which the block does not have/);
  refused([{ surface: '/llms.txt', checks: ['1'] }], 1, /names check 1, which the block does not have/);
  // A check no entry names.
  refused([{ surface: '/llms.txt', checks: [1] }, { surface: 'A2A', reason: 'a POST' }], 3, /check 2, 3 is named by no coverage entry/);
});

test('a generated block is refused when its map is, and the block\'s own problems come first', () => {
  const block = [{ url: `${ORIGIN}/llms.txt`, kind: 'status', expect: 200 }];
  assert.deepEqual(validateGeneratedBlock(block, [{ surface: '/llms.txt', checks: [1] }], ORIGIN), {
    checks: block,
    coverage: [{ surface: '/llms.txt', checks: [1] }],
    problems: [],
  });
  const missing = validateGeneratedBlock(block, undefined, ORIGIN);
  assert.deepEqual(missing.checks, []);
  assert.deepEqual(missing.problems, ['there is no coverage map']);
  const both = validateGeneratedBlock([{ ...block[0], url: 'https://example.com/' }], [{ surface: '/x', checks: [2] }], ORIGIN);
  assert.match(both.problems[0], /not the production origin/);
  assert.match(both.problems[1], /names check 2/);
});

test('validateHandoff admits a good block and refuses a bad or a missing one', () => {
  const MAP = ['verify_coverage:', `  - surface: ${ORIGIN}/scorecard/`, '    checks: [1]'].join('\n');
  const withBlock = (yaml: string) => DEFECT_HANDOFF.replace('verify: []', `${yaml}\n${MAP}`);
  const good = withBlock(
    ['verify:', `  - url: ${ORIGIN}/scorecard/`, '    kind: text', '    expect: {count: 0, of: "100/100 (Fail)"}'].join('\n'),
  );
  assert.deepEqual(validateHandoff(good, DEFECT_KEY, ORIGIN), []);
  assert.deepEqual(validateHandoff(MAPPED_HANDOFF, DEFECT_KEY, ORIGIN), [], 'an empty list is a block');

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

  const map = [{ surface: '/steward.md', checks: [1] }, { surface: '/feed.xml', checks: [2] }];
  const written = withVerifyBlock(bare, GOOD, map);
  const read = readHandoffVerify(written);
  assert.equal(read.present, true);
  assert.deepEqual(validateVerifyBlock(read.raw, ORIGIN), { checks: GOOD, problems: [] });
  assert.equal(read.coveragePresent, true);
  assert.deepEqual(read.coverageRaw, map);
  assert.equal(read.body, bare, 'the handoff under the frontmatter is unchanged');
  assert.ok(written.startsWith('---\nverify:\n  - url: '));
  assert.ok(written.indexOf('verify_coverage:') > written.indexOf('verify:'), 'the map sits after the block');
  assert.deepEqual(validateHandoff(written, DEFECT_KEY, ORIGIN), []);
  assert.equal(withVerifyBlock(written, GOOD, map), written, 'writing the same block twice changes nothing');
  // A block written again without a map drops the old one, whose numbers it no longer matches.
  assert.equal(readHandoffVerify(withVerifyBlock(written, [GOOD[0]])).coveragePresent, false);
});

test("a model's reply is read as a verify key, fenced or bare, and anything else is not a block", () => {
  const yaml = ['verify:', `  - url: ${ORIGIN}/steward.md`, '    kind: text', '    expect: {count: 0, of: "data-astro-cid"}'].join('\n');
  for (const reply of [yaml, `\`\`\`yaml\n${yaml}\n\`\`\``, `---\n${yaml}\n---`]) {
    const parsed = parseVerifyReply(reply);
    assert.equal(parsed.present, true);
    assert.deepEqual(validateVerifyBlock(parsed.raw, ORIGIN).checks, [GOOD[0]]);
  }
  assert.deepEqual(parseVerifyReply('verify: []'), { present: true, raw: [], coveragePresent: false, coverageRaw: undefined });
  const mapped = parseVerifyReply(`${yaml}\ncoverage:\n  - surface: /steward.md\n    checks: [1]`);
  assert.deepEqual(mapped.coverageRaw, [{ surface: '/steward.md', checks: [1] }]);
  assert.deepEqual(validateGeneratedBlock(mapped.raw, mapped.coverageRaw, ORIGIN).problems, []);
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
    assert.match(prompt, /one entry for every surface the finding names\. A surface is a URL, an endpoint, a file or a page/);
    assert.match(prompt, /An entry has `checks` or `reason`, never both/);
  }
  assert.match(block, /\ncoverage:\n  - surface: <a URL, endpoint, file or page the finding names>\n    checks: \[/);
  assert.match(whole, /\nverify_coverage:\n  - surface: <a URL, endpoint, file or page the finding names>\n    checks: \[/);
  assert.match(whole, /write `verify_coverage`: one entry/);
  const retry = verifyBlockRetryPrompt({
    key: DEFECT_KEY,
    finding: DEFECT_FINDING,
    handoff: DEFECT_HANDOFF,
    origin: ORIGIN,
    rejected: { checks: GOOD, results: null, broken: 'x' },
  });
  assert.match(retry, /\ncoverage:\n  - surface: /);
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

test('the guide asks every browser check for its viewport and names the default', () => {
  const guide = verifyBlockGuide(ORIGIN);
  assert.ok(
    guide.includes(
      'Every `selector` and `js` check names the viewport its measurement was taken at, as `viewport: "390x844"`; a check without one runs at 1280x800.',
    ),
  );
  assert.equal(DEFAULT_VIEWPORT, '1280x800');
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

test('a browser check opens its page at its viewport, or at 1280x800, and its row names the size', async () => {
  const probe = fakeProbe((_url, expression) => (expression === 'innerWidth' ? 390 : 1));
  const rows = await run(
    [
      { ...check('/', 'js', { expression: 'innerWidth', equals: 390 }), viewport: '390x844' },
      check('/', 'selector', { selector: 'h1', count: 1 }),
      check('/audit/', 'status', 200),
    ],
    probe.runner,
  );
  assert.deepEqual(probe.sizes, [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]);
  assert.deepEqual(rows.map((r) => r.viewport), ['390x844', DEFAULT_VIEWPORT, undefined]);
  assert.ok(!('viewport' in rows[2]), 'a fetch row carries no viewport');
});

test('a list check passes when every URL passes, and its row says how many', async () => {
  const urls = [`${origin}/audit/`, `${origin}/audit/`];
  const [row] = await run([{ url: urls, kind: 'header', expect: { name: 'link', contains: 'text/markdown' } }]);
  assert.deepEqual(row, {
    n: 1,
    url: urls,
    kind: 'header',
    pass: true,
    expected: 'link contains "text/markdown"',
    measured: '2 of 2 pass',
  });
});

test('a list check fails when any URL fails, and its row names each failed URL with its measured value', async () => {
  const urls = [`${origin}/audit/`, `${origin}/about/`, `${origin}/nowhere/`];
  const rows = await run([
    { url: urls, kind: 'header', expect: { name: 'link', contains: 'text/markdown' } },
    { url: urls, kind: 'status', expect: 200 },
    check('/audit/', 'status', 200),
  ]);
  assert.equal(rows[0].pass, false);
  assert.equal(rows[0].measured, `1 of 3 pass; failed: ${origin}/about/ (absent), ${origin}/nowhere/ (absent)`);
  assert.equal(rows[1].measured, `2 of 3 pass; failed: ${origin}/nowhere/ (status 404)`);
  assert.deepEqual(rows[1].url, urls, 'the row carries the list as written');
  assert.equal(rows[2].url, `${origin}/audit/`, 'a single-URL row keeps its string');
  assert.equal(rows[2].measured, 'status 200');
  // One URL that cannot be measured stops the block, as a single check does.
  await assert.rejects(run([{ url: [`${origin}/audit/`, `${origin}/down/`], kind: 'text', expect: { contains: 'x' } }]), CheckUnavailable);
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
