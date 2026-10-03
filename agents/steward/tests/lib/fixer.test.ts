import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXER_ALLOWED_TOOLS,
  buildFixerPrBody,
  claudeArgs,
  fixerChildEnv,
  initialClaudeRunState,
  parseHandoff,
  reduceClaudeEvent,
} from '../../src/lib/fixer.js';

const HANDOFF = [
  '---',
  'status: queued',
  '---',
  '',
  '# Handoff: the page explains its cadence',
  '',
  '## Tasks',
  '',
  '1. Add the sentence.',
  '',
  '## Verify',
  '',
  '1. `npm run build` passes.',
  '2. `npm run a11y` green.',
  '',
  '## Close',
  '',
  'Flip the status.',
].join('\r\n');

test('parseHandoff takes the title without its label and the Verify body alone', () => {
  const parsed = parseHandoff(HANDOFF);
  assert.equal(parsed.title, 'the page explains its cadence');
  assert.equal(parsed.verify, '1. `npm run build` passes.\r\n2. `npm run a11y` green.');
});

test('parseHandoff reads a Verify section that ends the file', () => {
  const parsed = parseHandoff('# Handoff: x\n\n## Verify\n\n1. One check.\n');
  assert.equal(parsed.verify, '1. One check.');
});

test('parseHandoff reports a missing Verify section as null', () => {
  assert.equal(parseHandoff('# Handoff: x\n\n## Tasks\n\n1. Do it.\n').verify, null);
});

test('the child environment drops the worker secrets and the parent session', () => {
  const env = fixerChildEnv({
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN: 'g',
    TEMPORAL_API_KEY: 't',
    STEWARD_HEALTHCHECK_BASE: 'h',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    GITHUB_TOKENS_ARE_FINE: 'kept',
  });
  assert.deepEqual(env, { PATH: '/bin', GITHUB_TOKENS_ARE_FINE: 'kept' });
});

test('claudeArgs puts the prompt directly after -p and each list in one argument', () => {
  const argv = claudeArgs({ prompt: 'Read x and do it.', systemPrompt: 'sys', addDir: 'C:/vault' });
  assert.deepEqual(argv.slice(0, 2), ['-p', 'Read x and do it.']);
  // A variadic flag swallows every argument after it up to the next flag, so a
  // list passed as several arguments would take whatever follows with it.
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], FIXER_ALLOWED_TOOLS.join(','));
  assert.equal(argv.at(-2), '--add-dir');
  assert.equal(argv.at(-1), 'C:/vault');
});

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

test('the PR body leads with the report and flags an incomplete run', () => {
  const clean = buildFixerPrBody({ verify: '1. Check.', finalMessage: 'Added it.', exitCode: 0, timedOut: false });
  assert.doesNotMatch(clean, /Incomplete run/);
  assert.match(clean, /## What the run reported\n\nAdded it\.\n\n## Verify steps it was given\n\n1\. Check\./);

  const stopped = buildFixerPrBody({ verify: null, finalMessage: null, exitCode: 1, timedOut: true });
  assert.match(stopped, /^> \*\*Incomplete run\.\*\* Claude Code was stopped at its time limit/);
  assert.match(stopped, /ended without a final message/);
  assert.doesNotMatch(stopped, /Verify steps/);
});
