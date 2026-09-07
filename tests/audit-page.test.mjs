import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { originFor } from '../src/lib/mcp-audit-server.mjs';
import { AGENT, COUNTS, ERRORS, FOOTER, FORM, PAGE_STATEMENT, PAGE_TITLE, REPORT, SECTIONS, errorView } from '../src/data/audit-copy.mjs';
import { fixtureAudit } from '../src/lib/audit-fixture.mjs';
import { wireRunningState } from '../src/lib/audit-running-state.mjs';
import { pointerKeyFor, readPointer, writePointer } from '../src/lib/audit-pointer.mjs';
import {
  classifyRunFailure,
  formatDate,
  formatSeconds,
  formatTime,
  isAged,
  reportView,
  secondsLeftInHour,
  statusWord,
} from '../src/lib/audit-report.mjs';

/**
 * The /audit page, minus its transport.
 *
 * Four things are worth pinning and all four are pure: which of the four error states a cause maps
 * to, whether a report is fresh or aged, what a pointer read does when there is nothing to read,
 * and that the page's words are the content inventory's words.
 *
 * THE LAST ONE IS A REFERENCE CHECK, NOT A RENDER. Astro components need the Astro compiler to
 * render and this suite is bare `node --test`, so "every inventory string appears on the page" is
 * asserted in two halves: every string in src/data/audit-copy.mjs is pinned here verbatim, and
 * every key of that module is referenced by the two components' source. A sentence written into
 * the markup instead of taken from the copy module would still slip past, which is what the aria
 * goldens in tests/a11y/__snapshots__ cover — they hold the page's actual text.
 */

const componentSource = ['../src/components/audit/AuditHero.astro', '../src/components/audit/AuditBody.astro']
  .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
  .join('\n');

/**
 * The failure markers, read out of the Steward source that composes them.
 *
 * `classifyRunFailure` takes them as an argument, and the two routes that call it hand over the
 * real `RUN_FAILURE_MARKERS` and `BLOCKED_REASON_MARKERS` from the `agent-audit/fast` entry. This
 * suite cannot import that entry — it is TypeScript source and this is bare `node --test` — so it
 * reads the frozen literals out of the files instead, the same "diff the literal rather than
 * restate it" device tests/markdown-negotiation.test.mjs uses on middleware.ts's matcher.
 *
 * Restating the fragments here would rebuild exactly the copy this removed: a reworded message in
 * Steward would leave the page misclassifying a run with this suite still green.
 */
function markersFrom(path, name) {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const block = source.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`));
  assert.ok(block, `${path} no longer exports ${name} as a frozen literal`);
  const entries = [...block[1].matchAll(/(\w+):\s*'([^']*)'/g)].map((match) => [match[1], match[2]]);
  assert.ok(entries.length > 0, `${name} carries no string markers`);
  return Object.fromEntries(entries);
}

const MARKERS = {
  ...markersFrom('../agents/steward/src/lib/agent-audit/checks.ts', 'RUN_FAILURE_MARKERS'),
  ...markersFrom('../agents/steward/src/lib/agent-audit/safe-fetch.ts', 'BLOCKED_REASON_MARKERS'),
};

test('the markers the page classifies on are the ones Steward actually writes', () => {
  // Both halves of the contract. The five names are what src/lib/audit-report.mjs reads off the
  // object, so a rename in Steward that this file survived would leave the page matching
  // `undefined`; and the two sentences are the ones the auditor composes, so a marker that stopped
  // appearing in its own message would be a fragment nothing ever matches.
  assert.deepEqual(Object.keys(MARKERS).sort(), [
    'budgetExhausted',
    'embeddedCredentials',
    'privateAddress',
    'robotsDisallowsAuditor',
    'unsupportedScheme',
  ]);

  const checksSource = readFileSync(
    fileURLToPath(new URL('../agents/steward/src/lib/agent-audit/checks.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(
    checksSource.includes('RUN_FAILURE_MARKERS.budgetExhausted}`'),
    'the aborted message must be composed from the marker, not written beside it',
  );
  assert.ok(
    checksSource.includes('RUN_FAILURE_MARKERS.robotsDisallowsAuditor}'),
    'the robots note must be composed from the marker, not written beside it',
  );
});

