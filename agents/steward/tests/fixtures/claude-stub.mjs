// A stand-in for `claude -p --output-format stream-json`, for the runner's
// tests. The first argument picks how the run goes.
import fs from 'node:fs';

const [mode, file] = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const init = () => emit({ type: 'system', subtype: 'init', model: 'stub-model', session_id: 'stub-session' });
const tool = (command) =>
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const forever = () => setInterval(() => {}, 1000);

switch (mode) {
  // A finished run.
  case 'ok':
    init();
    tool('npm test');
    emit({ type: 'result', is_error: false, result: 'Done.', num_turns: 3, total_cost_usd: 0.5, duration_ms: 10 });
    break;
  // A model that keeps working past any deadline: an event every 50ms.
  case 'busy':
    init();
    setInterval(() => tool('npm run build'), 50);
    break;
  // A process that starts a turn and then says nothing.
  case 'silent':
    init();
    tool('npm run a11y');
    forever();
    break;
  // Changes on disk, then a crash before any result event.
  case 'exit1':
    init();
    fs.writeFileSync(file, 'half a fix\n');
    process.stderr.write('API Error: overloaded\n');
    process.exitCode = 1;
    break;
  // A reviewer: reads the prompt from stdin, keeps a copy beside the reply
  // file, and answers with the reply file's text.
  case 'reply': {
    const prompt = fs.readFileSync(0, 'utf8');
    fs.writeFileSync(`${file}.stdin`, prompt);
    init();
    emit({
      type: 'result',
      is_error: false,
      result: fs.readFileSync(file, 'utf8'),
      num_turns: 1,
      total_cost_usd: 0.02,
      duration_ms: 10,
      usage: { input_tokens: 3, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 120 },
    });
    break;
  }
  default:
    process.exitCode = 2;
}
