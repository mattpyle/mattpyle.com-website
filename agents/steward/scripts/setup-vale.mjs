#!/usr/bin/env node
/**
 * Downloads the pinned Vale binary into `agents/steward/bin/` (gitignored).
 *
 * Vale is a single Go binary and deliberately not an npm package (spec §8.3), so
 * acquisition is ours to do. Three things this script is careful about:
 *
 * 1. **The version is pinned and the checksum is verified.** Vale emits `block`-
 *    adjacent editorial findings; silently upgrading the linter underneath a
 *    tuned `.vale.ini` would change verdicts with no diff to explain them.
 * 2. **The upstream repo moved.** Vale now lives at `vale-cli/vale`, not
 *    `errata-ai/vale`. The old org still resolves via redirect today; pinning the
 *    current one means we do not depend on that redirect surviving.
 * 3. **Asset names are not `<os>_<arch>`.** The spec anticipated
 *    `windows_amd64`; the real assets are `Windows_64-bit.zip`,
 *    `Linux_64-bit.tar.gz`, `macOS_arm64.tar.gz`, and so on. The mapping below is
 *    transcribed from the actual v3.15.1 release rather than constructed.
 *
 * Windows ships a zip, every other platform a tar.gz — handled separately
 * because Node has no built-in zip reader and `tar` is not on PATH on Windows.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const VALE_VERSION = '3.15.1';

/**
 * SHA-256 of each release asset, from
 * https://github.com/vale-cli/vale/releases/download/v3.15.1/vale_3.15.1_checksums.txt
 */
const ASSETS = {
  'win32-x64': {
    file: `vale_${VALE_VERSION}_Windows_64-bit.zip`,
    sha256: '3395fca0ddfb10a9b6caa28e091d5df709b1d6b6579afb7dece852cad89b94f3',
  },
  'linux-x64': {
    file: `vale_${VALE_VERSION}_Linux_64-bit.tar.gz`,
    sha256: 'c024d9c157874fb043d4f24a055d60050d1bb18755251f590593eed5bace1857',
  },
  'linux-arm64': {
    file: `vale_${VALE_VERSION}_Linux_arm64.tar.gz`,
    sha256: '281a419e140da11a408935356bab7a4ef770fed047a9d7bd1765c76acd647d01',
  },
  'darwin-x64': {
    file: `vale_${VALE_VERSION}_macOS_64-bit.tar.gz`,
    sha256: '9268383c9e244332c4483cb359e52bd4cb030542873e2cafc48e3bbfff6a989a',
  },
  'darwin-arm64': {
    file: `vale_${VALE_VERSION}_macOS_arm64.tar.gz`,
    sha256: '968c6d8bf2052bc97aa24274234cc466dbcc249b55ace33dd382c2cdfa93b08c',
  },
};

const STEWARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(STEWARD_DIR, 'bin');

export function valeBinaryPath() {
  return path.join(BIN_DIR, process.platform === 'win32' ? 'vale.exe' : 'vale');
}

function assetForCurrentPlatform() {
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    throw new Error(
      `No pinned Vale asset for ${key}. Known platforms: ${Object.keys(ASSETS).join(', ')}. ` +
        `Add the asset + checksum from the v${VALE_VERSION} release if this platform needs support.`,
    );
  }
  return asset;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

/**
 * Windows has no `tar` guarantee and Node has no zip reader, so shell out to
 * PowerShell's Expand-Archive. Elsewhere, `tar` is universally present.
 */
async function extract(archive, destDir) {
  if (archive.endsWith('.zip')) {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`,
      ],
      { windowsHide: true },
    );
  } else {
    await execFileAsync('tar', ['-xzf', archive, '-C', destDir], { windowsHide: true });
  }
}

async function main() {
  const asset = assetForCurrentPlatform();
  const url = `https://github.com/vale-cli/vale/releases/download/v${VALE_VERSION}/${asset.file}`;

  await fs.mkdir(BIN_DIR, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-vale-'));
  const archive = path.join(tmpDir, asset.file);

  try {
    console.log(`  downloading ${asset.file} …`);
    await download(url, archive);

    const actual = await sha256File(archive);
    if (actual !== asset.sha256) {
      throw new Error(
        `Checksum mismatch for ${asset.file}.\n  expected ${asset.sha256}\n  actual   ${actual}\n` +
          `Refusing to install. Either the release was re-cut or the download was tampered with.`,
      );
    }
    console.log(`  checksum ok (${actual.slice(0, 16)}…)`);

    await extract(archive, tmpDir);

    const binName = process.platform === 'win32' ? 'vale.exe' : 'vale';
    const extracted = path.join(tmpDir, binName);
    await fs.copyFile(extracted, valeBinaryPath());
    if (process.platform !== 'win32') await fs.chmod(valeBinaryPath(), 0o755);

    const { stdout } = await execFileAsync(valeBinaryPath(), ['--version'], { windowsHide: true });
    console.log(`  installed → ${valeBinaryPath()}`);
    console.log(`  ${stdout.trim()}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\n  setup:vale failed — ${err.message}\n`);
  process.exit(1);
});
