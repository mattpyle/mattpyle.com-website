/**
 * `--import` for a CLI test that spawns `src/cli.ts`: the fake GitHub, seeded
 * from `STEWARD_FAKE_GITHUB_SEED` (a JSON object of path to text) on `main`,
 * inside the child process. Put it after `no-real-credentials.ts`.
 */
import { installFakeGitHub } from './fake-github.js';

installFakeGitHub({ seed: JSON.parse(process.env.STEWARD_FAKE_GITHUB_SEED ?? '{}'), defaultBranch: 'main' });
