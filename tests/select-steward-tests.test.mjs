import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DIRECTORY_READERS, FULL_GLOB, selectTests } from '../scripts/select-steward-tests.mjs';

/**
 * `scripts/select-steward-tests.mjs` on a small Steward tree built in a temp
 * directory, then on the real one for the edges the graph cannot see. The tree is
 * written here, not checked in, so the site's `astro check` never meets it.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(import.meta.url)('typescript');
const S = 'agents/steward';

const TREE = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
    include: ['src/**/*.ts', 'tests/**/*.ts'],
  }),
  'src/lib/a.ts': 'export const a = 1;\n',
  'src/lib/b.ts': "import { a } from './a.js';\nexport const b = a + 1;\n",
  'src/lib/shapes.ts': 'export interface Shape { sides: number }\n',
  'src/lib/lonely.ts': 'export const lonely = true;\n',
  'src/lib/lazy.ts': 'export const lazy = 1;\n',
  'src/workflows/flow.ts': "import type { Shape } from '../lib/shapes.js';\nimport { b } from '../lib/b.js';\nexport const flow = (s: Shape) => b + s.sides;\n",
  'src/workflows/index.ts': "export * from './flow.js';\n",
  'src/ui/page.ts': "export const page = 'served';\n",
  'src/ui/assets/app.js': 'console.log(1);\n',
  'tests/ui/page.test.ts': "import { page } from '../../src/ui/page.js';\nvoid page;\n",
  'src/cli.ts': "export const run = async () => (await import('./lib/lazy.js')).lazy;\n",
  'src/worker.ts': 'export const worker = 1;\n',
  'tests/helpers/bundle.ts': "export const entry = new URL('../../src/workflows/index.ts', import.meta.url);\n",
  'tests/lib/a.test.ts': "import { a } from '../../src/lib/a.js';\nvoid a;\n",
  'tests/lib/b.test.ts': "import { b } from '../../src/lib/b.js';\nvoid b;\n",
  'tests/lib/shapes.test.ts': "import type { Shape } from '../../src/lib/shapes.js';\nexport type S = Shape;\n",
  'tests/lib/worker-text.test.ts': "import path from 'node:path';\nexport const file = path.join('src', 'worker.ts');\n",
  'tests/lib/steward-update.test.ts': 'export const reads = "the workflow sources as text";\n',
  'tests/cli/cli.test.ts': "import path from 'node:path';\nexport const cli = path.join('src', 'cli.ts');\n",
  'tests/workflows/flow.test.ts': "import { entry } from '../helpers/bundle.js';\nvoid entry;\n",
  'tests/workflows/replay.test.ts': 'export const replays = true;\n',
};

