#!/usr/bin/env node
// Prints the Steward test files a pull request must run: every test whose
// imports reach a changed file, and the whole suite when the graph cannot say.
//
//   git diff --name-only origin/master | node scripts/select-steward-tests.mjs
//   node scripts/select-steward-tests.mjs agents/steward/src/lib/findings.ts
//
// `--event <name>` names a non-pull-request event (the answer is the full suite).
// `--browser` adds the real-Chrome test to a list, for a change that sets the
// routing `browser` output.
// `--root <dir>` points at another repository root, which the script's test uses.
//
// Changed files are repository-relative paths, as arguments or one per line on
// standard input. Standard output is one line, relative to `agents/steward/`,
// where the Steward job runs:
//
//   tests/**/*.test.ts            the full suite (the glob, for node to expand)
//   tests/lib/a.test.ts tests/... a space-separated list of test files
//   (empty)                       no test reaches the change: the typecheck is the check
//
// The reason for the answer goes to standard error. A nonzero exit is a failure
// (TypeScript not installed, an unreadable tree); the Steward job treats it as
// "run the full suite". The script needs the `typescript` package, so it runs in
// the Steward job after `npm ci`.
//
// The graph. TypeScript's own `createProgram` builds the program `tsc` builds from
// `agents/steward/tsconfig.json`, and each import specifier resolves with
// `ts.resolveModuleName` under the options in that file, so an import resolves as
// `tsc` resolves it. Packages are left unresolved: nothing in `node_modules` is a
// Steward file, and parsing it would cost seconds. A test is selected when it is
// a changed file itself or its transitive imports include one.
//
// Only imports that load code count. `import type`, `export type` and a type in
// a `typeof import(...)` position are dropped: `tsx` erases them, so they cannot
// change a test's result, and the typecheck, which still runs, sees them. Without
// this the workflows' `import type * as activities` makes every workflow change
// reach every activity, and one `src/lib` module reaches 45 of 130 tests.
//
// What the graph cannot see, and how this script covers it:
//   1. A test that names a file as a string: `new URL('../../src/x.ts',
//      import.meta.url)`, `path.join(SRC, 'worker.ts')`, a bundler path. Every
//      string literal in a file under `tests/` that ends in .ts, .mts, .js or
//      .mjs adds an edge to the file it names (a bare name adds one to every
//      Steward file of that name, which over-selects and never under-selects).
//   2. A test that reads a whole directory. `DIRECTORY_READERS` names them, and
//      `tests/select-steward-tests.test.mjs` fails when a new one appears.
//   3. Replay fixtures guard command sequences, which no import shows. A change
//      under `src/workflows/` therefore adds `tests/workflows/replay.test.ts`.
//
// The full suite runs when the event is not a pull request, when a changed file
// is one every test process loads or reads (see `FULL_*` below), or when a
// changed file under `agents/steward/` is not TypeScript and no TypeScript folder
// owns it: the graph cannot say who reads a rubric, a Vale style or a script. A
// file in a folder of TypeScript, such as `src/console/assets/findings.js`, counts
// as a change to that folder's modules. A change to this file runs the
// suite, like every routing script. The header of `ci.yml` has the table.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FULL_GLOB = 'tests/**/*.test.ts';
const REPLAY = 'tests/workflows/replay.test.ts';
const CHROME = 'tests/lib/agent-audit-deep-chrome.test.ts';
const STEWARD = 'agents/steward';

// Exact paths whose change touches every test: the install, the compiler
// options, and the files that decide what runs.
const FULL_EXACT = new Set([
  'package.json',
  'package-lock.json',
  `${STEWARD}/package.json`,
  '.github/workflows/ci.yml',
  'scripts/route-changes.sh',
  'scripts/select-steward-tests.mjs',
  'scripts/vercel-ignore.sh',
]);
// Folders every test process loads (helpers, fixtures) or reads as published
// data (content, scorecard data).
const FULL_PREFIXES = [`${STEWARD}/tests/helpers/`, `${STEWARD}/tests/fixtures/`, 'src/content/', 'src/data/'];

// Tests that read a directory of Steward source and so depend on all of it. Paths
// are relative to `agents/steward/`; a prefix ending in `/` means every file in it.
export const DIRECTORY_READERS = {
  'tests/lib/steward-update.test.ts': ['src/workflows/'],
  'tests/workflows/finding-fix-path.test.ts': ['src/'],
  'tests/lib/worker-role.test.ts': ['src/'],
  'tests/workflows/bounded-workers.test.ts': ['tests/'],
};

const posix = (p) => p.split(path.sep).join('/');

