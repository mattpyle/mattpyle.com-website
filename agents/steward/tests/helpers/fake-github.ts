/**
 * An in-memory stand-in for the slice of the GitHub REST API that
 * `lib/github-contents.ts` uses.
 *
 * It exists because the Scorecard's persistence moved off the filesystem on
 * 2026-08-14. `archiveScorecardRun`'s guarantees — append-only, suffix on
 * collision, `latest.json` mirrors the newest record — were previously tested
 * against a temp directory, and that whole file would otherwise have had to be
 * deleted along with the `writeFile` it exercised. The guarantees did not
 * change when the storage did, and one of them (append-only) is there because
 * it was once broken in a way that destroyed the only copy of a run's per-page
 * detail. Losing the tests with the implementation would have been the
 * expensive kind of tidy.
 *
 * **It models the one API behaviour those guarantees now rest on**: a Contents
 * `PUT` with no `sha` is a create, and it fails with 422 if the path already
 * exists. That is what replaced the filesystem's `flag: 'wx'`, and a fake that
 * let a create silently overwrite would pass a test suite while the real thing
 * lost data.
 *
 * Deliberately not a general GitHub simulator. It answers exactly the routes
 * this codebase calls and throws loudly on anything else, so a new call site
 * shows up as an explicit failure here rather than as an undefined field three
 * frames away.
 */

export interface FakeRepoFile {
  text: string;
  sha: string;
}

export interface FakeGitHub {
  /** `branch → (path → file)`. Inspect it directly in assertions. */
  branches: Map<string, Map<string, FakeRepoFile>>;
  /** Every PR opened, in order. */
  pulls: Array<{ number: number; head: string; base: string; title: string; body: string; draft: boolean }>;
  /** Every request, as `METHOD /path`, for asserting call shape and count. */
  calls: string[];
  file(branch: string, path: string): FakeRepoFile | undefined;
  json(branch: string, path: string): any;
  restore(): void;
}

const DEFAULT_BRANCH = 'master';

/**
 * Content-addressed rather than a counter, because `readRepoFile` hands the sha
 * straight back to `writeRepoFile` as an optimistic-concurrency token and a
 * fake whose shas were sequential would pass a test that a real mismatched sha
 * would fail.
 */
