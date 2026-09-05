import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// The second exports entry, and the property that made a second one affordable.
//
// The /mcp function's deep tools start `auditSiteWorkflow` on Temporal Cloud and poll its query.
// To do that they need a workflow type name, a task queue, a query name, a workflow-ID scheme, a
// budget, and the type of what the query answers. Every one of those is a string or a type that
// already exists in the Steward workspace, and re-typing them on the site is how the two sides end
// up disagreeing the day one of them changes.
//
// So the workspace publishes them — under a rule stricter than the fast entry's. The fast entry is
// real code and is guarded by a denylist of packages it must not reach. This entry is required to
// have **no value imports at all**: no packages, and no relative files either. What it costs the
// function's bundle is therefore nothing, which is the whole of the argument for adding it.
//
// A `import type` line is allowed and is invisible here on purpose: it is erased before any bundler
// sees it, which is the same distinction tests/steward-fast-audit-packaging.test.mjs turns on.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stewardRoot = path.join(repoRoot, 'agents', 'steward');
const stewardPackage = JSON.parse(readFileSync(path.join(stewardRoot, 'package.json'), 'utf8'));

const ENTRY = './agent-audit/deep-contract';

/** Every specifier this file imports **as a value**, off the TypeScript AST. */
function valueSpecifiersIn(file, source) {
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

test('the deep-contract entry is published', () => {
  assert.ok(stewardPackage.exports[ENTRY], `${ENTRY} is missing from the exports map`);
});

test('the deep-contract entry imports nothing at runtime', () => {
  const entry = path.join(stewardRoot, stewardPackage.exports[ENTRY].default);
  const specifiers = valueSpecifiersIn(entry, readFileSync(entry, 'utf8'));
  assert.deepEqual(
    specifiers,
    [],
    'the deep-contract entry must publish names and types only. A value import here is a module ' +
      "graph the site's function bundle inherits, and the argument for this second exports entry " +
      'is that it inherits none.',
  );
});

test('the entry carries the names the /mcp function starts a workflow with', async () => {
  // Imported for real rather than pattern-matched: the failure this guards is the site holding a
  // stale copy of one of these strings, and a test that only checked they exist would pass on a
  // renamed queue.
  const contract = await import('@mattpyle/steward/agent-audit/deep-contract');
  assert.equal(contract.AUDIT_WORKFLOW_TYPE, 'auditSiteWorkflow');
  assert.equal(contract.AUDIT_TASK_QUEUE, 'steward-audit');
  assert.equal(contract.AUDIT_STATE_QUERY, 'getAuditState');
  assert.equal(typeof contract.DEEP_BUDGET_SECONDS, 'number');
  assert.equal(
    contract.auditWorkflowIdFor('https://example.com', 'deep', '1a2b3c4d'),
    'steward-audit-example.com-deep-1a2b3c4d',
  );
});

test('the entry carries the names the fast tool starts a standalone activity with', async () => {
  // Same argument as the test above, applied to the second consumer of this entry: the /mcp
  // function starts `auditSiteFast` directly, so it needs the activity type, the queue and the ID
  // scheme. A stale copy of any of the three on the site is a start nobody serves, which fails as
  // a silent fallback into the function rather than as an error anybody would see.
  const contract = await import('@mattpyle/steward/agent-audit/deep-contract');
  assert.equal(contract.AUDIT_FAST_ACTIVITY_TYPE, 'auditSiteFast');
  assert.equal(contract.AUDIT_FAST_TASK_QUEUE, 'steward-audit-fast');
  assert.equal(
    contract.fastAuditActivityIdFor('https://example.com', new Date('2026-09-04T17:42:11.000Z')),
    'audit:https://example.com:2026-09-04T17',
  );
});

test('the fast activity ID buckets by the UTC hour, not by the local one', async () => {
  // The bucket is a machine key, and a local-time one would repeat an hour and skip an hour twice
  // a year — two callers inside one "hour" that Temporal would see as two different IDs.
  const contract = await import('@mattpyle/steward/agent-audit/deep-contract');
  const early = contract.fastAuditActivityIdFor('https://example.com', new Date('2026-09-04T17:00:00.000Z'));
  const late = contract.fastAuditActivityIdFor('https://example.com', new Date('2026-09-04T17:59:59.999Z'));
  const next = contract.fastAuditActivityIdFor('https://example.com', new Date('2026-09-04T18:00:00.000Z'));
  assert.equal(early, late, 'anything inside one UTC hour is one audit');
  assert.notEqual(late, next, 'the next hour is a new audit');
});
