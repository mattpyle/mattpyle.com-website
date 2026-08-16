import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// What the site is allowed to import out of Steward, and what that import may drag with it.
//
// The /mcp endpoint runs Steward's fast-tier audit inside a Vercel function. Steward's own
// dependency list is a Temporal worker's: @temporalio/*, chrome-launcher, lighthouse, the axe CLI,
// the Anthropic SDK. None of that belongs in a serverless bundle — tens of megabytes of dead
// weight on a good day, a build failure on a bad one — and none of it is reachable from the fast
// tier, which is a dozen HTTP round trips and no browser.
//
// "Not reachable" is the kind of claim that stops being true quietly, so this walks the real
// module graph from the published entry point and reads every bare specifier in it. It is a
// source walk rather than a bundle inspection on purpose: it runs in `npm test` in under a
// second, with no build, so the failure lands on the commit that caused it rather than on a
// deploy.
//
// Both static and dynamic imports are followed, because a bundler follows both. That is the whole
// reason `checks.ts` takes a `loadDeep` thunk instead of writing `await import('./deep.js')` where
// the deep tier runs: the dynamic form is lazy for Node and eager for Rollup, and this test could
// not tell the difference.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stewardRoot = path.join(repoRoot, 'agents', 'steward');

/** The exports map's one entry, read from the package rather than hard-coded beside it. */
const stewardPackage = JSON.parse(readFileSync(path.join(stewardRoot, 'package.json'), 'utf8'));

/**
 * Packages that must never appear in the fast tier's graph.
 *
 * Matched as a package name or a scope prefix, so `@temporalio/worker` is caught by
 * `@temporalio/`. The site's own dependency list is not consulted: a package being installed at
 * the root is exactly the accident this guards against.
 */
const FORBIDDEN = ['@temporalio/', 'chrome-launcher', 'lighthouse', '@axe-core/', '@anthropic-ai/'];

/**
 * Every specifier a file imports **as a value**, read off the TypeScript AST.
 *
 * Parsed rather than pattern-matched, because the distinction this test turns on is one a regex
 * cannot see. `import type { DeepOptions } from './deep.js'` is erased at compile time and reaches
 * no bundle; `await import('./deep.js')` is followed by every bundler there is. The two lines look
 * almost identical and mean opposite things, and the first of them is in `checks.ts` right now.
 *
 * Three node kinds carry a value specifier: a non-type-only `import`, a non-type-only
 * `export … from`, and a dynamic `import()` call. `typeof import('./deep.js')` inside a type
 * annotation is an ImportType node, which is none of them, and is correctly ignored.
 */
function specifiersIn(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const found = new Set();

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = node.importClause?.isTypeOnly || node.isTypeOnly;
      if (!typeOnly) found.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return [...found];
}

/**
 * A relative specifier, resolved to the file on disk.
 *
 * Steward's source is NodeNext-shaped: a `.ts` file imports its sibling as `./safe-fetch.js`. Vite
 * resolves that back to the `.ts`, and so does this.
 */
function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // Next candidate.
    }
  }
  throw new Error(`${path.relative(repoRoot, fromFile)} imports "${specifier}", which resolves to nothing`);
}

/**
 * Walks the graph from one entry file.
 *
 * Returns the files visited and every bare (non-relative) specifier any of them named — a bare
 * specifier is a package, and a package is what ends up in the function bundle.
 */
function walk(entry) {
  const files = new Set();
  const packages = new Map();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiersIn(file, readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier));
        continue;
      }
      if (!packages.has(specifier)) packages.set(specifier, path.relative(repoRoot, file));
    }
  }
  return { files, packages };
}

const entry = path.join(stewardRoot, stewardPackage.exports['./agent-audit/fast'].default);
const graph = walk(entry);

test('the package publishes exactly the two entries the /mcp function needs', () => {
  // Every entry is an import graph the site's function bundle inherits, and none of the rest of
  // Steward is meant to leave the workspace. The list is asserted rather than bounded so that
  // adding a third is a deliberate act with an argument attached, per the root CLAUDE.md rule.
  //
  // The second entry, added 2026-08-15 for the public deep tier, is affordable because its graph
  // is empty of value imports — it publishes names and types, not code. That is checked by
  // tests/steward-deep-contract-packaging.test.mjs rather than assumed here.
  assert.deepEqual(Object.keys(stewardPackage.exports), [
    './agent-audit/fast',
    './agent-audit/deep-contract',
  ]);
});

test('nothing in the fast tier reaches Temporal, Chrome, Lighthouse or axe', () => {
  const offenders = [...graph.packages].filter(([name]) =>
    FORBIDDEN.some((forbidden) => name === forbidden || name.startsWith(forbidden)),
  );
  assert.deepEqual(
    offenders,
    [],
    `the /mcp function's import graph must not reach these: ${offenders
      .map(([name, from]) => `${name} (imported by ${from})`)
      .join(', ')}`,
  );
});

test('the fast tier imports only the packages it is expected to', () => {
  // Stated as an allowlist rather than only as a denylist, so a new dependency has to be looked at
  // once by a person. undici is the fetch layer's dispatcher, node:* is the platform.
  const allowed = new Set(['undici']);
  const unexpected = [...graph.packages.keys()].filter(
    (name) => !name.startsWith('node:') && !allowed.has(name),
  );
  assert.deepEqual(
    unexpected,
    [],
    'a new package in the fast tier ships to the /mcp function; add it here deliberately',
  );
});

test('deep.ts is not in the graph at all', () => {
  // The specific file the whole `loadDeep` indirection exists to keep out. Named separately from
  // the package check because it is the one that regresses first: re-inlining the dynamic import
  // in checks.ts would pull it back with no new package name to notice.
  const deep = [...graph.files].filter((file) => path.basename(file) === 'deep.ts');
  assert.deepEqual(deep.map((file) => path.relative(repoRoot, file)), []);
});
