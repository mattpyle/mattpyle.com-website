import assert from 'node:assert/strict';
import test from 'node:test';
import { articlePrompt, chatGptUrl, claudeUrl } from '../src/lib/article-actions.mjs';

const canonicalUrl = 'https://www.mattpyle.com/writing/i-turned-on-a-screen-reader/';
const expectedPrompt = `Read from ${canonicalUrl} so I can ask questions about its contents`;

test('articlePrompt uses the approved sentence and canonical URL', () => {
  assert.equal(articlePrompt(canonicalUrl), expectedPrompt);
});

test('chatGptUrl uses the search hint and one encoded prompt', () => {
  const url = new URL(chatGptUrl(canonicalUrl));

  assert.equal(url.origin, 'https://chatgpt.com');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('hint'), 'search');
  assert.equal(url.searchParams.get('q'), expectedPrompt);
  assert.deepEqual([...url.searchParams.keys()], ['hint', 'q']);
});

test('claudeUrl opens a new chat with one encoded prompt', () => {
  const url = new URL(claudeUrl(canonicalUrl));

  assert.equal(url.origin, 'https://claude.ai');
  assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('q'), expectedPrompt);
  assert.deepEqual([...url.searchParams.keys()], ['q']);
});

test('provider URLs round-trip canonical URL special characters', () => {
  const specialCanonicalUrl = 'https://www.mattpyle.com/writing/agents-and-a11y/?edition=one&source=site';
  const specialPrompt = articlePrompt(specialCanonicalUrl);

  assert.equal(new URL(chatGptUrl(specialCanonicalUrl)).searchParams.get('q'), specialPrompt);
  assert.equal(new URL(claudeUrl(specialCanonicalUrl)).searchParams.get('q'), specialPrompt);
});
