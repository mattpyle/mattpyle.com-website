/**
 * Renders the operator doc units in `steward/docs/` as one self-contained HTML
 * file at `steward/docs.html`, the surface `steward/quickref.html` used to be.
 *
 * Three rules shape the code:
 *
 * 1. **Self-contained.** The output makes zero network requests: CSS and JS are
 *    inline, there are no webfonts and no images. It has to open from `file://`
 *    on a laptop with no server and no connection.
 * 2. **Deterministic.** Same units in, byte-identical file out. Nothing here
 *    reads the clock, the environment, or the filesystem's ordering: the unit
 *    order comes from the index, and the freshness date in the footer is the
 *    newest `updated` across the units, not the build time.
 * 3. **CLI-side only.** Nothing in this module may be reached from a workflow or
 *    from either published exports entry (see the workspace's package.json).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { Marked, type RendererObject, type Tokens } from 'marked';
import { REPO_ROOT } from '../config.js';

/**
 * Anchored on `REPO_ROOT`, never `SITE_DIR`: the units are Steward's own
 * artifacts, and a redirected content tree must not move them (config.ts).
 */
export const DOCS_DIR = path.join(REPO_ROOT, 'steward', 'docs');
export const DOCS_HTML_PATH = path.join(REPO_ROOT, 'steward', 'docs.html');

/** Files in `steward/docs/` that are not units. */
const NON_UNIT_FILES = new Set(['README.md', '_inventory.md']);

/** Thrown with the offending file named, so a parse failure says which one. */
export class DocsUnitError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'DocsUnitError';
  }
}

export interface DocUnit {
  slug: string;
  title: string;
  task: string;
  commands: string[];
  updated: string;
  /** The index's question for this unit; empty when the index does not list it. */
  question: string;
  group: string;
  /** The unit's markdown, minus its leading `# h1` (the section header shows the title). */
  body: string;
  html: string;
  /** Lowercased plain text, what the client-side search matches against. */
  searchText: string;
}

export interface DocGroup {
  name: string;
  slugs: string[];
}

export interface DocsViewerResult {
  outPath: string;
  html: string;
  units: DocUnit[];
  groups: DocGroup[];
  /** Non-fatal notes: a unit the index does not list, and the like. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * YAML turns an unquoted `2026-08-16` into a Date at UTC midnight, so read the
 * date back in UTC. Taking the local calendar day here would move the shown date
 * by one for anyone west of Greenwich, and would make the output depend on the
 * machine's timezone, which rule 2 forbids.
 */
function isoDate(value: unknown, file: string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    return value.trim().slice(0, 10);
  }
  throw new DocsUnitError(
    file,
    `frontmatter "updated" must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`,
  );
}

function requireString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DocsUnitError(file, `frontmatter "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function readCommands(value: unknown, file: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new DocsUnitError(file, 'frontmatter "commands" must be a list');
  }
  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new DocsUnitError(
        file,
        `frontmatter "commands" holds a non-string entry: ${JSON.stringify(entry)}`,
      );
    }
    return entry.trim();
  });
}

/** Drops the unit's own `# h1`; the rendered section header carries the title. */
function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]*\n?/, '').replace(/^\s+/, '');
}

/**
 * What the search matches: the markdown with its scaffolding removed. Link
 * targets go and link text stays, so a unit that merely *links* to
 * `reject-a-review.md` does not answer a search for "reject".
 */
