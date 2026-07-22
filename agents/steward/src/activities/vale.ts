import path from 'node:path';
import { z } from 'zod';
import { SITE_DIR } from '../config.js';
import { run, valeBinary, valeConfigDir } from '../lib/proc.js';
import type { Finding, PassResult, Verdict } from '../lib/report.js';
import { worstVerdict } from '../lib/report.js';
import { timed } from '../lib/logger.js';

/**
 * Vale's `--output=JSON` shape, transcribed from real v3.15.1 output rather than
 * from the docs: a top-level object keyed by *the path as Vale echoes it* (which
 * on Windows comes back with backslashes and is relative to the cwd Vale ran
 * in), whose values are arrays of alerts.
 *
 * Only the fields the mapping consumes are declared; `.loose()` keeps Vale free
 * to add fields without failing the activity.
 */
export const ValeAlert = z
  .object({
    Check: z.string(),
    Message: z.string(),
    Severity: z.string(),
    Line: z.number(),
    Match: z.string().optional(),
    Span: z.array(z.number()).optional(),
    Link: z.string().optional(),
  })
  .loose();
export type ValeAlert = z.infer<typeof ValeAlert>;

export const ValeOutput = z.record(z.string(), z.array(ValeAlert));
export type ValeOutput = z.infer<typeof ValeOutput>;

/**
 * Vale severity → Steward verdict.
 *
 * **Everything is a `flag`, including `error`** (spec §8.3). Prose linting has
 * false positives by nature, and design rule 1 reserves `block` for mechanical
 * checks whose findings are not matters of taste. A Vale `error` is a stronger
 * hint, not a gate — it sorts higher in the summary and nothing more.
 */
export function valeSeverityToVerdict(severity: string): Verdict {
  return severity === 'pass' ? 'pass' : 'flag';
}

/** Errors first, then warnings, then suggestions; ties broken by line. */
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, suggestion: 2 };

/**
 * Maps parsed Vale JSON to findings. Pure and exported so the mapping is unit
 * tested against canned output with no binary, no spawn, and no post on disk.
 */
export function valeAlertsToFindings(output: ValeOutput, file: string): Finding[] {
  // Vale keys the object by the path it was handed. There is exactly one file
  // per run, so take every alert regardless of how the key got normalised —
  // matching on the key would be matching on Windows path separators.
  const alerts = Object.values(output).flat();

  const sorted = [...alerts].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.Severity] ?? 3) - (SEVERITY_ORDER[b.Severity] ?? 3) || a.Line - b.Line,
  );

  return sorted.map((alert, i) => ({
    id: `vale-${i + 1}`,
    pass: 'vale' as const,
    severity: valeSeverityToVerdict(alert.Severity),
    // The rule name is carried in the message because it is the actionable part:
    // it is what you put in `.vale.ini` to turn the rule off.
    message: `${alert.Check} (${alert.Severity}): ${alert.Message}`,
    file,
    line: alert.Line,
    excerpt: alert.Match?.slice(0, 200) || undefined,
  }));
}

/**
 * Spec §8.3. Runs the pinned Vale binary over one file and maps its JSON.
 *
 * Vale is run with `cwd` set to the site directory and handed a repo-relative
 * path, so the paths in its output stay repo-relative too.
 */
export async function runVale(file: string): Promise<PassResult> {
  const { result, startedAt, durationMs } = await timed('runVale', async () => {
    const binary = valeBinary();
    const configPath = path.join(valeConfigDir(), '.vale.ini');

    const { stdout, stderr, exitCode } = await run(
      binary,
      ['--config', configPath, '--output=JSON', file],
      { cwd: SITE_DIR },
    );

    // Vale exits non-zero when it finds alerts, so a non-zero exit alone is not
    // a failure. Empty stdout with a non-zero exit is — that is Vale refusing to
    // run (bad config, missing style) and it must surface as a tool failure
    // rather than as a clean pass.
    if (!stdout.trim()) {
      if (exitCode !== 0) {
        throw new Error(`vale exited ${exitCode} with no output: ${stderr.trim() || '(no stderr)'}`);
      }
      return { findings: [] as Finding[], version: await valeVersion(binary) };
    }

    const parsed = ValeOutput.parse(JSON.parse(stdout));
    return { findings: valeAlertsToFindings(parsed, file), version: await valeVersion(binary) };
  });

  return {
    pass: 'vale',
    verdict: worstVerdict(result.findings.map((f) => f.severity)),
    findings: result.findings,
    patches: [],
    startedAt,
    durationMs,
    toolVersion: result.version,
  };
}

async function valeVersion(binary: string): Promise<string> {
  try {
    const { stdout } = await run(binary, ['--version']);
    return stdout.trim() || 'vale unknown';
  } catch {
    return 'vale unknown';
  }
}
