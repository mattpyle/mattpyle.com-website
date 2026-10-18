#!/usr/bin/env node
/**
 * Write dist/client/build-stamp.txt: the git SHA and the build time, one line.
 *
 * The a11y suite adopts whatever is already serving on port 4321, which on Windows can be an
 * orphaned scripts/serve-built-site.mjs from an earlier build. The server reads this file once at
 * startup and serves that copy at /build-stamp.txt, and tests/a11y/global-setup.ts compares what
 * the server serves with the file on disk. A server older than the build it is being asked to
 * represent then fails the run before any spec.
 *
 * Runs last in `npm run build`, after every validator, so none of them sees the file.
 *
 * The SHA comes from VERCEL_GIT_COMMIT_SHA or GITHUB_SHA when set, then from git, then `unknown`.
 * The time makes two builds of one commit differ, which is what a rebuild after a local edit needs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outFile = fileURLToPath(new URL('../dist/client/build-stamp.txt', import.meta.url));

function gitSha() {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const stamp = `${gitSha()} ${new Date().toISOString()}`;
mkdirSync(fileURLToPath(new URL('../dist/client/', import.meta.url)), { recursive: true });
writeFileSync(outFile, `${stamp}\n`);
console.log(`write-build-stamp: ${stamp}`);