/** A run document with every check in one state, which is what a blocked run really looks like. */
function blockedRun(observed) {
  return {
    target: { origin: 'https://example.org' },
    startedAt: '2026-09-05T13:00:00.000Z',
    finishedAt: '2026-09-05T13:00:02.400Z',
    durationMs: 2400,
    requests: 1,
    checks: Array.from({ length: 13 }, (_, index) => ({
      id: `check-${index}`,
      title: `Check ${index}`,
      category: 'crawlability',
      severity: 'low',
      status: 'error',
      observed,
      evidence: [],
    })),
    notes: [],
    tool: { name: 'steward-audit', version: '0.2.0' },
  };
}

// ── The running state ─────────────────────────────────────────────────────────

/**
 * A form with the three elements the running state reaches for, and nothing else.
 *
 * Hand-built rather than a DOM library: the handler's whole surface is `querySelector`,
 * `addEventListener`, a button's `disabled` and `textContent`, and the status line's
 * `textContent`. A fake that small is readable in one screen, and it fails loudly if the handler
 * ever starts reading layout — which is the one thing this script must never do.
 */
function fakeForm({ value = '', label = 'Run the audit', withStatus = true } = {}) {
  const button = { disabled: false, textContent: label };
  const status = withStatus ? { textContent: '' } : null;
  const field = { value };
  const listeners = new Map();
  return {
    button,
    status,
    field,
    querySelector(selector) {
      if (selector === '[data-audit-submit]') return button;
      if (selector === '[data-audit-status]') return status;
      if (selector === 'input[name="url"]') return field;
      throw new Error(`the running state asked for an unexpected selector: ${selector}`);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    fire(type, event) {
      listeners.get(type)?.(event);
    },
  };
}

test('a submit sets the label, the disabled attribute and the live region, and nothing else', () => {
  // The three effects the design names, in one press. The button's background is deliberately not
  // among them: the script sets `disabled` and the stylesheet paints it, because `style-src` in
  // vercel.json has no `unsafe-inline` and an inline style would be refused in production only.
  const form = fakeForm({ value: '  https://www.mattpyle.com  ' });
  wireRunningState(form, { addEventListener() {} });

  form.fire('submit');

  assert.equal(form.button.textContent, FORM.running);
  assert.equal(form.button.disabled, true);
  assert.equal(form.status.textContent, 'Auditing https://www.mattpyle.com. This takes a few seconds.');
});

test('the live region names what the form is about to send, not what the page was rendered with', () => {
  // Run again carries its origin in a hidden field, and the address form carries whatever has been
  // typed since the page loaded. Both are the same read, which is why one handler serves both.
  const rerun = fakeForm({ value: 'https://example.org', label: REPORT.rerun });
  wireRunningState(rerun, { addEventListener() {} });
  rerun.fire('submit');

  assert.equal(rerun.status.textContent, FORM.runningStatus('https://example.org'));
  assert.equal(rerun.button.textContent, FORM.running);
});

test('coming back to a restored page puts the form back to idle', () => {
  // A form post leaves this page, and the back/forward cache restores it exactly as it was left:
  // the button disabled, still reading "Running…", over a form that is not running anything. The
  // label put back is the button's own, so Run again does not come back saying "Run the audit".
  const form = fakeForm({ value: 'https://example.org', label: REPORT.rerun });
  let restore;
  wireRunningState(form, { addEventListener: (_type, handler) => (restore = handler) });

  form.fire('submit');
  restore({ persisted: true });

  assert.equal(form.button.disabled, false);
  assert.equal(form.button.textContent, REPORT.rerun);
  assert.equal(form.status.textContent, '');

  // An ordinary load fires the same event and must not undo a state that was just set.
  form.fire('submit');
  restore({ persisted: false });
  assert.equal(form.button.disabled, true);
});

test('a form with no live region is left alone rather than half-wired', () => {
  // Nothing else on the site posts to /audit, but a page that grew a third form without the region
  // would otherwise get a disabled button and no announcement, which is worse than no script.
  const form = fakeForm({ withStatus: false });
  assert.equal(wireRunningState(form, { addEventListener() {} }), null);
  form.fire('submit');
  assert.equal(form.button.disabled, false);
});

// ── The four error states, each from its own cause ─────────────────────────────

test('the limiter’s refusal is the rate-limited state, with its retry time and a 429', () => {
  // The route turns `retryAfterSeconds` into a clock reading; what is pinned here is that the
  // state carries it into the body and answers 429, because the header and the sentence have to
  // agree about when the caller may come back.
  const view = errorView('rate-limited', { time: '14:00 UTC' });
  assert.equal(view.status, 429);
  assert.equal(view.title, 'Too many audits for now');
  assert.equal(view.body, 'Try again after 14:00 UTC.');
});

test('an address originFor refuses is the bad-address state, with a 400', () => {
  // The exact probe from the build's verify list. `normaliseTarget` is Steward's and cannot be
  // imported here — the workspace ships TypeScript source and this suite is bare `node --test` —
  // so the stub below is the same three lines it is, and the same one tests/mcp-audit-server.test.mjs
  // uses. What is asserted here is the mapping: an address originFor refuses is a 400, not a 502.
  const normalise = (input) => {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    return { origin: url.origin, url };
  };
  assert.throws(() => originFor('file:///etc/hosts', normalise), /Only http and https/);
  assert.equal(errorView('bad-address').status, 400);
  assert.equal(errorView('bad-address').title, 'That address cannot be audited');
});

test('a private address is the bad-address state, read off the run rather than off a throw', () => {
  // The address guard does not stop the audit starting: it refuses each fetch, so the run finishes
  // as a document of thirteen errors. Classifying that as "the site did not answer" would tell a
  // visitor their own localhost was down, when in fact this auditor will never look at it.
  assert.equal(classifyRunFailure(blockedRun(`could not fetch: 127.0.0.1 ${MARKERS.privateAddress} a loopback address`), MARKERS), 'bad-address');
  assert.equal(errorView('bad-address').status, 400);
});

test('a site that does not answer is the refused state, with a 502', () => {
  assert.equal(classifyRunFailure(blockedRun('could not fetch: DNS lookup failed: getaddrinfo ENOTFOUND nonexistent.invalid'), MARKERS), 'refused');
  const view = errorView('refused', { origin: 'https://nonexistent.invalid' });
  assert.equal(view.status, 502);
  assert.equal(view.title, 'https://nonexistent.invalid did not answer');
  assert.equal(view.body, 'The site refused the audit or could not be reached. Nothing was checked.');
});

test('a spent budget is the timeout state, with a 504', () => {
  assert.equal(classifyRunFailure(blockedRun(`could not fetch: the audit ${MARKERS.budgetExhausted}`), MARKERS), 'timeout');
  const view = errorView('timeout', { origin: 'https://slow.example' });
  assert.equal(view.status, 504);
  assert.equal(view.body, 'https://slow.example answered too slowly to finish. Try again later.');
});

test('a verdict decided without a request does not make an unreachable run a report', () => {
  // Measured against https://nonexistent.invalid on 2026-09-06: a name that does not resolve still
  // produces two `fail` verdicts, because "no sitemap is declared" and "there is no agent card" are
  // decided from the absence of a robots.txt rather than from a request. Reading those as a report
  // would tell somebody their site has no sitemap when nothing ever reached it.
  const unreachable = blockedRun('could not fetch: DNS lookup failed');
  unreachable.checks[3] = {
    ...unreachable.checks[3],
    status: 'fail',
    observed: 'no sitemap declared in robots.txt, and none at the conventional paths',
    evidence: [{ url: 'https://example.org/sitemap.xml', note: 'DNS lookup failed' }],
  };
  assert.equal(classifyRunFailure(unreachable, MARKERS), 'refused');
});

test('one HTTP response anywhere in the document makes it a report', () => {
  // The predicate is "did anything come back from the origin", and a status is the only thing an
  // unreachable run can never produce. A partial run carries its own notes and is a better answer
  // than an error page.
  const partial = blockedRun(`could not fetch: the audit ${MARKERS.budgetExhausted}`);
  partial.checks[0] = {
    ...partial.checks[0],
    status: 'pass',
    observed: '200, 2 user-agent group(s)',
    evidence: [{ url: 'https://example.org/robots.txt', status: 200 }],
  };
  assert.equal(classifyRunFailure(partial, MARKERS), null);
});

test('a site that refuses this auditor in robots.txt is the refused state', () => {
  // That run does reach the origin — robots.txt is the one fetch not gated on robots.txt — and then
  // reports every remaining check as not-applicable. Rendering it as a report would put "1 of 13
  // checks passed" over a site that declined to be checked at all.
  const refused = blockedRun('not fetched — robots.txt disallows it');
  refused.checks[0] = {
    ...refused.checks[0],
    status: 'pass',
    observed: '200, 1 user-agent group(s)',
    evidence: [{ url: 'https://example.org/robots.txt', status: 200 }],
  };
  refused.notes = [`${MARKERS.robotsDisallowsAuditor}; the checks below that needed a fetch are reported as not-applicable rather than failed.`];
  assert.equal(classifyRunFailure(refused, MARKERS), 'refused');
});

test('the timeout state wins over the refused state when both could be read', () => {
  // A budget that ran out before anything answered leaves later checks reporting transport failures
  // too. The budget is the cause and those failures are its consequence.
  const run = blockedRun('could not fetch: DNS lookup failed');
  run.checks[0].observed = `could not fetch: the audit ${MARKERS.budgetExhausted}`;
  assert.equal(classifyRunFailure(run, MARKERS), 'timeout');
});

// ── Fresh or aged, at an hour boundary ────────────────────────────────────────

test('a report from the current UTC hour is fresh, however many minutes ago it ran', () => {
  const now = new Date('2026-09-05T13:59:30.000Z');
  assert.equal(isAged(new Date('2026-09-05T13:00:00.000Z'), now), false);
  assert.equal(isAged(new Date('2026-09-05T13:59:29.000Z'), now), false);
});

test('one second past the hour makes the same report aged', () => {
  // The boundary, stated as the two sides of one second. The hour is the deduplication bucket the
  // standalone activity ID uses, so a run in the previous bucket is a run a fresh audit would
  // genuinely replace — and a run in this one is not, which is why Run again is withheld there.
  const before = new Date('2026-09-05T13:59:59.999Z');
  const after = new Date('2026-09-05T14:00:00.000Z');
  const ran = new Date('2026-09-05T13:30:00.000Z');
  assert.equal(isAged(ran, before), false);
  assert.equal(isAged(ran, after), true);
});

test('the rendered report may be edge-cached exactly to the end of its hour', () => {
  assert.equal(secondsLeftInHour(new Date('2026-09-05T13:00:00.000Z')), 3600);
  assert.equal(secondsLeftInHour(new Date('2026-09-05T13:59:00.000Z')), 60);
  // Never zero and never negative, however late in the hour the request lands.
  assert.equal(secondsLeftInHour(new Date('2026-09-05T13:59:59.999Z')), 1);
});

// ── The pointer read, when there is nothing to read ───────────────────────────

const STORE_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://store.example',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

function storeReturning(payload) {
  return async () => new Response(JSON.stringify(payload), { status: 200 });
}

test('a missing key reads as no report at all', async () => {
  // Upstash answers a GET on an absent key with a null result rather than an error, and that has
  // to be the same answer as every other kind of nothing: the form, with the address in it.
  const pointer = await readPointer({
    origin: 'https://example.org',
    env: STORE_ENV,
    fetchImpl: storeReturning([{ result: null }]),
  });
  assert.equal(pointer, null);
});

test('a failing store reads as no report at all, rather than as an error page', async () => {
  const failing = async () => new Response('nope', { status: 500 });
  assert.equal(await readPointer({ origin: 'https://example.org', env: STORE_ENV, fetchImpl: failing }), null);

  const throwing = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  assert.equal(await readPointer({ origin: 'https://example.org', env: STORE_ENV, fetchImpl: throwing }), null);
});

test('a deployment with no store configured never makes a request', async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return new Response('[]', { status: 200 });
  };
  assert.equal(await readPointer({ origin: 'https://example.org', env: {}, fetchImpl: spy }), null);
  assert.equal(called, false, 'a missing store must be answered without a round trip');
});

