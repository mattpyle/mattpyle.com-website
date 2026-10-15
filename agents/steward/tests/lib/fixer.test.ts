import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIXER_ALLOWED_TOOLS,
  HANDOFF_GENERATOR_TOOLS,
  HANDOFF_SECTIONS,
  HANDOFF_TITLE_MAX,
  buildFixerPrBody,
  claudeArgs,
  cleanHandoff,
  fixerChildEnv,
  fixerPrompt,
  fixerSystemPrompt,
  handoffGeneratorPrompt,
  initialClaudeRunState,
  isIncompleteRun,
  opensAsDraft,
  parseHandoff,
  reduceClaudeEvent,
  repoCommandFor,
  runVerifyChecks,
  validateHandoff,
  CHECK_OUTPUT_TAIL_CHARS,
  CHECK_OUTPUT_TAIL_LINES,
  checkOutputTail,
  formatDuration,
  redactSecrets,
  type RepoCommand,
  type RepoCommandRun,
} from '../../src/lib/fixer.js';
import { handoffGeneratorArgs } from '../../src/lib/handoff-generator.js';
import { parseFindingBody } from '../../src/lib/findings.js';
import {
  DEFECT_FINDING,
  DEFECT_HANDOFF,
  DEFECT_KEY,
  MAPPED_HANDOFF,
  OPPORTUNITY_FINDING,
  OPPORTUNITY_KEY,
  ORIGIN,
} from '../helpers/finding-fixtures.js';

// --- What a headless run may do ----------------------------------------------

test('the allowlist carries no bare file tool, so no path outside the worktree is granted', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write']) {
    assert.ok(!FIXER_ALLOWED_TOOLS.includes(tool), `${tool} would be a rule for every path on the machine`);
  }
  assert.ok(!FIXER_ALLOWED_TOOLS.some((rule) => /docs|vault/i.test(rule)));
});

test('the allowlist covers the parts of the compound commands the spike saw refused', () => {
  // `npm run build 2>&1 | tail -20`, `cd agents/steward && npm test`, and the
  // environment prefix: each part needs its own rule.
  // `npx tsc --noEmit; echo "tsc=$?"` is the form the first live run had refused.
  for (const rule of [
    'Bash(npm run *)',
    'Bash(tail *)',
    'Bash(cd *)',
    'Bash(npm test*)',
    'Bash(npx tsc *)',
    'Bash(echo *)',
    'Bash(SHOW_DRAFTS=true npm run *)',
  ]) {
    assert.ok(FIXER_ALLOWED_TOOLS.includes(rule), rule);
  }
  assert.ok(FIXER_ALLOWED_TOOLS.includes('PowerShell(Select-Object *)'));
});

test('curl is scoped to the built site and production, with no bare rule', () => {
  const curl = FIXER_ALLOWED_TOOLS.filter((rule) => /^Bash\(curl /.test(rule));
  assert.deepEqual(curl, [
    'Bash(curl *http://localhost:4321/*)',
    'Bash(curl *http://127.0.0.1:4321/*)',
    'Bash(curl *https://www.mattpyle.com/*)',
  ]);
  assert.ok(!FIXER_ALLOWED_TOOLS.some((rule) => /\(curl \*\)$/.test(rule)));
});

test('claudeArgs puts the prompt directly after -p, each list in one argument, and adds no directory', () => {
  const argv = claudeArgs({ prompt: 'Do the handoff below.', systemPrompt: 'sys' });
  assert.deepEqual(argv.slice(0, 2), ['-p', 'Do the handoff below.']);
  // A variadic flag swallows every argument after it up to the next flag, so a
  // list passed as several arguments would take whatever follows with it.
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], FIXER_ALLOWED_TOOLS.join(','));
  assert.ok(!argv.includes('--add-dir'));
});

test('the handoff rides in the prompt and the system prompt names no vault path', () => {
  const prompt = fixerPrompt(DEFECT_HANDOFF);
  assert.match(prompt, /^Do the handoff below\./);
  assert.ok(prompt.includes('## Verify'));
  const system = fixerSystemPrompt({ branch: 'fix/finding-x', base: 'master' });
  assert.match(system, /fix\/finding-x, cut from origin\/master/);
  assert.match(system, /docs\/ and steward\/ are absent/);
  assert.doesNotMatch(system, /[A-Za-z]:[\\/]/, 'no absolute path');
  // The run reports nothing for the PR: Steward runs the checks itself.
  assert.doesNotMatch(system, /json block|"checks"/);
  assert.match(system, /the activity runs the Verify commands itself/);
});

