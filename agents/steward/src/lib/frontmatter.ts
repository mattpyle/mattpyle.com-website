import matter from 'gray-matter';

/**
 * The one place Steward parses frontmatter, with gray-matter's `javascript` engine removed.
 *
 * That engine is `eval` (`node_modules/gray-matter/lib/engines.js`), and a block opened with
 * `---js` or `---javascript` reaches it: `lib/engine.js` aliases both names to the same engine,
 * so replacing the single `javascript` key closes both delimiters. `lib/defaults.js` merges
 * caller engines over the defaults, which is what makes the override take.
 *
 * Unreachable today, because every post Steward parses is one Matt wrote. It stops being
 * unreachable the moment a contributed draft, an unattended agent authoring posts, or a CI job
 * running Steward against pull-request content appears, and any of those is a plausible next
 * experiment on this site. Steward only ever parses YAML frontmatter, so the capability is
 * removed rather than left lying around for that day.
 *
 * Every call site goes through here rather than calling `matter` directly. That is the fix: the
 * version that only patches today's seven call sites is the version that regresses on the eighth.
 */
const ENGINES = {
  javascript: {
    parse: (): never => {
      throw new Error('javascript frontmatter is not supported');
    },
  },
};

export function parseFrontmatter(raw: string) {
  return matter(raw, { engines: ENGINES });
}