test('a value that is not an envelope this version understands reads as nothing', async () => {
  for (const raw of ['not json', '{}', '{"v":2,"activityId":"x"}', '{"v":1}']) {
    const pointer = await readPointer({
      origin: 'https://example.org',
      env: STORE_ENV,
      fetchImpl: storeReturning([{ result: raw }]),
    });
    assert.equal(pointer, null, raw);
  }
});

test('both envelope shapes read back as what they carry', async () => {
  const byId = await readPointer({
    origin: 'https://example.org',
    env: STORE_ENV,
    fetchImpl: storeReturning([{ result: JSON.stringify({ v: 1, activityId: 'audit:https://example.org:2026-09-05T13' }) }]),
  });
  assert.deepEqual(byId, { activityId: 'audit:https://example.org:2026-09-05T13' });

  const byValue = await readPointer({
    origin: 'https://example.org',
    env: STORE_ENV,
    fetchImpl: storeReturning([{ result: JSON.stringify({ v: 1, report: { target: { origin: 'https://example.org' } } }) }]),
  });
  assert.deepEqual(byValue, { report: { target: { origin: 'https://example.org' } } });
});

test('the pointer is written under one key per origin, with the 90-day retention', async () => {
  let sent;
  const capture = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response('[{"result":"OK"}]', { status: 200 });
  };
  const written = await writePointer({
    origin: 'https://example.org',
    activityId: 'audit:https://example.org:2026-09-05T13',
    env: STORE_ENV,
    fetchImpl: capture,
  });
  assert.equal(written.ok, true);
  assert.deepEqual(sent, [
    [
      'SET',
      pointerKeyFor('https://example.org'),
      JSON.stringify({ v: 1, activityId: 'audit:https://example.org:2026-09-05T13' }),
      'EX',
      String(90 * 24 * 60 * 60),
    ],
  ]);
});

