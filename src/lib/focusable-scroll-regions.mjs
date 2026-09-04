/**
 * Make every prose block that can scroll sideways reachable by keyboard.
 *
 * `.prose pre` and the wrapper this puts around every `.prose table` are both
 * `overflow-x: auto` (src/styles/global.css): a long code line or a wide table scrolls
 * inside its own box rather than widening the page, which is what WCAG 1.4.10 asks for and
 * what the suite's reflow rows enforce. The cost is WCAG 2.1.1: a scroll container with
 * nothing focusable in it can be scrolled by a mouse or a touch drag and by nothing else.
 * axe calls it `scrollable-region-focusable` and rates it serious, and it is what blocked
 * Steward's review gate on the WebMCP how-to.
 *
 * `tabindex="0"` on EVERY code block and table wrapper, not only the ones that overflow.
 * Overflow is a viewport fact — the same block scrolls at 320px and does not at 1280 — and
 * the build renders one document for every width. A static attribute is also what Astro's
 * own Shiki output and rehype-pretty-code emit for the same reason. The cost is one extra
 * tab stop per block on a page; that is the trade, taken deliberately.
 *
 * A TABLE GETS A WRAPPER, a code block does not. `overflow-x: auto` directly on a `table`
 * needs `display: block` to take effect, and a block-displayed table is no longer a table
 * for layout: its columns lose their shared widths, which is what squeezed the WebMCP
 * how-to's Returns column to three characters a line at 320px. The wrapper scrolls and the
 * table inside it stays a table. `tabindex` moves with the scrolling: it belongs on the
 * element that actually scrolls, so a keyboard user reaching it can move the content.
 *
 * No `role="region"` and no accessible name here. Those belong to the hand-written page
 * snippets that sit under a heading they can be labelled from (see
 * src/components/steward/StewardBody.astro); a prose block has no such name to give, and
 * a region with no name is worse than no region. The focus ring is already site-wide: the
 * `[tabindex]:focus-visible` rules in global.css and retro.css cover a focused `pre` or
 * table wrapper in both appearances without a rule of their own.
 *
 * Build-time, in the markdown pipeline, because the site ships no client-side JavaScript
 * for anything a static attribute can do. The two agent routes that emit `article.body`
 * (src/pages/writing/[slug].md.ts, src/pages/llms-full.txt.ts) need no counterpart: they
 * emit fenced code as fenced code and a table as a pipe table, and markdown has no
 * attributes to carry.
 */

/**
 * The Sätteri mdast plugin. A `code` node renders as `<pre><code>` and `hProperties` set
 * on it land on the `<pre>`, which is the element that scrolls. A `table` node is wrapped
 * instead: `ctx.wrapNode` makes it the only child of a node whose `hName` renders the
 * wrapper element, and the wrapper takes the scrolling and the tab stop.
 *
 * Typed against Sätteri's own definition, and type-only, matching video-embed.mjs: this
 * module is imported by astro.config.mjs, and a value import of `satteri` would pull its
 * native binding into anything that shares the graph.
 *
 * @type {import('satteri').MdastPluginDefinition}
 */
export const focusableScrollRegionsMdastPlugin = {
  name: 'focusable-scroll-regions',
  code(node, ctx) {
    ctx.setProperty(node, 'data', { hProperties: { tabindex: '0' } });
  },
  table(node, ctx) {
    ctx.wrapNode(node, {
      type: 'paragraph',
      data: { hName: 'div', hProperties: { class: 'prose-scroll', tabindex: '0' } },
      children: [],
    });
  },
};
