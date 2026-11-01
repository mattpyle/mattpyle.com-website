import { escapeHtml } from '../lib/html.js';

/**
 * The console's one server-rendered page: a refusal or an error. It uses the
 * findings page's stylesheet and carries no script. Every value is escaped.
 */

/** A page with a heading, paragraphs of already-escaped HTML, and the way back. */
export function renderMessagePage(title: string, paragraphs: string[]): string {
  return [
    '<!doctype html>',
    '<html lang="en-GB">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · Steward</title>`,
    '<link rel="icon" href="/icons/steward-console.svg" type="image/svg+xml">',
    '<link rel="stylesheet" href="/findings.css">',
    '</head>',
    '<body>',
    '<main class="message">',
    `<h1>${escapeHtml(title)}</h1>`,
    ...paragraphs.map((p) => `<p>${p}</p>`),
    '<p><a href="/findings">Back to findings</a></p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** A refusal or failure in one sentence. */
export function renderMessage(title: string, message: string): string {
  return renderMessagePage(title, [escapeHtml(message)]);
}
