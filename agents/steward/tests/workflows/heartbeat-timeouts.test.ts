import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every activity that drives a browser must carry a `heartbeatTimeout`, not
 * only heartbeats.
 *
 * **A heartbeat without a timeout detects nothing.** The activity dutifully
 * beats every five seconds and the server, told no deadline, discards every one
 * of them; a wedged Chrome then sits until the `startToCloseTimeout` — five
 * minutes for a page, fifteen for a draft build — with the run looking healthy
 * throughout. That is the same success-shaped failure the alerting card exists
 * for, one level down, and it is invisible in review because the heartbeat calls
 * are right there in the activity.
 *
 * A source-level check rather than a behavioural one because the pairing is a
 * property of the stub declaration, and there is no runtime surface that reports
 * "this proxy has no heartbeat timeout" — the wrong version simply works, until
 * something hangs.
 */

const BROWSER_ACTIVITIES = [
  ['../../src/workflows/audit-site.ts', 'auditRenderedPage'],
  ['../../src/workflows/audit-site.ts', 'auditSiteFetchChecks'],
  ['../../src/workflows/audit-site.ts', 'auditSiteFast'],
  ['../../src/workflows/scorecard-audit.ts', 'auditLiveUrl'],
  ['../../src/workflows/review-post.ts', 'buildAndAuditDraft'],
] as const;

/**
 * Every `wf.proxyActivities<…>(…)` call in a file, as the source text of its
 * options — following a named constant (`HEAVY_ACTIVITY_OPTIONS`) to its
 * definition, since one stub declares its options that way.
 */
function proxyBlocks(source: string): string[] {
  return source
    .split('wf.proxyActivities')
    .slice(1)
    .map((chunk) => {
      // The call ends at whichever closer comes first: `})` for an inline
      // object literal, `)` for a bare identifier argument.
      const end = Math.min(...[chunk.indexOf('})'), chunk.indexOf(');')].filter((i) => i >= 0));
      const block = Number.isFinite(end) ? chunk.slice(0, end) : chunk;
      const named = block.match(/\(\s*([A-Z][A-Z0-9_]*)\s*,?\s*$/);
      if (!named) return block;
      const defined = source.match(new RegExp(`${named[1]}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`));
      // The type argument stays attached so the caller can still tell which
      // activity this stub is for.
      return defined ? `${block}\n${defined[1]}` : block;
    });
}

for (const [relPath, activity] of BROWSER_ACTIVITIES) {
  test(`${activity}'s stub sets a heartbeatTimeout`, () => {
    const source = fs.readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
    const blocks = proxyBlocks(source).filter((b) => b.includes(`'${activity}'`));
    assert.equal(blocks.length, 1, `expected exactly one stub naming ${activity} in ${relPath}`);
    assert.match(
      blocks[0],
      /heartbeatTimeout:/,
      `${activity} runs a browser and heartbeats; without a heartbeatTimeout on its stub, nothing acts on those heartbeats`,
    );
  });
}

test('the publish stubs deliberately have no heartbeatTimeout', () => {
  // The inverse case, asserted so the rule above is not read as "every stub".
  // A publish waits on the worktree lock for as long as a build holds it
  // (spec §7.4, amendment 12); a heartbeat timeout there would turn a healthy
  // wait into a wedged-activity signal.
  const source = fs.readFileSync(
    fileURLToPath(new URL('../../src/workflows/review-post.ts', import.meta.url)),
    'utf8',
  );
  const publish = proxyBlocks(source).filter((b) => b.includes("'publishPost'"));
  assert.equal(publish.length, 1);
  assert.doesNotMatch(publish[0], /heartbeatTimeout:/);
});