test('no worker variable reaches the child, a secret added later included', () => {
  // Every name `.env.example` documents, the two Upstash names the live `.env`
  // holds, and one nobody has added yet.
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const documented = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  assert.ok(documented.includes('VERCEL_AUTOMATION_BYPASS_SECRET'), 'the parse found the example names');
  const secrets = [...documented, 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_READONLY_TOKEN', 'NEW_SECRET_TOKEN'];
  const parent = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'GIT_ASKPASS', 'NODE_OPTIONS', 'npm_config_userconfig'];
  const worker = Object.fromEntries([...secrets, ...parent].map((name) => [name, 'x']));
  const env = fixerChildEnv({ ...worker, Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', TEMP: 'C:\\t' });
  for (const name of [...secrets, ...parent]) assert.ok(!(name in env), `${name} reached the child`);
  // Windows names match whatever their case.
  assert.deepEqual(env, { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', TEMP: 'C:\\t' });
});

// --- The event stream --------------------------------------------------------

test('the reducer follows a run from init to result', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', session_id: 's1' }),
    'not json, a stray hook line',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Building.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }] },
    }),
  ];
  let state = lines.reduce(reduceClaudeEvent, initialClaudeRunState());
  assert.equal(state.model, 'claude-x');
  assert.equal(state.lastActivity, 'Bash npm run build');
  assert.equal(state.finalMessage, null);

  state = reduceClaudeEvent(
    state,
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      num_turns: 12,
      total_cost_usd: 1.5,
      duration_ms: 60000,
      session_id: 's1',
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }],
    }),
  );
  assert.equal(state.finalMessage, 'Done.');
  assert.equal(state.isError, false);
  assert.equal(state.numTurns, 12);
  assert.equal(state.costUsd, 1.5);
  assert.deepEqual(state.permissionDenials, ['Bash git push']);
});

// --- The generator's template ------------------------------------------------

for (const [name, key, finding] of [
  ['a defect', DEFECT_KEY, DEFECT_FINDING],
  ['an opportunity', OPPORTUNITY_KEY, OPPORTUNITY_FINDING],
] as const) {
  test(`the generator's template on ${name}: the finding, the key and the seven sections, and no vault section`, () => {
    const prompt = handoffGeneratorPrompt({ key, finding, origin: ORIGIN });
    assert.ok(prompt.includes(`Finding: \`${key}\``));
    assert.ok(prompt.includes(`<finding>\n${finding.trim()}\n</finding>`), 'the finding rides whole, between its tags');
    const skeleton = prompt.slice(prompt.indexOf('# Handoff: <title>'), prompt.indexOf('The finding:'));
    assert.deepEqual(
      skeleton.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3)),
      [...HANDOFF_SECTIONS],
    );
    // Everything before the finding is the fixed template: the same text for
    // every finding but for the key.
    const fixed = prompt.slice(0, prompt.indexOf('<finding>'));
    assert.doesNotMatch(fixed, /Read first|## Document|## Close|docs\//);
    assert.match(fixed, /"How to measure"/);
    assert.match(fixed, /npm test -w @mattpyle\/steward/);
    // It is told to read the checkout, and no longer that it sees nothing of it.
    assert.match(fixed, /read the code the finding's cause names/);
    assert.match(fixed, /Cases: a list of every case the code under change handles/);
    assert.doesNotMatch(fixed, /sees the finding and nothing/);
  });
}

test('the generator runs with the three read-only tools: no shell, no write tool, no MCP server', () => {
  assert.deepEqual(HANDOFF_GENERATOR_TOOLS, ['Read', 'Grep', 'Glob']);
  const argv = handoffGeneratorArgs('the prompt');
  assert.deepEqual(argv.slice(0, 2), ['-p', 'the prompt']);
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(argv.indexOf('--tools'), argv.length - 2, 'the variadic flag is last, with one argument');
  assert.ok(argv.includes('--strict-mcp-config') && !argv.includes('--mcp-config'));
  assert.ok(argv.includes('--safe-mode'));
  for (const flag of ['--allowedTools', '--permission-mode', '--add-dir']) assert.ok(!argv.includes(flag), flag);
});

test('the template is the same for every finding but for the key', () => {
  const fixed = (key: string, finding: string) => {
    const prompt = handoffGeneratorPrompt({ key, finding, origin: ORIGIN });
    return prompt.slice(0, prompt.indexOf('<finding>')).replace(key, 'KEY');
  };
  assert.equal(fixed(DEFECT_KEY, DEFECT_FINDING), fixed(OPPORTUNITY_KEY, OPPORTUNITY_FINDING));
});

