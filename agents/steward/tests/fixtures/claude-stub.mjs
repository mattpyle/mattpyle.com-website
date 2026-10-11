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
  default:
    process.exitCode = 2;
}
