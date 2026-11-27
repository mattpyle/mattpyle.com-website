import { GITHUB_REPO } from '../config.js';
import { APP_ID_ENV, APP_KEY_ENV, gh } from './github.js';
import { branchSha, ensureBranch, listRepoDir, openOrUpdatePr, readRepoFile, writeRepoFile } from './github-contents.js';
import type { BackfillGitHub } from './fix-log-backfill.js';

/**
 * The real GitHub behind `steward fix-log backfill`, through the GitHub App, and the
 * check that its credentials are there before any call. Kept apart from
 * `fix-log-backfill.ts` so its tests load no GitHub client.
 */

/** Why the backfill cannot start, naming variables and never a value; null when it can. */
export function backfillCredentialRefusal(env: Record<string, string | undefined>, dryRun: boolean): string | null {
  const missing = [APP_ID_ENV, APP_KEY_ENV, ...(dryRun ? [] : ['ANTHROPIC_API_KEY'])].filter((name) => !env[name]);
  if (missing.length === 0) return null;
  const needs = dryRun
    ? 'A dry run reads the findings store and the site repository through the GitHub App.'
    : 'The backfill reads and writes through the GitHub App and drafts with the model.';
  return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ${needs} Run it from agents/steward in the main checkout, with its secrets resolved by 1Password.`;
}

/** A pull request's files, as one unified diff. */
export async function diffOf(repo: string, number: number): Promise<string> {
  const parts: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const files = (await gh(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)) as Array<{
      filename: string;
      status: string;
      patch?: string;
    }>;
    for (const f of files) parts.push(`--- ${f.filename} (${f.status})\n${f.patch ?? '(no text diff)'}`);
    if (files.length < 100) break;
  }
  return parts.join('\n\n');
}

export function backfillGitHub(): BackfillGitHub {
  return {
    async readFile(repo, path, ref) {
      return (await readRepoFile(path, ref, repo))?.text;
    },
    listDir: (repo, dir, ref) => listRepoDir(dir, ref, repo),
    async branchSha(repo, branch) {
      try {
        return await branchSha(branch, repo);
      } catch (err) {
        if (err instanceof Error && /404/.test(err.message)) return undefined;
        throw err;
      }
    },
    ensureBranch: (repo, branch, fromSha) => ensureBranch(branch, fromSha, repo),
    async writeFile(repo, input) {
      return (await writeRepoFile({ repo, ...input })).commitSha;
    },
    async pullRequest(repo, number) {
      const pr = await gh(`/repos/${repo}/pulls/${number}`);
      return {
        number,
        title: String(pr.title ?? ''),
        body: String(pr.body ?? ''),
        opened: String(pr.created_at),
        merged: pr.merged === true ? String(pr.merged_at) : null,
      };
    },
    pullRequestDiff: diffOf,
    async openOrUpdatePr(repo, input) {
      if (repo !== GITHUB_REPO) throw new Error(`openOrUpdatePr opens pull requests on ${GITHUB_REPO} only, not ${repo}.`);
      return openOrUpdatePr(input);
    },
  };
}
