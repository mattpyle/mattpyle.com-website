import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/dom-stub.mjs';
import { createTools, registerTools, resolveModelContext } from '../src/lib/webmcp-tools.mjs';
import { STORAGE_KEY } from '../src/lib/appearance.mjs';
import { GUESTBOOK_STORAGE_KEY, MESSAGE_MAX, NAME_MAX, SEED_ENTRIES } from '../src/lib/guestbook.mjs';
import { WEB_RING, WEB_RING_NAME } from '../src/lib/web-ring.mjs';

const INDEX = {
  generated: '2026-07-17T00:00:00.000Z',
  site: {
    name: 'Matt Pyle',
    url: 'https://www.mattpyle.com/',
    description: 'Growth marketer and hobbyist builder.',
    person: {
      name: 'Matt Pyle',
      jobTitle: 'Director of Growth',
      worksFor: 'Temporal Technologies',
      url: 'https://www.mattpyle.com/',
      sameAs: ['https://github.com/mattpyle', 'https://linkedin.com/in/matt-pyle'],
    },
    sections: [{ name: 'Writing', url: 'https://www.mattpyle.com/writing', summary: 'All writing.' }],
  },
  writing: [
    {
      title: 'Accessibility, AI, and testing with screen readers',
      slug: 'accessibility-and-ai',
      url: 'https://www.mattpyle.com/writing/accessibility-and-ai',
      date: '2026-07-12T00:00:00.000Z',
      updated: '2026-07-14T00:00:00.000Z',
      tags: ['accessibility', 'agents'],
      description: 'What VoiceOver taught me about the accessibility tree.',
    },
    {
      title: 'Fixture post two',
      slug: 'fixture-post-two',
      url: 'https://www.mattpyle.com/writing/fixture-post-two',
      date: '2026-07-05T00:00:00.000Z',
      tags: ['agents'],
      description: 'Auditing the same page with three different crawlers.',
    },
  ],
  builds: [
    {
      title: 'Scorecard',
      slug: 'scorecard',
      url: 'https://www.mattpyle.com/builds',
      date: '2026-06-01T00:00:00.000Z',
      status: 'live',
      tags: ['astro'],
      description: 'A verified accessibility and performance snapshot.',
      github: 'https://github.com/mattpyle/scorecard',
    },
  ],
  changelog: [
    {
      title: 'Self-hosted fonts, Performance back to 100',
      slug: 'self-hosted-fonts',
      url: 'https://www.mattpyle.com/changelog/self-hosted-fonts',
      date: '2026-07-14T00:00:00.000Z',
      type: 'infra',
      significance: 'major',
      tags: ['performance'],
      description: 'Dropped the render-blocking Google Fonts stylesheet for self-hosted woff2 files.',
    },
  ],
};

const getIndex = async () => INDEX;
const toolsByName = () => Object.fromEntries(createTools(getIndex).map((t) => [t.name, t]));

test('registers the four read tools plus the two write tools', async () => {
  const registered = [];
  const mc = { registerTool: async (tool) => registered.push(tool) };

  await registerTools(mc, getIndex);

  assert.deepEqual(
    registered.map((t) => t.name),
    [
      'describe_site',
      'get_recent_writing',
      'search_content',
      'set_appearance',
      'sign_guestbook',
      'list_related_sites',
    ]
  );
});

test('every tool declares an object inputSchema and an execute handler', () => {
  for (const tool of createTools(getIndex)) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
});

test('the tools that need input declare it required; the ones that do not, do not', () => {
  const tools = toolsByName();

  assert.deepEqual(tools.search_content.inputSchema.required, ['query']);
  assert.deepEqual(tools.set_appearance.inputSchema.required, ['mode']);
  assert.deepEqual(tools.sign_guestbook.inputSchema.required, ['name', 'message']);
  assert.equal(tools.describe_site.inputSchema.required, undefined);
  assert.equal(tools.get_recent_writing.inputSchema.required, undefined);
  assert.equal(tools.list_related_sites.inputSchema.required, undefined);
});