function loadTypeScript(root) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const paths = [root, path.join(root, STEWARD), here];
  const require = createRequire(import.meta.url);
  try {
    return require(require.resolve('typescript', { paths }));
  } catch {
    return null;
  }
}

function walk(dir, keep, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The runtime import graph of `agents/steward/`: file to the files it loads, both
 * as absolute paths. The program is the one `tsc` builds from `tsconfig.json`, and
 * each specifier resolves with the compiler options in that file. Imports that
 * only name types (`import type`, `export type`, `typeof import(...)` in a type
 * position) are left out: `tsx` erases them, so they cannot change a test's
 * result, and the typecheck still sees them.
 */
function buildGraph(ts, stewardDir) {
  const configPath = path.join(stewardDir, 'tsconfig.json');
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, stewardDir);
  const options = { ...parsed.options, noEmit: true, noLib: true, types: [], skipLibCheck: true };
  const host = ts.createCompilerHost(options, false);
  // Relative imports resolve as `tsc` resolves them; packages stay unresolved, so
  // nothing in `node_modules` is parsed.
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) =>
      literal.text.startsWith('.')
        ? ts.resolveModuleName(literal.text, containingFile, options, host)
        : { resolvedModule: undefined },
    );
  const program = ts.createProgram({ rootNames: parsed.fileNames, options, host });
  const inSteward = (file) => !path.relative(stewardDir, file).startsWith('..');
  const edges = new Map();
  const literalsOf = new Map();
  const specifiersOf = (sf, literals) => {
    const out = [];
    const visit = (node) => {
      if (literals && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) literals.push(node.text);
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
        if (!typeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node)) {
        const ref = node.moduleReference;
        if (!node.isTypeOnly && ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)) out.push(ref.expression.text);
      } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
          out.push(node.arguments[0].text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  };
  for (const sf of program.getSourceFiles()) {
    const file = path.resolve(sf.fileName);
    if (!inSteward(file) || sf.isDeclarationFile) continue;
    const literals = path.relative(stewardDir, file).split(path.sep)[0] === 'tests' ? [] : null;
    if (literals) literalsOf.set(file, literals);
    const targets = new Set();
    for (const specifier of specifiersOf(sf, literals)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = ts.resolveModuleName(specifier, file, options, host).resolvedModule?.resolvedFileName;
      if (resolved && inSteward(path.resolve(resolved))) targets.add(path.resolve(resolved));
    }
    edges.set(file, targets);
  }
  return { edges, literalsOf };
}

/** Steward files that the string literals of one test file name, relative to `agents/steward/`. */
function literalTargets(literals, file, stewardDir, byBasename) {
  const found = new Set();
  for (const literal of literals) {
    if (!/\.(?:m?ts|m?js)$/.test(literal) || /\s/.test(literal)) continue;
    if (literal.includes('/')) {
      for (const from of [path.dirname(file), stewardDir]) {
        const target = path.resolve(from, literal);
        if (fs.existsSync(target) && fs.statSync(target).isFile()) found.add(target);
      }
    } else {
      for (const target of byBasename.get(literal) ?? []) found.add(target);
    }
  }
  return [...found];
}

/**
 * The TypeScript modules that own a file the graph cannot follow, such as a script
 * the console serves from `src/console/assets/`: the `.ts` files in the nearest
 * folder at or above it that holds any, no higher than `src/<folder>/`. A file
 * with no such owner (a rubric, a Vale style, a script outside `src/`) gets null.
 */
function ownerModules(stewardDir, inner) {
  for (let dir = path.posix.dirname(inner); dir.startsWith('src/'); dir = path.posix.dirname(dir)) {
    const full = path.join(stewardDir, dir);
    if (!fs.existsSync(full)) continue;
    const owners = fs.readdirSync(full).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'));
    if (owners.length > 0) return owners.map((n) => `${dir}/${n}`);
  }
  return null;
}

/**
 * @param {object} input
 * @param {string} input.root          Repository root (holds `agents/steward/`).
 * @param {string[]} input.changed     Repository-relative changed paths.
 * @param {string} [input.event]       `pull_request` (default) or any other event.
 * @param {boolean} [input.browser]    The change sets the routing `browser` output.
 * @param {object} input.ts            The TypeScript module.
 * @returns {{ mode: 'all' | 'list' | 'none', files: string[], reasons: string[] }}
 */
export function selectTests(input) {
  const result = selectByGraph(input);
  if (!input.browser || result.mode === 'all') return result;
  // The real-Chrome test guards the browser runners, the proxy and the Dockerfile;
  // a Dockerfile change reaches it through no import.
  const files = result.files.includes(CHROME) ? result.files : [...result.files, CHROME].sort();
  return { mode: 'list', files, reasons: [...result.reasons, `${CHROME} runs for a change that sets browser`] };
}