test('a write that fails is reported and never thrown', async () => {
  // The caller is mid-redirect on a successful audit: a throw here would turn a run that worked
  // into a 500 over a cache miss.
  const failing = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const written = await writePointer({ origin: 'https://example.org', report: {}, env: STORE_ENV, fetchImpl: failing });
  assert.equal(written.ok, false);
});

// ── The report's own arithmetic ───────────────────────────────────────────────

test('the counts, the headline and the fix list all come from one tally', () => {
  const now = new Date('2026-09-05T13:30:00.000Z');
  const view = reportView(fixtureAudit({ now, minutesAgo: 3 }), now);

  assert.equal(view.total, 13);
  assert.equal(view.passed, 5);

  // Checked is the applicable count, exactly as Steward's own report uses it, so Failed is
  // Checked minus Passed and the two reports cannot disagree about what a column means.
  const summed = view.groups.reduce(
    (acc, group) => ({
      checked: acc.checked + group.counts.checked,
      passed: acc.passed + group.counts.passed,
      failed: acc.failed + group.counts.failed,
      na: acc.na + group.counts.na,
    }),
    { checked: 0, passed: 0, failed: 0, na: 0 },
  );
  assert.equal(summed.passed, view.passed);
  assert.equal(summed.checked, summed.passed + summed.failed);
  assert.equal(summed.checked + summed.na, view.total);
  assert.equal(view.fixes.length, summed.failed);
});

