import matter from 'gray-matter';
import { parseFrontmatter } from './frontmatter.js';

/**
 * The verifier's pure half: the `verify` block a generated handoff carries in
 * its frontmatter, the rules that admit one, and the code that runs it.
 *
 * A block is data. Each check names a production URL, one of six kinds and
 * what to expect, and {@link runChecks} measures it with Steward's own fetch
 * and Steward's own browser probe. Nothing in a block is ever spawned.
 *
 * Temporal-free like the rest of `lib/`. The fetch and the browser are handed
 * in, so every kind is testable against a mock origin.
 */

export const VERIFY_KINDS = ['status', 'header', 'text', 'markdown', 'selector', 'js'] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export interface VerifyCheck {
  url: string;
  kind: VerifyKind;
  /** A status code for `status`; one of the kind's forms (see {@link VERIFY_BLOCK_GUIDE}) for the rest. */
  expect: unknown;
}

export interface VerifyCheckResult {
  /** 1-based, the check's place in the block. */
  n: number;
  url: string;
  kind: VerifyKind;
  pass: boolean;
  /** What the check asked for, in words. */
  expected: string;
  /** What production answered. */
  measured: string;
}

/** The most checks one block may carry: a measure is one or two facts, not a suite. */
export const VERIFY_CHECKS_MAX = 12;

const STRING_MAX = 2_000;

/**
 * What a generator is told about the block. One text for both prompts, so a
 * handoff written whole and a block written alone follow the same rules.
 *
 * The schema only: it names no finding section. Each caller says where its
 * checks come from, and Argus's `argus-inspect` skill carries a copy of this
 * text under its own source rule.
 */
export function verifyBlockGuide(origin: string): string[] {
  return [
    `Each check is \`{url, kind, expect}\`. \`url\` is a full URL on ${origin} and nowhere else. \`kind\` is one of ${VERIFY_KINDS.map((k) => `\`${k}\``).join(', ')}.`,
    '',
    '- `status`: the HTTP status of a GET that follows no redirect. `expect: 200`.',
    '- `header`: one response header. `expect: {name: link, contains: "text/markdown"}`, or `equals` for the whole value, or `absent: true`.',
    '- `text`: the response body as served, HTML source included. One of three forms. `expect: {contains: "a literal string"}`. `expect: {count: 0, of: "a literal string"}`, the number of times the string occurs. `expect: {capture: "<link>([^<]*)</link>", equals: "the value"}`, the first group of the first match of a JavaScript regular expression.',
    '- `markdown`: the same three forms as `text`, on the body a GET with `Accept: text/markdown` returns. It fails when the answer is not markdown.',
    '- `selector`: the page rendered in a browser. `expect: {selector: "footer nav", count: 1}`, or `{selector: "h1", text: "the trimmed text of the first match"}`, or `{selector: "footer nav", attribute: "aria-label", equals: "Footer"}`.',
    '- `js`: an expression evaluated in the rendered page. `expect: {expression: "document.title", equals: "the JSON value it returns"}`.',
    '',
    'Every check passes on production once the fix is live and fails before it.',
    'Prefer `status`, `header`, `text` and `markdown`. Use `selector` or `js` only when the fact exists in the rendered page alone.',
    'The retro appearance is the one page state a check may set. Its stylesheet loads on every page and applies when `<html>` carries `data-appearance="retro"`. A check in retro is a `js` check whose expression sets `document.documentElement.dataset.appearance = \'retro\'` before it measures, and fails on an empty match: `expect: {expression: "(() => { document.documentElement.dataset.appearance = \'retro\'; const cells = [...document.querySelectorAll(\'.facts td\')]; return cells.length > 0 && cells.every((cell) => getComputedStyle(cell).paddingLeft === \'8px\'); })()", equals: true}`.',
    'Quote every string in double quotes. A measure that is a unit test, a judgement, a future event or a state a visitor has to set up cannot be a check, the retro appearance aside: write `verify: []`.',
  ];
}

// ---------------------------------------------------------------------------
// The block in a handoff
// ---------------------------------------------------------------------------

export interface HandoffVerify {
  /** True when the frontmatter has a `verify` key, whatever it holds. */
  present: boolean;
  /** The key's value as parsed, unvalidated. */
  raw: unknown;
  /** The handoff without its frontmatter. */
  body: string;
  /** The other frontmatter keys, kept when the block is written back. */
  data: Record<string, unknown>;
}

