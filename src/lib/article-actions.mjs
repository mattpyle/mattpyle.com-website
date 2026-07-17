/**
 * @param {string} canonicalUrl
 * @returns {string}
 */
export function articlePrompt(canonicalUrl) {
  return `Read from ${canonicalUrl} so I can ask questions about its contents`;
}

/**
 * @param {string} canonicalUrl
 * @returns {string}
 */
export function chatGptUrl(canonicalUrl) {
  const url = new URL('https://chatgpt.com/');
  url.searchParams.set('hint', 'search');
  url.searchParams.set('q', articlePrompt(canonicalUrl));
  return url.toString();
}

/**
 * @param {string} canonicalUrl
 * @returns {string}
 */
export function claudeUrl(canonicalUrl) {
  const url = new URL('https://claude.ai/new');
  url.searchParams.set('q', articlePrompt(canonicalUrl));
  return url.toString();
}
