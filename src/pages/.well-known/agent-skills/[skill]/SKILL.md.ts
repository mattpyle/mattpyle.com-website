import type { APIRoute, GetStaticPaths } from 'astro';
import { normaliseSkillBody, parseSkillFrontmatter } from '../../../../lib/agent-skills.mjs';

/**
 * The skill artifacts themselves, one prerendered SKILL.md per file in src/data/skills/.
 *
 * Dynamic rather than one route per skill so publishing a second skill stays a one-file change:
 * drop the markdown in src/data/skills/ and its URL, its index entry, and its digest all follow.
 * The URL shape is the RFC's convention for `type: "skill-md"`,
 * /.well-known/agent-skills/{name}/SKILL.md.
 *
 * ## Why a Vite glob and not readSkills()
 *
 * readSkills() reads the directory with node:fs off `import.meta.url`, which is correct in the
 * generator and the validator and wrong here: Astro bundles this route into dist/server/.prerender
 * before running getStaticPaths, so `import.meta.url` points at the emitted chunk and the scandir
 * fails outright. import.meta.glob is resolved by Vite at build time against the source tree, so
 * the file contents are compiled in and there is no runtime directory to find.
 *
 * That leaves two code paths reading the same files, which is a drift risk, so it is closed
 * downstream rather than upstream: both funnel through normaliseSkillBody, and
 * scripts/validate-agent-skills-index.mjs re-hashes the *built* artifact and fails the build
 * unless it equals the digest the generator put in the index. The guarantee is about the bytes
 * that deploy, not about which function produced them, which is the stronger of the two anyway.
 *
 * Content-Type note, same as the sibling index route: a prerendered route becomes a static file
 * and the platform serves it by extension, so vercel.json pins `text/markdown; charset=utf-8` on
 * this path for the deployed answer. The RFC allows text/markdown or text/plain; markdown is the
 * more useful of the two and matches what every other markdown surface on this site returns.
 */

const sources = import.meta.glob('../../../../data/skills/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const getStaticPaths: GetStaticPaths = () =>
  Object.entries(sources)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, source]) => {
      const file = path.slice(path.lastIndexOf('/') + 1);
      const body = normaliseSkillBody(source);
      // The frontmatter name has to match the filename, and readSkills() enforces that for the
      // index. Re-checked here because this is the path that decides the URL: without it, a
      // rename could serve an artifact whose own frontmatter disagrees with the URL it arrived at.
      const { name } = parseSkillFrontmatter(body, `src/data/skills/${file}`);
      const slug = file.slice(0, -'.md'.length);
      if (name !== slug) {
        throw new Error(`src/data/skills/${file}: frontmatter name "${name}" does not match the filename "${slug}"`);
      }
      return { params: { skill: slug }, props: { body } };
    });

export const GET: APIRoute = ({ props }) =>
  new Response(props.body as string, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