test('describe_site returns the author entity, site, and section map', async () => {
  const result = await toolsByName().describe_site.execute({});

  assert.equal(result.person.name, 'Matt Pyle');
  assert.equal(result.person.jobTitle, 'Director of Growth');
  assert.equal(result.person.worksFor, 'Temporal Technologies');
  assert.deepEqual(result.site, {
    name: 'Matt Pyle',
    url: 'https://www.mattpyle.com/',
    description: 'Growth marketer and hobbyist builder.',
  });
  assert.equal(result.sections[0].name, 'Writing');
});

test('get_recent_writing defaults to 5 posts, newest first', async () => {
  const { posts } = await toolsByName().get_recent_writing.execute({});

  assert.equal(posts.length, 2);
  assert.equal(posts[0].title, 'Accessibility, AI, and testing with screen readers');
  assert.equal(posts[0].updated, '2026-07-14T00:00:00.000Z');
  assert.equal('updated' in posts[1], false);
});

test('get_recent_writing honours limit and clamps it to 1-20', async () => {
  const tool = toolsByName().get_recent_writing;

  assert.equal((await tool.execute({ limit: 1 })).posts.length, 1);
  assert.equal((await tool.execute({ limit: 0 })).posts.length, 1);
  assert.equal((await tool.execute({ limit: 999 })).posts.length, 2);
});

test('get_recent_writing filters by tag, case-insensitively', async () => {
  const tool = toolsByName().get_recent_writing;

  assert.equal((await tool.execute({ tag: 'Accessibility' })).posts.length, 1);
  assert.equal((await tool.execute({ tag: 'agents' })).posts.length, 2);
  assert.deepEqual((await tool.execute({ tag: 'nonexistent' })).posts, []);
});

test('search_content matches title, description, and tags across writing, builds, and changelog', async () => {
  const tool = toolsByName().search_content;

  const byTitle = await tool.execute({ query: 'screen reader' });
  assert.equal(byTitle.results.length, 1);
  assert.equal(byTitle.results[0].type, 'writing');
  assert.equal(byTitle.results[0].url, 'https://www.mattpyle.com/writing/accessibility-and-ai');

  const byTag = await tool.execute({ query: 'astro' });
  assert.equal(byTag.results.length, 1);
  assert.equal(byTag.results[0].type, 'build');
  assert.equal(byTag.results[0].status, 'live');

  const byDescription = await tool.execute({ query: 'crawlers' });
  assert.equal(byDescription.results[0].title, 'Fixture post two');

  // "performance" appears in both the writing description ("performance snapshot" is a
  // build, actually) — assert the changelog entry is found and carries its significance.
  const changelogHit = await tool.execute({ query: 'self-hosted fonts' });
  const clResult = changelogHit.results.find((r) => r.type === 'changelog');
  assert.ok(clResult, 'expected a changelog result for "self-hosted fonts"');
  assert.equal(clResult.url, 'https://www.mattpyle.com/changelog/self-hosted-fonts');
  assert.equal(clResult.significance, 'major');

  assert.deepEqual((await tool.execute({ query: 'nothing matches this' })).results, []);
});

test('search_content still works when the index predates the changelog field', async () => {
  const legacyIndex = { ...INDEX, changelog: undefined };
  const [tool] = createTools(async () => legacyIndex).filter((t) => t.name === 'search_content');
  const { results } = await tool.execute({ query: 'screen reader' });
  assert.equal(results.length, 1);
});

test('search_content ignores a blank query rather than matching everything', async () => {
  assert.deepEqual((await toolsByName().search_content.execute({ query: '   ' })).results, []);
});

test('set_appearance enumerates the allowed modes and switches the appearance', async () => {
  const tool = toolsByName().set_appearance;

  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['modern', 'retro']);

  const result = await tool.execute({ mode: 'retro' });
  assert.equal(result.mode, 'retro');
  assert.match(result.message, /retro/i);
  assert.equal(document.documentElement.dataset.appearance, 'retro');
  assert.equal(localStorage.getItem(STORAGE_KEY), 'retro');
});