function selectByGraph({ root, changed, event = 'pull_request', ts }) {
  const all = (reason) => ({ mode: 'all', files: [], reasons: [reason] });
  if (event !== 'pull_request') return all(`the event is ${event}, not a pull request`);

  const stewardDir = path.join(root, STEWARD);
  const paths = changed.map((p) => posix(p.trim())).filter(Boolean);
  const changedSteward = [];
  for (const p of paths) {
    const base = path.posix.basename(p);
    if (FULL_EXACT.has(p)) return all(`${p} is shared by every test`);
    if (/^tsconfig.*\.json$/.test(base)) return all(`${p} sets the compiler options`);
    const prefix = FULL_PREFIXES.find((x) => p.startsWith(x));
    if (prefix) return all(`${p} is under ${prefix}, which every test loads or reads`);
    if (!p.startsWith(`${STEWARD}/`)) continue;
    const inner = p.slice(STEWARD.length + 1);
    if (inner.endsWith('.ts') && !inner.endsWith('.d.ts')) changedSteward.push(inner);
    else if (/\.md$/.test(inner) && !inner.startsWith('src/')) continue; // documentation
    else if (/^(Dockerfile|\.dockerignore|console\.cmd)$/.test(inner)) continue; // no test reads it
    else {
      const owners = ownerModules(stewardDir, inner);
      if (!owners) return all(`${p} is not TypeScript, so no import graph says who reads it`);
      changedSteward.push(inner, ...owners);
    }
  }
  if (changedSteward.length === 0) return { mode: 'none', files: [], reasons: ['no changed file is Steward TypeScript'] };

  const tests = walk(path.join(stewardDir, 'tests'), (n) => n.endsWith('.test.ts')).map((f) => posix(path.relative(stewardDir, f)));
  tests.sort();
  const { edges, literalsOf } = buildGraph(ts, stewardDir);
  const rel = (file) => posix(path.relative(stewardDir, file));

  const stewardFiles = walk(stewardDir, (n) => /\.(m?ts|m?js)$/.test(n) && !n.endsWith('.d.ts'));
  const byBasename = new Map();
  for (const f of stewardFiles) {
    if (!byBasename.has(path.basename(f))) byBasename.set(path.basename(f), []);
    byBasename.get(path.basename(f)).push(f);
  }
  // Edges the imports do not show: string-literal paths in files under `tests/`.
  for (const [file, literals] of literalsOf) {
    for (const target of literalTargets(literals, file, stewardDir, byBasename)) edges.get(file).add(target);
  }
  for (const [test, dirs] of Object.entries(DIRECTORY_READERS)) {
    const file = path.join(stewardDir, test);
    for (const dir of dirs) {
      for (const f of stewardFiles) if (rel(f).startsWith(dir) && edges.has(file)) edges.get(file).add(f);
    }
  }

  const changedSet = new Set(changedSteward);
  const selected = [];
  const reasons = [];
  for (const test of tests) {
    const start = path.join(stewardDir, test);
    const seen = new Set([start]);
    const stack = [start];
    let hit;
    while (stack.length) {
      const file = stack.pop();
      if (!hit && changedSet.has(rel(file))) hit = rel(file);
      for (const next of edges.get(file) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    if (hit) {
      selected.push(test);
      reasons.push(`${test} reaches ${hit}`);
    }
  }
  if ([...changedSet].some((f) => f.startsWith('src/workflows/')) && !selected.includes(REPLAY)) {
    selected.push(REPLAY);
    reasons.push(`${REPLAY} rides with a change under src/workflows/`);
  }
  selected.sort();
  return selected.length === 0
    ? { mode: 'none', files: [], reasons: ['no test imports a changed file'] }
    : { mode: 'list', files: selected, reasons };
}

async function main() {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  let event = 'pull_request';
  let browser = false;
  const changed = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--event') event = args[++i];
    else if (args[i] === '--root') root = path.resolve(args[++i]);
    else if (args[i] === '--browser') browser = true;
    else changed.push(args[i]);
  }
  if (changed.length === 0 && !process.stdin.isTTY) changed.push(...fs.readFileSync(0, 'utf8').split(/\r?\n/));
  const ts = loadTypeScript(root);
  if (!ts) throw new Error('the typescript package is not installed here; run npm ci');
  const result = selectTests({ root, changed, event, ts, browser });
  for (const reason of result.reasons) console.error(`select-steward-tests: ${reason}`);
  console.log(result.mode === 'all' ? FULL_GLOB : result.files.join(' '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`select-steward-tests: ${error.stack ?? error}`);
    process.exit(1);
  });
}