test('a handoff in the template passes, with or without a code fence around it', () => {
  assert.deepEqual(validateHandoff(MAPPED_HANDOFF, DEFECT_KEY, ORIGIN), []);
  const fenced = cleanHandoff(`\`\`\`markdown\r\n${MAPPED_HANDOFF.trim()}\r\n\`\`\`\r\n`);
  assert.equal(fenced, MAPPED_HANDOFF);
});

test('a handoff with no coverage map beside its block is refused', () => {
  assert.match(validateHandoff(DEFECT_HANDOFF, DEFECT_KEY, ORIGIN).join('; '), /there is no coverage map/);
});

test('a handoff is refused for each way it can leave the template', () => {
  const refused = (markdown: string, pattern: RegExp) => {
    const problems = validateHandoff(markdown, DEFECT_KEY, ORIGIN).join('; ');
    assert.match(problems, pattern);
  };
  refused(`Here is the handoff.\n\n${MAPPED_HANDOFF}`, /first line/);
  refused(MAPPED_HANDOFF.replace('## Out of scope', '## Close'), /sections are/);
  refused(MAPPED_HANDOFF.replace('## Goal', '## Read first\n\n1. The card.\n\n## Goal'), /sections are/);
  refused(MAPPED_HANDOFF.replace('`npx tsc', 'See docs/work/card.md. `npx tsc'), /docs\/ or steward\//);
  refused(MAPPED_HANDOFF.replace(DEFECT_KEY, 'another-key'), /"Finding:" line/);
  refused(MAPPED_HANDOFF.replace(/^1\. A unit test[\s\S]*?clean\.\n/m, 'Run the tests.\n'), /no numbered check/);
  // Cases: absent, and present but empty of any case.
  refused(MAPPED_HANDOFF.replace(/## Cases\n\n[\s\S]*?(?=## Tasks)/, ''), /sections are/);
  refused(MAPPED_HANDOFF.replace(/(## Cases\n\n)[\s\S]*?(?=## Tasks)/, '$1'), /Cases section lists no case/);
  refused(MAPPED_HANDOFF.replace(/(## Cases\n\n)[\s\S]*?(?=## Tasks)/, '$1Every gate.\n\n'), /Cases section lists no case/);
  refused(
    MAPPED_HANDOFF.replace('Name the failing reason in scorecard commentary', 'x'.repeat(HANDOFF_TITLE_MAX + 1)),
    /title is 73 characters/,
  );
  // A path under agents/steward/ is the repository's, not the vault's.
  assert.deepEqual(validateHandoff(MAPPED_HANDOFF, DEFECT_KEY, ORIGIN), []);
});

test('parseHandoff takes the title without its label and the Verify checks one per line', () => {
  const parsed = parseHandoff(DEFECT_HANDOFF.replace(/\n/g, '\r\n'));
  assert.equal(parsed.title, 'Name the failing reason in scorecard commentary');
  assert.deepEqual(parsed.checks, [
    'A unit test of `buildCommentary` shows the violation count for a gate that fails on axe violations. Run `npm test -w @mattpyle/steward`.',
    '`npx tsc --noEmit -p agents/steward` is clean.',
  ]);
  assert.deepEqual(parsed.cases, [
    'A gate that fails on axe violations: its score, then the violation count from `description`.',
    'A Performance gate under its floor: its score, unchanged.',
  ]);
  assert.equal(parseHandoff('# Handoff: x\n\n## Tasks\n\n1. Do it.\n').verify, null);
  assert.deepEqual(parseHandoff('# Handoff: x\n\n## Verify\n\n1. One check.\n').checks, ['One check.']);
});

// --- The checks Steward runs -------------------------------------------------

test('a check names a repository command only when a backtick span is one, whole', () => {
  assert.equal(repoCommandFor('Run `npm test -w @mattpyle/steward`: all pass.')?.command, 'npm test -w @mattpyle/steward');
  assert.equal(repoCommandFor('`buildCommentary` is covered. `npm  test` passes.')?.command, 'npm test');
  for (const check of [
    '`npm test -w @mattpyle/steward | tail -5` shows no failure.',
    '`npm test && curl https://example.com` passes.',
    '`npm run deploy` succeeds.',
    '`curl -s https://www.mattpyle.com/scorecard.json` names the violation count.',
    'npm test passes.',
  ]) {
    assert.equal(repoCommandFor(check), null, check);
  }
});

/** What the activity's `exec` reports for one command. */
function ran(exitCode: number, extra: Partial<RepoCommandRun> = {}): RepoCommandRun {
  return { exitCode, durationMs: 1200, timedOut: false, outputTail: exitCode === 0 ? 'ok' : 'Error: 1 failed', ...extra };
}

test('a Verify command outside the repository set is not-run and never spawned', async () => {
  const spawned: RepoCommand[] = [];
  const results = await runVerifyChecks(
    [
      '`curl -s https://www.mattpyle.com/scorecard.json` names the violation count.',
      '`npm test -w @mattpyle/steward`: all tests pass.',
      '`rm -rf .` leaves the tree clean.',
      '`npx tsc --noEmit -p agents/steward` exits with no errors.',
    ],
    async (command) => {
      spawned.push(command);
      return ran(0);
    },
  );
  // A pass keeps the exit code and the duration, and no output.
  assert.deepEqual(results, [
    { n: 1, status: 'not-run', command: null, reason: 'not a repository command' },
    { n: 2, status: 'pass', command: 'npm test -w @mattpyle/steward', exitCode: 0, durationMs: 1200 },
    { n: 3, status: 'not-run', command: null, reason: 'not a repository command' },
    { n: 4, status: 'pass', command: 'npx tsc --noEmit -p agents/steward', exitCode: 0, durationMs: 1200 },
  ]);
  // What is spawned is the fixed entry's argv, not the handoff's text.
  assert.deepEqual(
    spawned.map((command) => [command.binary, ...command.args]),
    [
      ['npm', 'test', '-w', '@mattpyle/steward'],
      ['npx', 'tsc', '--noEmit', '-p', 'agents/steward'],
    ],
  );
});

test('a non-zero exit is fail, a command two checks name runs once, and a fail makes the PR a draft', async () => {
  let runs = 0;
  const checks = await runVerifyChecks(
    ['`npm test -w @mattpyle/steward` passes.', 'The new test is in `npm test -w @mattpyle/steward`.', '`npm run check` is clean.'],
    async (command) => {
      runs++;
      return ran(command.command === 'npm run check' ? 0 : 1);
    },
  );
  assert.deepEqual(checks.map((check) => check.status), ['fail', 'fail', 'pass']);
  assert.equal(runs, 2);

  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks }), true);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: checks.slice(2) }), false);
  assert.equal(opensAsDraft({ exitCode: 0, timedOut: false, checks: [{ n: 1, status: 'not-run', command: null }] }), false);
  assert.equal(opensAsDraft({ exitCode: 1, timedOut: false, checks: [] }), true);

  const body = buildFixerPrBody({ ...BODY_INPUT, results: checks.slice(0, 2) });
  assert.match(body, /^> \*\*2 checks failed\.\*\* Steward ran the Verify commands on this branch after the run\./);
  assert.match(body, /\n   - Result: fail\n   - Command: `npm test -w @mattpyle\/steward`\n   - Exit code 1, after 1 s\.\n/);
  // The second check that names the command points at the first, not a second copy of its output.
  assert.match(body, /   - Output: under check 1, which ran the same command\./);
  assert.equal(body.split('<details>').length - 1, 1);
});

test('a failed command keeps its exit code, duration and output tail, and the PR shows them collapsed', async () => {
  const output = ['  1 passed', '  1 failed', '    [chromium] › retro.spec.ts:12 › /projects/ aria snapshot', 'Error: 1 failed'].join('\n');
  const checks = await runVerifyChecks(['`npm run a11y` passes.'], async () => ran(1, { durationMs: 252_000, outputTail: output }));
  assert.deepEqual(checks, [
    { n: 1, status: 'fail', command: 'npm run a11y', exitCode: 1, durationMs: 252_000, timedOut: false, outputTail: output },
  ]);
  const body = buildFixerPrBody({ ...BODY_INPUT, checks: ['`npm run a11y` passes.'], results: checks });
  assert.ok(
    body.includes(
      [
        '1. `npm run a11y` passes.',
        '   - Result: fail',
        '   - Command: `npm run a11y`',
        '   - Exit code 1, after 4 min 12 s.',
        '',
        '   <details><summary>The last 4 lines of its output</summary>',
        '',
        '   ```',
        '     1 passed',
        '     1 failed',
        '       [chromium] › retro.spec.ts:12 › /projects/ aria snapshot',
        '   Error: 1 failed',
        '   ```',
        '',
        '   </details>',
        '',
      ].join('\n'),
    ),
    body,
  );
});

test('a command killed at its time limit fails whatever its exit code, and the PR says so', async () => {
  const checks = await runVerifyChecks(['`npm run a11y` passes.'], async () =>
    ran(0, { durationMs: 600_000, timedOut: true, outputTail: 'Running 185 tests using 4 workers' }),
  );
  assert.equal(checks[0].status, 'fail');
  assert.equal(checks[0].timedOut, true);
  const body = buildFixerPrBody({ ...BODY_INPUT, checks: ['`npm run a11y` passes.'], results: checks });
  assert.match(body, /   - Timed out after 10 minutes, and was killed\. Exit code 0\.\n/);
  assert.match(body, /<summary>The last line of its output<\/summary>/);
});

test('a failed command with no output says so, and a result from before the tail renders as before', () => {
  const body = buildFixerPrBody({
    ...BODY_INPUT,
    results: [{ n: 1, status: 'fail', command: 'npm test -w @mattpyle/steward', exitCode: 2, durationMs: 4_000, timedOut: false, outputTail: '' }],
  });
  assert.match(body, /   - Exit code 2, after 4 s\.\n   - No output\.\n/);
  const old = buildFixerPrBody({ ...BODY_INPUT, results: [{ n: 1, status: 'fail', command: 'npm test -w @mattpyle/steward' }] });
  assert.match(old, /   - Command: `npm test -w @mattpyle\/steward`\n2\. /);
});

test('output with a fence in it gets a longer fence', () => {
  const body = buildFixerPrBody({
    ...BODY_INPUT,
    results: [{ n: 1, status: 'fail', command: 'npm test -w @mattpyle/steward', exitCode: 1, durationMs: 1, timedOut: false, outputTail: 'a\n```js\nb' }],
  });
  assert.match(body, /\n   ````\n   a\n   ```js\n   b\n   ````\n/);
});

test('the output tail keeps the last 60 lines, strips ANSI codes, and joins CRLF', () => {
  const output = Array.from({ length: 100 }, (_, i) => `\u001b[31mline ${i + 1}\u001b[39m`).join('\r\n') + '\r\n\r\n';
  const tail = checkOutputTail(output, {});
  const lines = tail.split('\n');
  assert.equal(CHECK_OUTPUT_TAIL_LINES, 60);
  assert.equal(lines.length, 60);
  assert.equal(lines[0], 'line 41');
  assert.equal(lines[59], 'line 100');
  assert.doesNotMatch(tail, /\u001b|\r/);
});

test('the output tail is at most 8,000 characters and starts on a whole line', () => {
  const output = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(296)}`).join('\n');
  const tail = checkOutputTail(output, {});
  assert.equal(CHECK_OUTPUT_TAIL_CHARS, 8_000);
  assert.ok(tail.length <= 8_000, String(tail.length));
  assert.match(tail, /^\d\d x/);
  assert.match(tail, /^49 x+$/m);
  // One line longer than the cap keeps its end.
  assert.equal(checkOutputTail('y'.repeat(20_000), {}).length, 8_000);
});

/** A stand-in secret, built at run time so the secret scan has no literal to flag. */
function fakeSecret(label: string): string {
  return [label, 'f'.repeat(12)].join('-');
}

test('a secret of the environment in the output is redacted before it leaves the worker', () => {
  const bypass = fakeSecret('bypass');
  const apiKey = fakeSecret('api');
  const npmToken = fakeSecret('npm');
  const env = {
    VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
    OPENAI_API_KEY: apiKey,
    npm_config__authToken: npmToken,
    SHORT_TOKEN: 'abc',
    PATH: '/usr/bin:/bin',
    HOME: '/home/steward',
  };
  const output = [
    `GET /?x-vercel-protection-bypass=${bypass} 200`,
    `key=${apiKey} token ${npmToken}`,
    'abc stays, /usr/bin stays, /home/steward stays',
  ].join('\n');
  assert.equal(
    checkOutputTail(output, env),
    ['GET /?x-vercel-protection-bypass=[redacted] 200', 'key=[redacted] token [redacted]', 'abc stays, /usr/bin stays, /home/steward stays'].join('\n'),
  );
  // A secret that contains another goes whole.
  assert.equal(redactSecrets('AAAAAAAABBBB', { A_KEY: 'AAAAAAAA', AB_TOKEN: 'AAAAAAAABBBB' }), '[redacted]');
});

test('a secret is redacted before the character cap, so no half of one survives', () => {
  // One line, 8,017 characters. Capped first, it would keep the secret's last ten.
  const value = fakeSecret('cap-order-0123'); // 27 characters
  const tail = checkOutputTail(`${value}${'z'.repeat(7_990)}`, { STEWARD_SECRET: value });
  assert.equal(tail, `[redacted]${'z'.repeat(7_990)}`);
  assert.doesNotMatch(tail, /f{4}/);
});

test('a duration reads in seconds, then minutes and seconds', () => {
  assert.equal(formatDuration(450), '0 s');
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(252_000), '4 min 12 s');
  assert.equal(formatDuration(600_000), '10 min');
});

// --- The PR body -------------------------------------------------------------

const BODY_INPUT = {
  key: DEFECT_KEY,
  finding: parseFindingBody(DEFECT_FINDING),
  checks: parseHandoff(DEFECT_HANDOFF).checks,
  results: [
    { n: 1, status: 'pass' as const, command: 'npm test -w @mattpyle/steward' },
    { n: 2, status: 'not-run' as const, command: null, reason: 'not a repository command' },
  ],
  filesChanged: ['agents/steward/src/workflows/scorecard-audit.ts', 'agents/steward/tests/workflows/scorecard-audit.test.ts'],
  exitCode: 0,
  timedOut: false,
};

test('the PR body is the finding: its line, evidence, cause, measure, the checks with results, and the key', () => {
  const body = buildFixerPrBody(BODY_INPUT);
  assert.match(body, /^Fixes one finding from Argus, the site's inspector: \/scorecard's run history says/);
  assert.match(body, /## Evidence\n\n- URL: https:\/\/www\.mattpyle\.com\/scorecard\/ \("Previous runs", 03 Sept 2026 row\)\n/);
  // A hard-wrapped bullet reads as one line, and the cause has its own section.
  assert.match(body, /- What happened: the row reads "Accessibility: 100\/100 \(Fail\)\." The reason it failed is not on the page\./);
  assert.doesNotMatch(body.slice(body.indexOf('## Evidence'), body.indexOf('## Cause')), /Cause, from the source/);
  assert.match(body, /## Cause\n\n`agents\/steward\/src\/workflows\/scorecard-audit\.ts` line 558, `buildCommentary\(\)` formats/);
  assert.match(body, /## Changed\n\n- `agents\/steward\/src\/workflows\/scorecard-audit\.ts`\n/);
  assert.match(body, /The finding's measure: A future run whose gate fails on axe violations/);
  assert.match(
    body,
    /\n1\. A unit test of `buildCommentary` .*\n   - Result: pass\n   - Command: `npm test -w @mattpyle\/steward`\n/,
  );
  assert.match(body, /\n2\. `npx tsc --noEmit -p agents\/steward` is clean\.\n   - Result: not-run \(not a repository command\)\n\n/);
  assert.ok(body.includes(`Finding: \`${DEFECT_KEY}\``));
  assert.match(body, /Steward never merges\.\*$/);
  assert.doesNotMatch(body, /Incomplete run|checks? failed/);
  assert.doesNotMatch(body, /—/, 'no em dash in a public body');
});

test('the PR body has no input for the model\'s final message', () => {
  // The spike published the final message, attribution line and all. The body
  // builder takes the finding and the results of checks Steward ran, nothing else.
  const body = buildFixerPrBody({ ...BODY_INPUT, ...({ finalMessage: 'SECRET-NARRATIVE 🤖' } as object) });
  assert.doesNotMatch(body, /SECRET-NARRATIVE|🤖/);
});

test('an incomplete run is named in the first line of the body', () => {
  assert.equal(isIncompleteRun({ exitCode: 0, timedOut: false }), false);
  assert.equal(isIncompleteRun({ exitCode: 1, timedOut: false }), true);
  assert.equal(isIncompleteRun({ exitCode: 0, timedOut: true }), true);
  assert.match(
    buildFixerPrBody({ ...BODY_INPUT, exitCode: 1 }),
    /^> \*\*Incomplete run\.\*\* Claude Code exited 1\. This PR holds what it left behind\.\n\nFixes one finding/,
  );
  assert.match(
    buildFixerPrBody({ ...BODY_INPUT, exitCode: -1, timedOut: true }),
    /^> \*\*Incomplete run\.\*\* Claude Code was stopped at its time limit\./,
  );
});