test('set_appearance falls back to modern for an invalid mode rather than erroring', async () => {
  const tool = toolsByName().set_appearance;

  const result = await tool.execute({ mode: 'chaos' });
  assert.equal(result.mode, 'modern');
  assert.match(result.message, /modern/i);
  assert.equal(document.documentElement.dataset.appearance, undefined);
});

test('sign_guestbook writes an agent-provenance entry and names its number', async () => {
  localStorage.removeItem(GUESTBOOK_STORAGE_KEY);
  const tool = toolsByName().sign_guestbook;

  const result = await tool.execute({ name: 'a test agent', message: 'Hello from node --test.' });

  assert.equal(result.ok, true);
  assert.equal(result.entry.source, 'agent');
  assert.equal(result.entry.number, SEED_ENTRIES.length + 1);
  assert.equal(result.entry.label, '#006');
  assert.match(result.message, /#006/);
  // The confirmation has to name where the entry landed: the tool registers on every route,
  // including ones that do not render the book.
  assert.match(result.message, /guest book on the homepage/i);
  assert.match(result.message, /localStorage/);

  const stored = JSON.parse(localStorage.getItem(GUESTBOOK_STORAGE_KEY));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, 'agent');
});

test('sign_guestbook clamps over-long input rather than rejecting it', async () => {
  localStorage.removeItem(GUESTBOOK_STORAGE_KEY);
  const tool = toolsByName().sign_guestbook;

  const result = await tool.execute({ name: 'n'.repeat(200), message: 'm'.repeat(2000) });

  assert.equal(result.ok, true);
  assert.equal(result.entry.name.length, NAME_MAX);
  assert.equal(result.entry.message.length, MESSAGE_MAX);
});

test('sign_guestbook cannot be talked out of the agent badge', async () => {
  localStorage.removeItem(GUESTBOOK_STORAGE_KEY);
  const tool = toolsByName().sign_guestbook;

  // `source` is not a declared property, and Chrome does not enforce inputSchema — so an agent
  // CAN pass it. The handler must ignore it, or the badge means nothing.
  const result = await tool.execute({ name: 'a human, honest', message: 'Not an agent.', source: 'human' });

  assert.equal(result.entry.source, 'agent');
});

test('sign_guestbook returns an error object for empty input rather than throwing', async () => {
  const tool = toolsByName().sign_guestbook;

  assert.equal((await tool.execute({ name: '   ', message: 'ok' })).ok, false);
  assert.equal((await tool.execute({ name: 'ok', message: '  \n ' })).ok, false);
  assert.equal((await tool.execute({})).ok, false);
});

test('list_related_sites returns the same ring array the page renders', async () => {
  const result = await toolsByName().list_related_sites.execute({});

  assert.equal(result.ring.name, WEB_RING_NAME);
  assert.deepEqual(
    result.sites.map((site) => site.name),
    WEB_RING.map((member) => member.name)
  );
  // Open slots ship as open slots: a null url is the honest value, not an omission.
  assert.ok(result.sites.some((site) => site.status === 'open' && site.url === null));
  assert.ok(result.sites.some((site) => site.status === 'member' && typeof site.url === 'string'));
});

test('resolveModelContext prefers document, falls back to navigator, else null', () => {
  const spec = { registerTool() {} };
  const trial = { registerTool() {} };

  assert.equal(resolveModelContext({ document: { modelContext: spec }, navigator: { modelContext: trial } }), spec);
  assert.equal(resolveModelContext({ document: {}, navigator: { modelContext: trial } }), trial);
  assert.equal(resolveModelContext({ document: {}, navigator: {} }), null);
  // A namespace without registerTool is not usable — treat it as absent.
  assert.equal(resolveModelContext({ document: { modelContext: {} }, navigator: {} }), null);
});