export function readHandoffVerify(markdown: string): HandoffVerify {
  const parsed = parseFrontmatter(markdown);
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  return {
    present: Object.prototype.hasOwnProperty.call(data, 'verify'),
    raw: data.verify,
    body: parsed.content.replace(/^\s*\n/, ''),
    data,
  };
}

/** The handoff with `verify` set in its frontmatter and its body kept. */
export function withVerifyBlock(markdown: string, checks: VerifyCheck[]): string {
  const { body, data } = readHandoffVerify(markdown);
  return matter.stringify(`\n${body.replace(/\s+$/, '')}\n`, { ...data, verify: checks });
}

/** A model's reply as the value of a `verify` key: an outer fence removed, the YAML parsed. */
export function parseVerifyReply(raw: string): { present: boolean; raw: unknown } {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^```(?:ya?ml)?\n([\s\S]*)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^---\n/, '').replace(/\n---$/, '');
  let data: Record<string, unknown>;
  try {
    data = (parseFrontmatter(`---\n${text}\n---\n`).data ?? {}) as Record<string, unknown>;
  } catch {
    return { present: false, raw: undefined };
  }
  return { present: Object.prototype.hasOwnProperty.call(data, 'verify'), raw: data.verify };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= STRING_MAX;

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function keysAre(value: Record<string, unknown>, ...allowed: string[][]): boolean {
  const keys = Object.keys(value).sort().join(',');
  return allowed.some((form) => [...form].sort().join(',') === keys);
}

function textExpectProblem(expect: unknown): string | null {
  if (!isRecord(expect)) return 'expect is not a mapping';
  if (keysAre(expect, ['contains'])) return isText(expect.contains) ? null : 'contains is not a string';
  if (keysAre(expect, ['count', 'of'])) {
    return isCount(expect.count) && isText(expect.of) ? null : 'count is not a whole number or of is not a string';
  }
  if (keysAre(expect, ['capture', 'equals'])) {
    if (!isText(expect.capture) || typeof expect.equals !== 'string') return 'capture or equals is not a string';
    try {
      new RegExp(expect.capture);
    } catch {
      return 'capture is not a regular expression';
    }
    return null;
  }
  return 'expect is none of {contains}, {count, of}, {capture, equals}';
}

function expectProblem(kind: VerifyKind, expect: unknown): string | null {
  switch (kind) {
    case 'status':
      return Number.isInteger(expect) && (expect as number) >= 100 && (expect as number) <= 599
        ? null
        : 'expect is not an HTTP status code';
    case 'header': {
      if (!isRecord(expect) || !isText(expect.name)) return 'expect has no header name';
      if (keysAre(expect, ['name', 'equals'])) return typeof expect.equals === 'string' ? null : 'equals is not a string';
      if (keysAre(expect, ['name', 'contains'])) return isText(expect.contains) ? null : 'contains is not a string';
      if (keysAre(expect, ['name', 'absent'])) return expect.absent === true ? null : 'absent is not true';
      return 'expect is none of {name, equals}, {name, contains}, {name, absent}';
    }
    case 'text':
    case 'markdown':
      return textExpectProblem(expect);
    case 'selector': {
      if (!isRecord(expect) || !isText(expect.selector)) return 'expect has no selector';
      if (keysAre(expect, ['selector', 'count'])) return isCount(expect.count) ? null : 'count is not a whole number';
      if (keysAre(expect, ['selector', 'text'])) return typeof expect.text === 'string' ? null : 'text is not a string';
      if (keysAre(expect, ['selector', 'attribute', 'equals'])) {
        return isText(expect.attribute) && typeof expect.equals === 'string' ? null : 'attribute or equals is not a string';
      }
      return 'expect is none of {selector, count}, {selector, text}, {selector, attribute, equals}';
    }
    case 'js':
      if (!isRecord(expect) || !keysAre(expect, ['expression', 'equals'])) return 'expect is not {expression, equals}';
      return isText(expect.expression) ? null : 'expression is not a string';
  }
}

/**
 * The checks a `verify` value holds and what is wrong with it, one line each.
 * A block with a problem is never run: `checks` is empty whenever `problems`
 * is not.
 *
 * `origin` is the production origin. A URL on any other origin is refused, so
 * a block can make Steward fetch the site it verifies and nothing else.
 */
export function validateVerifyBlock(raw: unknown, origin: string): { checks: VerifyCheck[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { checks: [], problems: ['verify is not a list'] };
  if (raw.length > VERIFY_CHECKS_MAX) problems.push(`verify has ${raw.length} checks, over ${VERIFY_CHECKS_MAX}`);
  const production = new URL(origin).origin;

  const checks: VerifyCheck[] = [];
  raw.forEach((item, i) => {
    const at = `verify check ${i + 1}`;
    if (!isRecord(item) || !keysAre(item, ['url', 'kind', 'expect'])) {
      problems.push(`${at} is not {url, kind, expect}`);
      return;
    }
    if (!VERIFY_KINDS.includes(item.kind as VerifyKind)) {
      problems.push(`${at} has the unknown kind "${String(item.kind)}"`);
      return;
    }
    const kind = item.kind as VerifyKind;
    let url: URL | undefined;
    try {
      url = new URL(String(item.url));
    } catch {
      /* reported below */
    }
    if (typeof item.url !== 'string' || !url) problems.push(`${at} has no full URL`);
    else if (url.origin !== production) problems.push(`${at} names ${url.origin}, not the production origin ${production}`);
    const wrong = expectProblem(kind, item.expect);
    if (wrong) problems.push(`${at} (${kind}): ${wrong}`);
    checks.push({ url: String(item.url), kind, expect: item.expect });
  });
  return problems.length > 0 ? { checks: [], problems } : { checks, problems };
}

// ---------------------------------------------------------------------------
// Running a block
// ---------------------------------------------------------------------------

/** One rendered page, asked one question. `chrome-probe.ts` is the real one. */
export interface PageProbe {
  /** The JSON value `expression` evaluates to in the page at `url`, once it has loaded. */
  evaluate(url: string, expression: string): Promise<unknown>;
}

export interface CheckRunner {
  fetch: typeof fetch;
  /** Called at most once, and only when the block has a `selector` or `js` check. */
  openProbe: () => Promise<PageProbe & { close(): Promise<void> }>;
  userAgent: string;
  timeoutMs?: number;
}

/**
 * A check that could not be measured: the origin answered 5xx, or never
 * answered. Thrown rather than recorded, because "production was down" is not
 * "the fix did not take", and only the second may reopen a finding.
 */
export class CheckUnavailable extends Error {
  override name = 'CheckUnavailable';
}

/** A check whose own expression or selector does not run. The block is wrong, not the site. */
export class CheckBroken extends Error {
  override name = 'CheckBroken';
}

const BODY_MAX = 5_000_000;
const show = (value: unknown) => JSON.stringify(value) ?? 'undefined';
const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

function occurrences(body: string, needle: string): number {
  let count = 0;
  for (let at = body.indexOf(needle); at >= 0; at = body.indexOf(needle, at + needle.length)) count++;
  return count;
}

type Verdict = Pick<VerifyCheckResult, 'pass' | 'expected' | 'measured'>;

function judgeText(body: string, expect: Record<string, unknown>): Verdict {
  if ('contains' in expect) {
    const count = occurrences(body, String(expect.contains));
    return { pass: count > 0, expected: `contains ${show(expect.contains)}`, measured: `${count} occurrences` };
  }
  if ('of' in expect) {
    const count = occurrences(body, String(expect.of));
    return {
      pass: count === expect.count,
      expected: `${expect.count} occurrences of ${show(expect.of)}`,
      measured: `${count} occurrences`,
    };
  }
  const match = new RegExp(String(expect.capture)).exec(body);
  const captured = match ? (match[1] ?? match[0]) : null;
  return {
    pass: captured === expect.equals,
    expected: `${show(expect.capture)} captures ${show(expect.equals)}`,
    measured: captured === null ? 'no match' : clip(show(captured)),
  };
}

/** The expression a `selector` check runs in the page. The selector rides as a JSON string. */
function selectorExpression(expect: Record<string, unknown>): string {
  const selector = JSON.stringify(expect.selector);
  if ('count' in expect) return `document.querySelectorAll(${selector}).length`;
  if ('text' in expect) {
    return `(() => { const el = document.querySelector(${selector}); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`;
  }
  return `(() => { const el = document.querySelector(${selector}); return el ? el.getAttribute(${JSON.stringify(expect.attribute)}) : null; })()`;
}

function judgeSelector(value: unknown, expect: Record<string, unknown>): Verdict {
  const selector = show(expect.selector);
  if ('count' in expect) {
    return { pass: value === expect.count, expected: `${expect.count} elements match ${selector}`, measured: `${show(value)} elements` };
  }
  const missing = value === null ? 'no element matches' : null;
  if ('text' in expect) {
    return { pass: value === expect.text, expected: `${selector} has the text ${show(expect.text)}`, measured: missing ?? clip(show(value)) };
  }
  return {
    pass: value === expect.equals,
    expected: `${selector} has ${String(expect.attribute)}=${show(expect.equals)}`,
    measured: missing ?? clip(show(value)),
  };
}

/** Structural equality over JSON values: what `returnByValue` hands back. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((k) => sameJson((a as any)[k], (b as any)[k]));
}

/**
 * Runs a validated block against production and returns one row per check.
 *
 * A row is a measurement: pass or fail, with both values. A check that could
 * not be measured throws {@link CheckUnavailable}, and one whose own selector
 * or expression does not run throws {@link CheckBroken}; neither is a row.
 */
export async function runChecks(checks: VerifyCheck[], runner: CheckRunner): Promise<VerifyCheckResult[]> {
  const timeoutMs = runner.timeoutMs ?? 30_000;
  let probe: (PageProbe & { close(): Promise<void> }) | undefined;

  const get = async (check: VerifyCheck, init: RequestInit = {}): Promise<Response> => {
    let res: Response;
    try {
      res = await runner.fetch(check.url, {
        ...init,
        headers: { 'User-Agent': runner.userAgent, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CheckUnavailable(`${check.url} did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 500 && !(check.kind === 'status' && check.expect === res.status)) {
      throw new CheckUnavailable(`${check.url} answered ${res.status}`);
    }
    return res;
  };

  const judge = async (check: VerifyCheck): Promise<Verdict> => {
    const expect = check.expect as Record<string, unknown>;
    switch (check.kind) {
      case 'status': {
        const res = await get(check, { redirect: 'manual' });
        return { pass: res.status === check.expect, expected: `status ${String(check.expect)}`, measured: `status ${res.status}` };
      }
      case 'header': {
        const res = await get(check);
        const value = res.headers.get(String(expect.name));
        const measured = value === null ? 'absent' : clip(show(value));
        if ('absent' in expect) return { pass: value === null, expected: `no ${String(expect.name)} header`, measured };
        if ('equals' in expect) {
          return { pass: value === expect.equals, expected: `${String(expect.name)}: ${show(expect.equals)}`, measured };
        }
        return {
          pass: value !== null && value.includes(String(expect.contains)),
          expected: `${String(expect.name)} contains ${show(expect.contains)}`,
          measured,
        };
      }
      case 'text':
      case 'markdown': {
        const markdown = check.kind === 'markdown';
        const res = await get(check, markdown ? { headers: { Accept: 'text/markdown' } } : {});
        const type = (res.headers.get('content-type') ?? '').toLowerCase();
        const verdict = judgeText((await res.text()).slice(0, BODY_MAX), expect);
        if (res.status !== 200) return { ...verdict, pass: false, measured: `status ${res.status}` };
        if (markdown && !type.includes('text/markdown')) {
          return { ...verdict, pass: false, measured: `content-type ${show(type)}, not markdown` };
        }
        return verdict;
      }
      case 'selector':
      case 'js': {
        probe ??= await runner.openProbe();
        const expression = check.kind === 'js' ? String(expect.expression) : selectorExpression(expect);
        const value = await probe.evaluate(check.url, expression);
        if (check.kind === 'selector') return judgeSelector(value, expect);
        return {
          pass: sameJson(value, expect.equals),
          expected: `${clip(String(expect.expression))} is ${show(expect.equals)}`,
          measured: clip(show(value)),
        };
      }
    }
  };

  try {
    const results: VerifyCheckResult[] = [];
    for (const [i, check] of checks.entries()) {
      results.push({ n: i + 1, url: check.url, kind: check.kind, ...(await judge(check)) });
    }
    return results;
  } finally {
    await probe?.close().catch(() => {});
  }
}
