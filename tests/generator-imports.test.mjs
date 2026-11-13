import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * CI generates `a2a-digest.json`, `agent-skills-index.json` and `page-paths.mjs` on the pull
 * request's base commit in a worktree with no `npm ci` (the step "Show generated data diff" in
 * .github/workflows/ci.yml). That works only while the generators reach nothing but `node:`
 * builtins and repository files. This test walks the static imports of the three scripts and
 * fails on any file that imports a package, naming the file and the package.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATORS = ['generate-a2a-digest.mjs', 'generate-agent-skills-index.mjs', 'generate-page-paths.mjs'].map((f) => path.join(ROOT, 'scripts', f));

/** Specifiers of static `import ... from '...'`, `export ... from '...'` and bare `import '...'`. */
export function importSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = [];
  const pattern = /^\s*(?:import|export)\b\s*(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;
  for (const match of code.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** Every package import in the graph, as `file imports package`. */
export function packageImports(entries) {
  const seen = new Set();
  const problems = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) visit(path.resolve(path.dirname(file), specifier));
      else problems.push(`${path.relative(ROOT, file).split(path.sep).join('/')} imports ${specifier}`);
    }
  };
  entries.forEach(visit);
  return { files: seen, problems };
}

test('the generators reach only node: builtins and repository files', () => {
  const { files, problems } = packageImports(GENERATORS);
  assert.ok(files.size > GENERATORS.length, 'the walk followed relative imports');
  assert.deepEqual(problems, [], 'a generator imports a package, which the CI base worktree does not install');
});

test('the walk finds a package import and ignores node: builtins', () => {
  assert.deepEqual(importSpecifiers("import fs from 'node:fs';\nimport yaml from 'js-yaml';\nimport { a } from './a.mjs';\n// import x from 'nope';\nexport { b } from '../b.mjs';\nimport 'side-effect';"), ['node:fs', 'js-yaml', './a.mjs', '../b.mjs', 'side-effect']);
});