function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'select-steward-'));
  for (const [name, body] of Object.entries(TREE)) {
    const file = path.join(root, S, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

const root = buildTree();
const pick = (...changed) => selectTests({ root, changed, ts });
const files = (...changed) => pick(...changed).files;

test('a changed module selects the tests that import it, directly or through another module', () => {
  assert.deepEqual(files(`${S}/src/lib/a.ts`), ['tests/lib/a.test.ts', 'tests/lib/b.test.ts', 'tests/lib/steward-update.test.ts', 'tests/workflows/flow.test.ts']);
  assert.deepEqual(files(`${S}/src/lib/b.ts`), ['tests/lib/b.test.ts', 'tests/lib/steward-update.test.ts', 'tests/workflows/flow.test.ts']);
});

test('a changed test file selects itself', () => {
  assert.deepEqual(files(`${S}/tests/lib/a.test.ts`), ['tests/lib/a.test.ts']);
});

test('a type-only import does not select: tsx erases it and the typecheck still sees it', () => {
  const result = pick(`${S}/src/lib/shapes.ts`);
  assert.equal(result.mode, 'none');
  assert.deepEqual(result.files, []);
});

test('a module no test reaches selects nothing', () => {
  assert.equal(pick(`${S}/src/lib/lonely.ts`).mode, 'none');
});

test('a string-built path is an edge: a bundler entry, a spawned CLI, a file read as text', () => {
  assert.deepEqual(files(`${S}/src/workflows/index.ts`), ['tests/lib/steward-update.test.ts', 'tests/workflows/flow.test.ts', 'tests/workflows/replay.test.ts']);
  assert.deepEqual(files(`${S}/src/cli.ts`), ['tests/cli/cli.test.ts']);
  assert.deepEqual(files(`${S}/src/lib/lazy.ts`), ['tests/cli/cli.test.ts']);
  assert.deepEqual(files(`${S}/src/worker.ts`), ['tests/lib/worker-text.test.ts']);
});

test('a change under src/workflows/ adds the replay suite and the directory readers', () => {
  assert.deepEqual(files(`${S}/src/workflows/flow.ts`), [
    'tests/lib/steward-update.test.ts',
    'tests/workflows/flow.test.ts',
    'tests/workflows/replay.test.ts',
  ]);
});

test('the full suite runs for the shared files, the config files and a push', () => {
  for (const changed of [
    `${S}/tests/helpers/bundle.ts`,
    `${S}/tests/fixtures/histories/x.bin`,
    `${S}/package.json`,
    'package-lock.json',
    `${S}/tsconfig.json`,
    'tsconfig.json',
    '.github/workflows/ci.yml',
    'scripts/route-changes.sh',
    'scripts/select-steward-tests.mjs',
    'src/content/writing/post.md',
    'src/data/scorecard-runs.json',
  ]) {
    assert.equal(pick(changed, `${S}/src/lib/lonely.ts`).mode, 'all', changed);
  }
  assert.equal(selectTests({ root, changed: [`${S}/src/lib/a.ts`], event: 'push', ts }).mode, 'all');
});

test('a script in a folder of TypeScript counts as a change to that folder', () => {
  assert.deepEqual(files(`${S}/src/ui/assets/app.js`), ['tests/ui/page.test.ts']);
});

test('a file under agents/steward that is not TypeScript runs the full suite, unless nothing reads it', () => {
  for (const changed of [`${S}/src/rubrics/ai-tells.md`, `${S}/vale/styles/x.yml`, `${S}/scripts/steward.mjs`]) {
    assert.equal(pick(changed).mode, 'all', changed);
  }
  for (const changed of [`${S}/README.md`, `${S}/CLAUDE.md`, `${S}/Dockerfile`, 'src/pages/index.astro']) {
    assert.equal(pick(changed).mode, 'none', changed);
  }
});

test('a change that sets browser keeps the real-Chrome test, and the full suite already has it', () => {
  const chrome = 'tests/lib/agent-audit-deep-chrome.test.ts';
  assert.deepEqual(selectTests({ root, changed: [`${S}/Dockerfile`], ts, browser: true }).files, [chrome]);
  assert.ok(selectTests({ root, changed: [`${S}/src/lib/a.ts`], ts, browser: true }).files.includes(chrome));
  assert.equal(selectTests({ root, changed: [`${S}/package.json`], ts, browser: true }).mode, 'all');
});

test('the command line prints the glob, a list or an empty line, and reads standard input', () => {
  const run = (input, ...args) =>
    execFileSync('node', ['scripts/select-steward-tests.mjs', '--root', root, ...args], { cwd: repo, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  assert.equal(run('', `${S}/tests/helpers/bundle.ts`), `${FULL_GLOB}\n`);
  assert.equal(run('', `${S}/src/lib/a.ts`), 'tests/lib/a.test.ts tests/lib/b.test.ts tests/lib/steward-update.test.ts tests/workflows/flow.test.ts\n');
  assert.equal(run(`${S}/src/lib/lonely.ts\r\n${S}/README.md\r\n`), '\n');
  assert.equal(run('', '--event', 'push', `${S}/src/lib/a.ts`), `${FULL_GLOB}\n`);
  assert.equal(run('', '--browser', `${S}/Dockerfile`), 'tests/lib/agent-audit-deep-chrome.test.ts' + String.fromCharCode(10));
});

// The real tree. Each assertion names an edge the import graph alone cannot see.
const real = (...changed) => selectTests({ root: repo, changed, ts }).files;

test('the real tree: the workflow bundle, the spawned CLI and the text readers are edges', () => {
  assert.ok(real(`${S}/src/workflows/index.ts`).includes('tests/workflows/finding.test.ts'), 'workflow-bundle.ts bundles src/workflows/index.ts');
  assert.ok(real(`${S}/src/cli.ts`).includes('tests/cli/finding-cli.test.ts'), 'finding-cli.test.ts spawns src/cli.ts');
  assert.ok(real(`${S}/src/worker.ts`).includes('tests/lib/recycle-policy.test.ts'), 'recycle-policy.test.ts reads worker.ts as text');
  assert.ok(real(`${S}/src/console/assets/findings.js`).includes('tests/console/findings-client.test.ts'), 'a console script read as text');
});

test('the real tree: the replay suite rides with a workflow change', () => {
  assert.ok(real(`${S}/src/workflows/finding.ts`).includes('tests/workflows/replay.test.ts'));
  assert.ok(!real(`${S}/src/lib/action-usage.ts`).includes('tests/workflows/replay.test.ts'));
});

test('the real tree: a test that reads a source directory is named in DIRECTORY_READERS', () => {
  // A test that lists a directory depends on every file in it, which no import
  // shows. When this fails, add the test to DIRECTORY_READERS in the script, or add
  // it here when the directory it reads sits outside agents/steward/src.
  const outsideSrc = new Set(['tests/activities/cspell-published.test.ts']);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts') && /\breaddir(?:Sync)?\(/.test(fs.readFileSync(full, 'utf8'))) {
        found.push(path.relative(path.join(repo, S), full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(repo, S, 'tests'));
  assert.deepEqual(found.sort(), [...Object.keys(DIRECTORY_READERS), ...outsideSrc].sort());
});