function toSearchText(markdown: string): string {
  return markdown
    .replace(/```[a-z]*/gi, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[|#*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * One slugifier for both sides of an in-page link: the id a body heading takes,
 * and the fragment a `unit.md#some-heading` link carries. They have to agree or
 * the link lands nowhere.
 */
function slugifyAnchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function headingId(unitSlug: string, text: string): string {
  const anchor = slugifyAnchor(text);
  return anchor ? `${unitSlug}--${anchor}` : unitSlug;
}

/**
 * Rewrites a link from a unit into something the flat file can follow.
 *
 * Every inter-unit link becomes an in-page anchor. A link to a markdown file
 * that is not a unit stays a file link, resolved relative to `steward/docs.html`
 * rather than to the units' own directory.
 */
function resolveHref(href: string, unitSlugs: ReadonlySet<string>): string {
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  const [target = '', fragment] = href.split('#', 2);
  if (!target.endsWith('.md')) return href;
  const base = path.posix.basename(target).replace(/\.md$/, '');

  // A link into another unit becomes an anchor, keeping its heading fragment:
  // body heading ids are `${slug}--${anchor}`, so the two halves join here.
  if (unitSlugs.has(base)) {
    const anchor = fragment ? slugifyAnchor(fragment) : '';
    return anchor ? `#${base}--${anchor}` : `#${base}`;
  }
  if (base === 'README') return '#index';

  // Anything else stays a file link, and the two directories differ: the unit
  // wrote the path relative to `steward/docs/`, and the page that follows it
  // sits in `steward/`. Resolve against the first, re-relativise against the
  // second, so `../steward-spec.md` becomes `steward-spec.md` while
  // `_inventory.md` becomes `docs/_inventory.md`.
  const resolved = path.posix.normalize(path.posix.join('docs', target));
  return `${resolved}${fragment ? `#${fragment}` : ''}`;
}

function renderMarkdown(markdown: string, unitSlug: string, unitSlugs: ReadonlySet<string>): string {
  const renderer: RendererObject = {
    heading(token: Tokens.Heading) {
      // A unit's body starts at `##`, and the section header above it is an
      // `<h2>`, so every body heading drops one level to keep the outline sane.
      const level = Math.min(token.depth + 1, 6);
      const id = headingId(unitSlug, token.text);
      const inner = this.parser.parseInline(token.tokens);
      return `<h${level} id="${escapeHtml(id)}">${inner}</h${level}>\n`;
    },
    link(token: Tokens.Link) {
      const href = resolveHref(token.href, unitSlugs);
      const inner = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      if (/^https?:/i.test(href)) {
        return `<a href="${escapeHtml(href)}"${title} rel="noopener noreferrer" target="_blank">${inner}</a>`;
      }
      // `mailto:` is neither an anchor nor a file, so it takes neither class.
      if (/^mailto:/i.test(href)) {
        return `<a href="${escapeHtml(href)}"${title}>${inner}</a>`;
      }
      const cls = href.startsWith('#') ? 'unit-link' : 'file-link';
      return `<a class="${cls}" href="${escapeHtml(href)}"${title}>${inner}</a>`;
    },
    code(token: Tokens.Code) {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? '';
      const label = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '';
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<div class="codeblock">${label}<pre><code${cls}>${escapeHtml(token.text)}\n</code></pre></div>\n`;
    },
  };

  const md = new Marked({ gfm: true, breaks: false });
  md.use({ renderer });
  const html = md.parse(markdown, { async: false });
  // Tables are the unit format's workhorse and the longest rows overflow a
  // narrow window; give each one its own scroll container.
  return html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

/**
 * Reads the index's grouping: one group per `##` heading, the units in the order
 * its table lists them, with the question column kept as each unit's subtitle.
 * Sections whose tables link no unit (the other-documents table, Conventions)
 * fall out on their own.
 */
export function parseIndex(markdown: string): {
  groups: DocGroup[];
  questions: Map<string, string>;
} {
  const groups: DocGroup[] = [];
  const questions = new Map<string, string>();
  let current: DocGroup | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      current = { name: heading[1], slugs: [] };
      groups.push(current);
      continue;
    }
    const row = /^\|\s*(.+?)\s*\|\s*\[[^\]]+\]\(([a-z0-9-]+)\.md\)\s*\|\s*$/.exec(line);
    if (row && current) {
      const [, question = '', slug = ''] = row;
      if (!current.slugs.includes(slug)) current.slugs.push(slug);
      questions.set(slug, question);
    }
  }

  return { groups: groups.filter((group) => group.slugs.length > 0), questions };
}

/** Reads and frontmatter-parses every unit file, unordered and unrendered. */
async function readUnits(
  docsDir: string,
): Promise<Map<string, { data: Record<string, unknown>; body: string }>> {
  const entries = await fs.readdir(docsDir);
  const files = entries.filter((name) => name.endsWith('.md') && !NON_UNIT_FILES.has(name)).sort();
  const units = new Map<string, { data: Record<string, unknown>; body: string }>();

  for (const file of files) {
    const raw = await fs.readFile(path.join(docsDir, file), 'utf8');
    let parsed;
    try {
      parsed = matter(raw);
    } catch (err) {
      throw new DocsUnitError(
        file,
        `frontmatter did not parse — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    units.set(file.replace(/\.md$/, ''), {
      data: parsed.data as Record<string, unknown>,
      body: parsed.content,
    });
  }

  return units;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export async function collectUnits(docsDir: string = DOCS_DIR): Promise<{
  units: DocUnit[];
  groups: DocGroup[];
  intro: string;
  warnings: string[];
}> {
  const indexRaw = await fs.readFile(path.join(docsDir, 'README.md'), 'utf8');
  const indexParsed = matter(indexRaw);
  const { groups, questions } = parseIndex(indexParsed.content);

  const raw = await readUnits(docsDir);
  const unitSlugs = new Set(raw.keys());
  const warnings: string[] = [];

  const missing = groups.flatMap((group) => group.slugs).filter((slug) => !raw.has(slug));
  if (missing.length > 0) {
    throw new DocsUnitError(
      'README.md',
      `the index lists units that do not exist: ${missing.join(', ')}`,
    );
  }

  const listed = new Set(groups.flatMap((group) => group.slugs));
  const unlisted = [...raw.keys()].filter((slug) => !listed.has(slug)).sort();
  const ordered: DocGroup[] =
    unlisted.length > 0 ? [...groups, { name: 'Not in the index', slugs: unlisted }] : groups;
  for (const slug of unlisted) {
    warnings.push(`${slug}.md is not listed in README.md; it renders under "Not in the index".`);
  }

  const units: DocUnit[] = [];
  for (const group of ordered) {
    for (const slug of group.slugs) {
      const entry = raw.get(slug);
      if (!entry) continue;
      const file = `${slug}.md`;
      const title = requireString(entry.data.title, 'title', file);
      const task = requireString(entry.data.task, 'task', file);
      const updated = isoDate(entry.data.updated, file);
      const commands = readCommands(entry.data.commands, file);
      const body = stripLeadingH1(entry.body);
      const question = questions.get(slug) ?? '';

      units.push({
        slug,
        title,
        task,
        commands,
        updated,
        question,
        group: group.name,
        body,
        html: renderMarkdown(body, slug, unitSlugs),
        searchText: toSearchText([title, question, task, commands.join(' '), body].join('\n')),
      });
    }
  }

  const intro =
    indexParsed.content
      .split(/^##\s/m)[0]
      ?.replace(/^\s*#\s+[^\n]*\n?/, '')
      .trim() ?? '';

  return {
    units,
    groups: ordered,
    intro: renderMarkdown(intro, 'index', unitSlugs),
    warnings,
  };
}

function renderNav(groups: DocGroup[], units: DocUnit[]): string {
  const bySlug = new Map(units.map((unit) => [unit.slug, unit]));
  return groups
    .map((group) => {
      const items = group.slugs
        .map((slug) => {
          const unit = bySlug.get(slug);
          if (!unit) return '';
          const label = unit.question || unit.title;
          return `        <li data-slug="${escapeHtml(slug)}"><a href="#${escapeHtml(slug)}">${escapeHtml(label)}</a></li>`;
        })
        .filter(Boolean)
        .join('\n');
      return [
        `      <section class="nav-group" data-group="${escapeHtml(group.name)}">`,
        `        <h2>${escapeHtml(group.name)}</h2>`,
        '        <ul>',
        items,
        '        </ul>',
        '      </section>',
      ].join('\n');
    })
    .join('\n');
}

function renderUnit(unit: DocUnit): string {
  const commands = unit.commands.length
    ? `<span class="cmds">${unit.commands.map((cmd) => `<code>${escapeHtml(cmd)}</code>`).join('')}</span>`
    : '';
  const question = unit.question ? `\n      <p class="question">${escapeHtml(unit.question)}</p>` : '';
  return [
    `    <article class="unit" id="${escapeHtml(unit.slug)}" data-slug="${escapeHtml(unit.slug)}">`,
    '      <div class="unit-head">',
    `        <h2><a href="#${escapeHtml(unit.slug)}">${escapeHtml(unit.title)}</a></h2>`,
    `        <p class="meta"><span class="badge">${escapeHtml(unit.task)}</span>${commands}<span class="updated">updated ${escapeHtml(unit.updated)}</span></p>`,
    '      </div>' + question,
    `      <div class="body">\n${unit.html.trim()}\n      </div>`,
    '    </article>',
  ].join('\n');
}

/**
 * The search index rides in an `application/json` block rather than a JS
 * literal, and every angle bracket and ampersand is escaped, so no unit's prose
 * can close the script element early.
 */
function renderSearchIndex(units: DocUnit[]): string {
  const payload = units.map((unit) => {
    // `head` is the unit's own identity — title, question, task, commands. A
    // query that matches it is answered *by* this unit; a query that only
    // matches `text` may be a passing mention, which is why the two are
    // separate fields and the nav promotes the first kind.
    const head = [unit.title, unit.question, unit.task, unit.commands.join(' ')]
      .join(' ')
      .toLowerCase();
    return {
      slug: unit.slug,
      label: unit.question || unit.title,
      head,
      text: `${head} ${unit.searchText}`,
    };
  });
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

const STYLES = `
  :root {
    --bg: #ffffff; --bg-alt: #f6f7f9; --ink: #1a1d23; --ink-dim: #55606e;
    --border: #dde1e6; --mono-bg: #eef0f3; --card-bg: #ffffff;
    --accent: #2b5fd9; --accent-soft: #eaf0fd;
    --badge-bg: #eef0f3; --badge-ink: #55606e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --bg-alt: #1b1e24; --ink: #e7e9ec; --ink-dim: #a2acb8;
      --border: #2c313a; --mono-bg: #1f232b; --card-bg: #1a1d23;
      --accent: #8fb0ff; --accent-soft: #1b2438;
      --badge-bg: #242932; --badge-ink: #a2acb8;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 16px; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px; line-height: 1.5;
  }
  a { color: var(--accent); }
  code, pre, .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
  code { background: var(--mono-bg); padding: 0.1em 0.4em; border-radius: 4px; font-size: 0.9em; }
  .skip {
    position: absolute; left: -9999px; top: 0; background: var(--bg); color: var(--ink);
    padding: 10px 14px; z-index: 10;
  }
  .skip:focus { left: 8px; top: 8px; border: 2px solid var(--accent); border-radius: 6px; }

  .shell {
    display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 32px;
    max-width: 1240px; margin: 0 auto; padding: 0 24px;
  }
  #nav {
    position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
    padding: 24px 8px 48px 0; border-right: 1px solid var(--border);
  }
  .brand { font-weight: 700; letter-spacing: -0.01em; font-size: 1.05em; }
  .brand span {
    display: block; font-weight: 400; color: var(--ink-dim);
    font-size: 0.85em; letter-spacing: 0.02em;
  }
  .search { position: relative; margin: 14px 0 6px; }
  #q {
    width: 100%; padding: 8px 30px 8px 10px; font: inherit; color: var(--ink);
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 7px;
  }
  #q:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  #clear {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    border: 0; background: none; color: var(--ink-dim); font-size: 1.1em; cursor: pointer;
    padding: 4px 7px; border-radius: 5px; line-height: 1;
  }
  #clear:hover { background: var(--mono-bg); }
  .count { margin: 0 0 18px; font-size: 0.8em; color: var(--ink-dim); min-height: 1.2em; }
  .nav-group h2 {
    font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.09em;
    color: var(--ink-dim); margin: 20px 0 6px;
  }
  .nav-group ul { list-style: none; margin: 0; padding: 0; }
  .nav-group li a {
    display: block; padding: 4px 8px; border-radius: 6px; text-decoration: none;
    color: var(--ink); font-size: 0.87em; border-left: 2px solid transparent;
  }
  .nav-group li a:hover { background: var(--bg-alt); }
  #best h2 { color: var(--accent); }
  #best li a { border-left-color: var(--accent); background: var(--accent-soft); }
  .nav-group li a[aria-current="true"] {
    background: var(--accent-soft); border-left-color: var(--accent); color: var(--accent);
  }

  main { padding: 28px 0 96px; min-width: 0; }
  .page-head { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 8px; }
  .page-head h1 { font-size: 1.6em; margin: 0 0 8px; letter-spacing: -0.015em; }
  .page-head p { color: var(--ink-dim); margin: 8px 0; max-width: 68ch; }
  .hint { font-size: 0.85em; }
  kbd {
    font-family: inherit; font-size: 0.85em; border: 1px solid var(--border);
    border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; background: var(--bg-alt);
  }

  .unit { border-bottom: 1px solid var(--border); padding: 30px 0; scroll-margin-top: 16px; }
  .unit:last-of-type { border-bottom: 0; }
  .unit-head h2 { font-size: 1.22em; margin: 0; letter-spacing: -0.01em; }
  .unit-head h2 a { color: var(--ink); text-decoration: none; }
  .unit-head h2 a:hover { color: var(--accent); }
  .question { color: var(--ink-dim); margin: 4px 0 0; font-size: 0.92em; }
  .meta {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    margin: 8px 0 0; font-size: 0.8em;
  }
  .badge {
    background: var(--badge-bg); color: var(--badge-ink); border-radius: 999px;
    padding: 2px 9px; text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.85em;
  }
  .cmds { display: inline-flex; flex-wrap: wrap; gap: 5px; }
  .cmds code { font-size: 0.95em; }
  .updated { color: var(--ink-dim); margin-left: auto; }

  /* Prose keeps a readable measure; tables and code blocks get the full column,
     because a table squeezed to 74ch wraps every cell to two lines. */
  .body h3 { font-size: 1.02em; margin: 26px 0 8px; }
  .body h4 { font-size: 0.95em; margin: 20px 0 6px; color: var(--ink-dim); }
  .body p, .body li { max-width: 74ch; }
  .body ul, .body ol { padding-left: 22px; }
  .body li { margin: 4px 0; }
  .codeblock { margin: 14px 0; }
  .codeblock .lang {
    display: block; text-align: right; font-size: 0.7em; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--ink-dim); margin-bottom: 2px;
  }
  pre {
    background: var(--mono-bg); padding: 12px 14px; border-radius: 8px; overflow-x: auto;
    font-size: 0.86em; line-height: 1.55; margin: 0;
  }
  pre code { background: none; padding: 0; font-size: 1em; }
  .table-wrap { overflow-x: auto; margin: 14px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: var(--bg-alt); font-weight: 600; }
  #empty { color: var(--ink-dim); padding: 40px 0; }
  footer {
    margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--border);
    color: var(--ink-dim); font-size: 0.85em;
  }
  footer p { margin: 6px 0; }

  @media (max-width: 860px) {
    .shell { grid-template-columns: minmax(0, 1fr); gap: 0; padding: 0 16px; }
    #nav {
      position: static; height: auto; border-right: 0;
      border-bottom: 1px solid var(--border); padding: 20px 0;
    }
    .updated { margin-left: 0; }
  }
  @media print {
    #nav, .skip { display: none; }
    .shell { display: block; }
    .unit { break-inside: avoid; }
  }
