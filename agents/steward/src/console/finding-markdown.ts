import { Marked, type Tokens } from 'marked';
import { escapeHtml } from '../lib/html.js';

/**
 * A finding's markdown as HTML the console client can place with `innerHTML`.
 *
 * Argus writes the files and the evidence in them comes from pages it visited,
 * so the text is not trusted. Raw HTML in the markdown is escaped to text,
 * never passed through; a link keeps only an http, https or mailto target and
 * opens in a new tab; an image becomes a link to its source. Nothing here
 * emits a script, a style or an event attribute.
 */

/** The target when it is safe to link, else null. A relative path is not linkable from a loopback page. */
function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? escapeHtml(trimmed) : null;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    link(this: any, token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image(token: Tokens.Image) {
      const href = safeHref(token.href);
      const label = escapeHtml(token.text || token.href);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
  },
});

export function renderFindingMarkdown(markdown: string): string {
  return (marked.parse(markdown, { async: false }) as string).trim();
}

export interface FindingSection {
  /** The H2 heading's text. */
  heading: string;
  html: string;
}

/**
 * The body below the H1 as one HTML string, and the H2 sections in file order,
 * each rendered alone. Text between the H1 and the first H2 belongs to no
 * section. A heading inside a fenced code block does not start a section.
 */
export function renderFindingBody(body: string): { body: string; sections: FindingSection[] } {
  const lines = body.split(/\r?\n/);
  const sections: { heading: string; lines: string[] }[] = [];
  const intro: string[] = [];
  let fence: string | null = null;
  let current: { heading: string; lines: string[] } | null = null;
  let seenTitle = false;
  for (const line of lines) {
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark) {
      if (fence === null) fence = fenceMark[0];
      else if (fenceMark[0] === fence) fence = null;
    }
    if (fence === null) {
      if (!seenTitle && /^#\s+/.test(line)) {
        seenTitle = true;
        continue;
      }
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (h2) {
        current = { heading: h2[1], lines: [] };
        sections.push(current);
        continue;
      }
    }
    (current ? current.lines : intro).push(line);
  }
  const introHtml = renderFindingMarkdown(intro.join('\n'));
  const rendered = sections.map((s) => ({ heading: s.heading, html: renderFindingMarkdown(s.lines.join('\n')) }));
  const all = [introHtml, ...rendered.map((s) => `<h2>${escapeHtml(s.heading)}</h2>\n${s.html}`)].filter(Boolean);
  return { body: all.join('\n'), sections: rendered };
}