function shaOf(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  return `sha-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface FakeGitHubOptions {
  /** Files present on the default branch before anything runs. */
  seed?: Record<string, string>;
}

/**
 * Installs the fake over `globalThis.fetch` and returns a handle. Call
 * `restore()` in an `after` hook.
 *
 * Sets `GITHUB_TOKEN` too: `githubToken()` throws a non-retryable `AuthError`
 * without one, which would fail every test here for a reason unrelated to what
 * they assert.
 */
export function installFakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const realFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'fake-token-for-tests';

  const branches = new Map<string, Map<string, FakeRepoFile>>();
  const base = new Map<string, FakeRepoFile>();
  for (const [path, text] of Object.entries(options.seed ?? {})) {
    base.set(path, { text, sha: shaOf(text) });
  }
  branches.set(DEFAULT_BRANCH, base);

  const pulls: FakeGitHub['pulls'] = [];
  const calls: string[] = [];

  globalThis.fetch = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'api.github.com') {
      throw new Error(`fake GitHub received a request to ${url.host}; only api.github.com is modelled`);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    // The repo prefix is constant for every call this codebase makes.
    const route = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    calls.push(`${method} ${route}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    // GET /repos/{owner}/{repo}
    if (method === 'GET' && route === '') {
      return response(200, { default_branch: DEFAULT_BRANCH });
    }

    // GET /git/ref/heads/{branch}
    const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(route);
    if (method === 'GET' && refMatch) {
      const branch = decodeURIComponent(refMatch[1]);
      if (!branches.has(branch)) return response(404, { message: 'Not Found' });
      return response(200, { object: { sha: `commit-${branch}` } });
    }

    // POST /git/refs — create a branch. 422 when it exists, which is the signal
    // `resetBranch` and `ensureBranch` both branch on.
    if (method === 'POST' && route === '/git/refs') {
      const branch = String(body.ref).replace('refs/heads/', '');
      if (branches.has(branch)) {
        return response(422, { message: 'Reference already exists' });
      }
      // Branching copies the tree, so a write to the branch cannot mutate base.
      branches.set(branch, new Map(branches.get(DEFAULT_BRANCH)));
      return response(201, { ref: body.ref });
    }

    // PATCH /git/refs/heads/{branch} — the force reset back to base.
    const patchRef = /^\/git\/refs\/heads\/(.+)$/.exec(route);
    if (method === 'PATCH' && patchRef) {
      const branch = decodeURIComponent(patchRef[1]);
      branches.set(branch, new Map(branches.get(DEFAULT_BRANCH)));
      return response(200, { ref: `refs/heads/${branch}` });
    }

    // GET /contents/{path}?ref=
    const contents = /^\/contents\/(.+)$/.exec(route);
    if (method === 'GET' && contents) {
      const path = decodeURIComponent(contents[1]);
      const ref = url.searchParams.get('ref') ?? DEFAULT_BRANCH;
      const file = branches.get(ref)?.get(path);
      if (!file) return response(404, { message: 'Not Found' });
      return response(200, {
        path,
        sha: file.sha,
        encoding: 'base64',
        content: Buffer.from(file.text, 'utf8').toString('base64'),
        download_url: `https://raw.example.invalid/${path}`,
      });
    }

    // PUT /contents/{path} — the write. This is the behaviour the archive's
    // append-only guarantee now rests on, so it is modelled exactly:
    //   no `sha`  → create, 422 if the path exists
    //   with `sha`→ update, 409 if it does not match what is there
    if (method === 'PUT' && contents) {
      const path = decodeURIComponent(contents[1]);
      const branch = String(body.branch);
      const tree = branches.get(branch);
      if (!tree) return response(404, { message: `branch ${branch} does not exist` });
      const existing = tree.get(path);
      if (!body.sha && existing) {
        return response(422, {
          message: `Invalid request. "sha" wasn't supplied for an existing file.`,
        });
      }
      if (body.sha && existing && existing.sha !== body.sha) {
        return response(409, { message: 'does not match' });
      }
      const text = Buffer.from(String(body.content), 'base64').toString('utf8');
      tree.set(path, { text, sha: shaOf(text) });
      return response(200, { commit: { sha: `commit-${shaOf(text)}` }, content: { sha: shaOf(text) } });
    }

    // GET /pulls?head=
    if (method === 'GET' && route === '/pulls') {
      const head = url.searchParams.get('head') ?? '';
      const branch = head.split(':')[1] ?? '';
      const open = pulls.filter((p) => p.head === branch);
      return response(200, open.map((p) => ({ number: p.number, html_url: prUrl(p.number) })));
    }

    if (method === 'POST' && route === '/pulls') {
      const number = pulls.length + 1;
      pulls.push({
        number,
        head: String(body.head),
        base: String(body.base),
        title: String(body.title),
        body: String(body.body),
        draft: body.draft === true,
      });
      return response(201, { number, html_url: prUrl(number) });
    }

    const patchPull = /^\/pulls\/(\d+)$/.exec(route);
    if (method === 'PATCH' && patchPull) {
      const number = Number(patchPull[1]);
      const pull = pulls.find((p) => p.number === number);
      if (pull) {
        pull.title = String(body.title);
        pull.body = String(body.body);
      }
      return response(200, { number, html_url: prUrl(number) });
    }

    throw new Error(`fake GitHub has no route for ${method} ${route} — add it deliberately`);
  }) as typeof fetch;

  return {
    branches,
    pulls,
    calls,
    file: (branch, path) => branches.get(branch)?.get(path),
    json(branch, path) {
      const file = branches.get(branch)?.get(path);
      if (!file) throw new Error(`${path} is not on ${branch}`);
      return JSON.parse(file.text);
    },
    restore() {
      globalThis.fetch = realFetch;
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    },
  };
}

function prUrl(number: number): string {
  return `https://github.com/mattpyle/mattpyle.com-website/pull/${number}`;
}