`;

const SCRIPT = `
(function () {
  var index = JSON.parse(document.getElementById('search-index').textContent);
  var input = document.getElementById('q');
  var clear = document.getElementById('clear');
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var best = document.getElementById('best');
  var bestList = best.querySelector('ul');
  var units = Array.prototype.slice.call(document.querySelectorAll('.unit'));
  var items = Array.prototype.slice.call(document.querySelectorAll('.nav-group[data-group] li'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.nav-group[data-group]'));
  var total = units.length;

  function apply(query) {
    var terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
    var matched = {};
    var hits = 0;
    var top = [];
    index.forEach(function (entry) {
      var ok = terms.every(function (term) { return entry.text.indexOf(term) !== -1; });
      matched[entry.slug] = ok;
      if (ok) hits++;
      if (ok && terms.length && terms.every(function (term) { return entry.head.indexOf(term) !== -1; })) {
        top.push(entry);
      }
    });
    units.forEach(function (unit) { unit.hidden = !matched[unit.dataset.slug]; });
    items.forEach(function (item) { item.hidden = !matched[item.dataset.slug]; });
    groups.forEach(function (group) {
      group.hidden = group.querySelectorAll('li:not([hidden])').length === 0;
    });

    // The units the query is *about* go to the top of the nav; the rest stay in
    // their groups, in the index's order.
    bestList.textContent = '';
    top.slice(0, 6).forEach(function (entry) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + entry.slug;
      a.textContent = entry.label;
      li.appendChild(a);
      bestList.appendChild(li);
    });
    best.hidden = top.length === 0;

    empty.hidden = hits !== 0;
    count.textContent = terms.length === 0
      ? total + ' units'
      : hits + ' of ' + total + ' units match';
  }

  input.addEventListener('input', function () { apply(input.value); });
  clear.addEventListener('click', function () { input.value = ''; apply(''); input.focus(); });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { input.value = ''; apply(''); }
  });
  document.addEventListener('keydown', function (event) {
    var tag = (event.target && event.target.tagName) || '';
    if (event.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });

  // Scroll-spy: mark the nav entry for whichever visible unit is highest up.
  var links = {};
  items.forEach(function (item) { links[item.dataset.slug] = item.querySelector('a'); });
  var onScreen = {};
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        onScreen[entry.target.dataset.slug] = entry.isIntersecting;
      });
      var current = '';
      for (var i = 0; i < units.length; i++) {
        if (!units[i].hidden && onScreen[units[i].dataset.slug]) {
          current = units[i].dataset.slug;
          break;
        }
      }
      units.forEach(function (unit) {
        var link = links[unit.dataset.slug];
        if (!link) return;
        if (unit.dataset.slug === current) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '0px 0px -70% 0px' });
    units.forEach(function (unit) { observer.observe(unit); });
  }

  apply('');
})();
`;

export function buildHtml(input: { units: DocUnit[]; groups: DocGroup[]; intro: string }): string {
  const { units, groups, intro } = input;
  const freshest = units.map((unit) => unit.updated).sort().pop() ?? '';
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Steward operator docs</title>',
    '<meta name="description" content="Every Steward operator question, one section each, searchable. Generated from steward/docs/ by steward docs.">',
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    '<a class="skip" href="#content">Skip to the docs</a>',
    '<div class="shell">',
    '  <aside id="nav">',
    '    <div class="brand">Steward<span>operator docs</span></div>',
    '    <div class="search">',
    `      <input id="q" type="search" placeholder="Search ${units.length} units" aria-label="Search the units" autocomplete="off" spellcheck="false">`,
    '      <button id="clear" type="button" aria-label="Clear the search">&times;</button>',
    '    </div>',
    '    <p class="count" id="count" role="status"></p>',
    '    <nav aria-label="Units">',
    '      <section class="nav-group" id="best" hidden>',
    '        <h2>Best match</h2>',
    '        <ul></ul>',
    '      </section>',
    renderNav(groups, units),
    '    </nav>',
    '  </aside>',
    '  <main id="content">',
    '    <header class="page-head" id="index">',
    '      <h1>Steward operator docs</h1>',
    intro.trim(),
    '      <p class="hint">Every unit is open on this page: search above, or use the browser\'s own find. <kbd>/</kbd> focuses the search and <kbd>Esc</kbd> clears it. Regenerate this file with <code>steward docs</code>.</p>',
    '    </header>',
    '    <p id="empty" hidden>No unit matches that search.</p>',
    units.map(renderUnit).join('\n'),
    '    <footer>',
    `      <p>${units.length} units, newest updated ${escapeHtml(freshest)}. Generated from <code>steward/docs/</code> by <code>steward docs</code>; edit the markdown units, never this file.</p>`,
    '      <p>Deeper: <a class="file-link" href="steward-spec.md">steward-spec.md</a> for the design and the amendment log, <a class="file-link" href="build-log.md">build-log.md</a> for what actually happened, <a class="file-link" href="docs/_inventory.md">docs/_inventory.md</a> for what migrated from where.</p>',
    '    </footer>',
    '  </main>',
    '</div>',
    `<script id="search-index" type="application/json">${renderSearchIndex(units)}</script>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ];
  return lines.join('\n');
}

/** Reads the units and writes `steward/docs.html`. */
export async function generateDocsViewer(
  options: { docsDir?: string; outPath?: string } = {},
): Promise<DocsViewerResult> {
  const docsDir = options.docsDir ?? DOCS_DIR;
  const outPath = options.outPath ?? DOCS_HTML_PATH;
  const { units, groups, intro, warnings } = await collectUnits(docsDir);
  const html = buildHtml({ units, groups, intro });
  await fs.writeFile(outPath, html, 'utf8');
  return { outPath, html, units, groups, warnings };
}
