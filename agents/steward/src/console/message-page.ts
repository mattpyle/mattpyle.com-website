import type { FindingVerdictResult } from '../lib/finding-verdict.js';

/**
 * The console's one server-rendered page: a refusal, an error, or the answer to
 * a verdict posted from a browser with scripts off. It uses the findings page's
 * stylesheet and carries no script. Every value is escaped.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

/** The verdict's answer, as `steward finding approve|reject` prints it. */
export function renderVerdictMessage(result: FindingVerdictResult, key: string): string {
  const lines = [
    `<strong>${escapeHtml(result.sent.status)}</strong> signal sent to <code>${escapeHtml(result.workflowId)}</code>`,
    `verdict: ${escapeHtml(result.recorded.status)} (source ${escapeHtml(result.recorded.source)})`,
  ];
  if (result.recorded.source !== 'cli') lines.push('An earlier verdict from the file was recorded first, so nothing was written.');
  lines.push(`commit: <code>${escapeHtml(result.commitSha ?? 'none (the file already carried this verdict)')}</code>`);
  if (result.nextStepError) {
    lines.push(
      `auto_fix unread (${escapeHtml(result.nextStepError.message)}): <code>steward finding status ${escapeHtml(key)}</code> shows the next step.`,
    );
  }
  if (result.nextStep) lines.push(escapeHtml(result.nextStep));
  if (/^https:\/\//.test(result.webUrl)) lines.push(`<a href="${escapeHtml(result.webUrl)}">${escapeHtml(result.webUrl)}</a>`);
  return renderMessagePage('Verdict', lines);
}
