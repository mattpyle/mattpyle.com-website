import assert from 'node:assert/strict';
import test from 'node:test';
import { builtPages, canon, read } from './helpers/built-pages.mjs';
import { sitePages, siteSections } from '../src/data/site-sections.mjs';

/**
 * Change kind "a new page": a page the site builds has to be on every surface that lists pages,
 * or the build fails with the page and the surface named. See CHANGE-KINDS.md.
 *
 * The built pages come from the .astro files under src/pages (staticPagePaths), so no build is
 * needed and a new file there is seen at once. The surfaces:
 *
 *   registry   src/data/site-sections.mjs   siteSections() and sitePages()
 *   llms.txt   src/pages/llms.txt.ts        the "## Pages" list, read from the source: the endpoint
 *              imports astro:content and cannot be loaded outside a build. This misses a page
 *              named there only by a computed URL other than FIX_LOG.path.
 *   agents.md  public/agents.md             the bullets under "## Content structure"
 *
 * llms.txt and agents.md stay hand-written prose; this checks them and writes nothing.
 */

/**
 * Pages left out of a surface on purpose. Each needs a reason; an empty one fails below.
 * @type {Record<string, string>}
 */
const EXEMPT = {
  // The error page is served for URLs that do not exist. It is not a destination to list.
  '/404': 'the error page, not a destination',
};

/** @param {string} source the text of src/pages/llms.txt.ts */
export function llmsPages(source) {
  const start = source.indexOf("lines.push('## Pages');");
  const end = source.indexOf("lines.push('## ", start + 1);
  assert.ok(start !== -1 && end !== -1, 'src/pages/llms.txt.ts has a "## Pages" section');
  const fixLogPath = /path:\s*'([^']+)'/.exec(read('src/lib/fix-log-name.ts'))?.[1];
  assert.ok(fixLogPath, 'src/lib/fix-log-name.ts names the fix log path');
  const section = source.slice(start, end).replaceAll('${FIX_LOG.path}', fixLogPath);
  return new Set([...section.matchAll(/\]\(\$\{base\}(\/[^)\s]*)\)/g)].map((match) => canon(match[1])));
}

/** @param {string} markdown the text of public/agents.md */
export function agentsPages(markdown) {
  const start = markdown.indexOf('## Content structure');
  const end = markdown.indexOf('\n## ', start + 1);
  assert.ok(start !== -1 && end !== -1, 'public/agents.md has a "## Content structure" section');
  return new Set(
    [...markdown.slice(start, end).matchAll(/^- `(\/[^`<]*)`/gm)].map((match) => canon(match[1]))
  );
}

/**
 * Every way the surfaces disagree, as one sentence each naming the page and the surface.
 * @param {{built: Set<string>, registry: Set<string>, llms: Set<string>, agents: Set<string>, exempt?: Record<string, string>}} input
 */
export function surfaceProblems({ built, registry, llms, agents, exempt = EXEMPT }) {
  const problems = [];
  for (const page of [...built].sort()) {
    if (page in exempt) continue;
    if (!registry.has(page)) problems.push(`${page} is built but missing from the section registry (src/data/site-sections.mjs)`);
  }
  for (const page of [...registry].sort()) {
    if (!llms.has(page)) problems.push(`${page} is in the section registry but missing from llms.txt (src/pages/llms.txt.ts)`);
    if (!agents.has(page)) problems.push(`${page} is in the section registry but missing from agents.md (public/agents.md, Content structure)`);
  }
  return problems;
}

const registry = new Set([...siteSections('').map((s) => s.url), ...sitePages('').map((s) => s.url)].map(canon));

test('every built page is on the registry, llms.txt and agents.md', () => {
  const problems = surfaceProblems({
    built: builtPages(),
    registry,
    llms: llmsPages(read('src/pages/llms.txt.ts')),
    agents: agentsPages(read('public/agents.md')),
  });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('every exemption has a reason and names a page that is built', () => {
  const built = builtPages();
  for (const [page, reason] of Object.entries(EXEMPT)) {
    assert.ok(reason.trim().length > 0, `${page} is exempt with no reason`);
    assert.ok(built.has(page), `${page} is exempt but is not a built page; remove the exemption`);
  }
});

test('the check names the page and the surface when one is missing', () => {
  const base = { built: new Set(['/', '/new']), registry: new Set(['/', '/new']), llms: new Set(['/', '/new']), agents: new Set(['/', '/new']) };
  assert.deepEqual(surfaceProblems(base), []);
  assert.match(surfaceProblems({ ...base, registry: new Set(['/']) }).join('\n'), /\/new is built but missing from the section registry/);
  assert.match(surfaceProblems({ ...base, llms: new Set(['/']) }).join('\n'), /\/new .* missing from llms\.txt/);
  assert.match(surfaceProblems({ ...base, agents: new Set(['/']) }).join('\n'), /\/new .* missing from agents\.md/);
  assert.deepEqual(surfaceProblems({ ...base, registry: new Set(['/']), exempt: { '/new': 'test' } }), []);
});