test('not-applicable and not-judged are one word on the page and two in the document', () => {
  const now = new Date('2026-09-05T13:30:00.000Z');
  const audit = fixtureAudit({ now });
  const view = reportView(audit, now);

  assert.equal(statusWord('not-applicable'), 'N/A');
  assert.equal(statusWord('error'), 'N/A');
  // Two distinct statuses in the JSON…
  assert.ok(audit.checks.some((check) => check.status === 'not-applicable'));
  assert.ok(audit.checks.some((check) => check.status === 'error'));
  // …and one word on the page, counted in one column.
  const words = new Set(view.checks.map((check) => check.status));
  assert.deepEqual([...words].sort(), ['Fail', 'N/A', 'Pass']);
});

test('a status the page has never seen renders as N/A rather than as undefined', () => {
  // The result document is an interface a newer auditor can write. A report lying about a verdict
  // is worse than one admitting it does not know the word.
  assert.equal(statusWord('deferred'), 'N/A');
});

test('fixes are ranked high, then medium, then low, then in run order', () => {
  const now = new Date('2026-09-05T13:30:00.000Z');
  const view = reportView(fixtureAudit({ now }), now);
  const rank = { high: 0, medium: 1, low: 2 };
  const order = view.fixes.map((fix) => rank[fix.severity]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the fix list must be worst first');
});

test('the run line is stamped in UTC, DD MMM YYYY', () => {
  const at = new Date('2026-09-05T13:12:44.000Z');
  assert.equal(formatDate(at), '05 Sep 2026');
  assert.equal(formatTime(at), '13:12');
  assert.equal(formatSeconds(2400), '2.4');
});

// ── The page's words are the inventory's words ────────────────────────────────

test('every string the page says in its own voice is the inventory’s, verbatim', () => {
  assert.equal(PAGE_TITLE, 'Audit a site');
  assert.equal(PAGE_STATEMENT, 'Paste an address. See how ready a site is for AI agents.');

  assert.equal(FORM.label, 'Website address');
  assert.equal(FORM.placeholder, 'example.com');
  assert.equal(FORM.button, 'Run the audit');
  assert.equal(FORM.running, 'Running…');
  assert.equal(FORM.runningStatus('https://example.com'), 'Auditing https://example.com. This takes a few seconds.');
  assert.equal(FORM.note, 'About a dozen requests to the site, obeying its robots.txt.');
  assert.equal(FORM.noteLink, 'What one audit does');

  assert.equal(REPORT.ran('05 Sep 2026', '13:12'), 'Run 05 Sep 2026 at 13:12 UTC');
  assert.equal(REPORT.took(15, '2.4'), '15 requests in 2.4 seconds');
  assert.equal(REPORT.rerun, 'Run again');
  assert.equal(REPORT.summary(5, 13), '5 of 13 checks passed');

  assert.deepEqual(COUNTS, { checked: 'Checked', passed: 'Passed', failed: 'Failed', na: 'N/A' });

  assert.equal(SECTIONS.checks, 'What the audit checks');
  assert.equal(SECTIONS.fixes, 'Fixes, most important first');
  assert.equal(SECTIONS.fixesNone, 'Nothing failed. Every applicable check passed.');
  assert.equal(SECTIONS.fixObserved, 'What was found:');
  assert.equal(SECTIONS.fixDo, 'Fix:');
  assert.equal(SECTIONS.evidence(2), 'Evidence (2)');
  assert.equal(SECTIONS.allChecks, 'Every check');
  assert.equal(
    SECTIONS.allChecksCaption,
    'All checks the run made, in the order they were run, whatever the verdict.',
  );
  assert.equal(SECTIONS.notes, 'Notes on the run');

  assert.equal(AGENT.heading, 'The same report, for an agent');
  assert.equal(
    AGENT.mcp('https://example.com'),
    'MCP: call audit_site on https://www.mattpyle.com/mcp with { "url": "https://example.com" }.',
  );
  assert.equal(AGENT.a2a('https://example.com'), 'A2A: send "audit https://example.com" to https://www.mattpyle.com/a2a.');

  assert.equal(
    FOOTER.generated('steward-audit', '0.2.0', '05 Sep 2026', '13:12'),
    'Generated by steward-audit 0.2.0 at 05 Sep 2026 13:12 UTC.',
  );
});

test('the page claims no markdown twin, because it has not got one yet', () => {
  // `agent.markdown` — "This page answers markdown when asked for it." — is the one inventory row
  // deliberately not built. It arrives with the twin in build 2. Rendering it now would put a
  // false claim on an agent-readiness report, which is the one page that cannot afford one.
  assert.equal('markdown' in AGENT, false);
  assert.equal(componentSource.includes('answers markdown'), false);
});

test('the components take their words from the copy module rather than writing their own', () => {
  for (const reference of [
    'PAGE_TITLE',
    'PAGE_STATEMENT',
    'FORM.label',
    'FORM.placeholder',
    'FORM.button',
    'FORM.note',
    'FORM.noteLink',
    'REPORT.ran',
    'REPORT.took',
    'REPORT.rerun',
    'REPORT.summary',
    'COUNTS.checked',
    'COUNTS.passed',
    'COUNTS.failed',
    'COUNTS.na',
    'SECTIONS.checks',
    'SECTIONS.fixes',
    'SECTIONS.fixesNone',
    'SECTIONS.fixObserved',
    'SECTIONS.fixDo',
    'SECTIONS.evidence',
    'SECTIONS.allChecks',
    'SECTIONS.allChecksCaption',
    'SECTIONS.notes',
    'AGENT.heading',
    'AGENT.mcp',
    'AGENT.a2a',
    'FOOTER.generated',
  ]) {
    assert.ok(componentSource.includes(reference), `the /audit components never use ${reference}`);
  }
});

test('every error state has a status code, and no two states share a title', () => {
  assert.deepEqual(
    Object.entries(ERRORS).map(([kind, spec]) => [kind, spec.status]),
    [
      ['rate-limited', 429],
      ['bad-address', 400],
      ['refused', 502],
      ['timeout', 504],
    ],
  );
  const titles = Object.keys(ERRORS).map((kind) => errorView(kind, { origin: 'https://example.org' }).title);
  assert.equal(new Set(titles).size, titles.length);
});
