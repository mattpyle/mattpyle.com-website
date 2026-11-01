import type { QueryDefinition } from '@temporalio/common';
import { parseFrontmatter } from '../lib/frontmatter.js';
import {
  findingPath,
  findingWorkflowId,
  findingsIndexPath,
  fixPrUrl,
  isFindingSlug,
  parseFindingsIndex,
  parseVerificationSection,
  siteConfigPath,
  type ParsedVerification,
} from '../lib/findings.js';
import { buildEvents, type FindingEvent } from './finding-events.js';
import { renderFindingBody, type FindingSection } from './finding-markdown.js';
import { fixOffered, verifyOffered } from '../lib/finding-actions.js';
import { parsePrUrl } from '../lib/findings.js';
import { dispatchWorkflowId, waitingSlotLine, type DispatchState } from '../lib/fix-dispatch.js';
import { findingStateQuery, type FindingState } from '../workflows/finding.js';
import { dispatchStateQuery } from '../workflows/fix-dispatch.js';

/**
 * What `/findings` shows, read from the three sources the design names: the
 * store on GitHub (INDEX.md and the finding files), the open runs from the
 * Temporal list, and the `state` query of the runs that need watching.
 *
 * **What a refresh costs.** Temporal Cloud bills a query as one action; a list
 * is free. So only rows whose file says `approved` or `fixing` and that have an
 * open run are queried, about 15, plus one dispatcher query for a site with a
 * run at `waiting-slot`. A `proposed` or `reopened` row with an open run is at
 * `waiting-verdict` by construction, and a `resolved` or `rejected` row has no
 * run to ask. At 20 refreshes a day that is about 9,000 actions a month, or
 * $0.45 (findings-dashboard design, 2026-10-31).
 *
 * GitHub costs one tree call per refresh. Blob text is cached in this process
 * by blob sha, so after the first load a refresh reads only the files that
 * changed. The first load reads every finding file once, about 220 calls of
 * the token's 5,000 an hour.
 */

export const STATE_QUERIED_STATUSES = ['approved', 'fixing'] as const;

/** How the page groups a row, by its file status. */
export type RowGroup = 'verdict' | 'flight' | 'done' | 'other';

export function rowGroup(status: string): RowGroup {
  if (status === 'proposed' || status === 'reopened') return 'verdict';
  if (status === 'approved' || status === 'fixing') return 'flight';
  if (status === 'resolved' || status === 'rejected') return 'done';
  return 'other';
}

export interface FindingRunView {
  open: boolean;
  /** ISO 8601 start of the open run. */
  since: string | null;
  /** From the `state` query, or `waiting-verdict` by construction; null when unknown. */
  step: string | null;
  /** True when this refresh asked the run's `state`. */
  queried: boolean;
  queryError: string | null;
  prUrl: string | null;
  issueUrl: string | null;
  previewResult: string | null;
  lastFixError: string | null;
  /** At `waiting-slot`: what holds the slot, from the site's dispatcher. */
  slotLine: string | null;
}

export interface FindingRow {
  site: string;
  key: string;
  /** The INDEX.md status. */
  status: string;
  /** The finding file's own `status`; null when there is no file. */
  fileStatus: string | null;
  /** The `kind` field: defect, opportunity or direction. Never joined with `type`. */
  kind: string;
  /** The `type` field: content, accessibility and so on; null when the file has none. */
  type: string | null;
  title: string;
  /** `title_short` when the file has it; the server never invents one. */
  titleShort: string | null;
  /** `summary` when the file has it. */
  summary: string | null;
  /** A short key when Argus writes one; null until it does. */
  keyShort: string | null;
  reason: string;
  priority: string | null;
  verdictAt: string | null;
  verdictSource: string | null;
  /** `first_seen` from the file as YYYY-MM-DD; null when the file has none. */
  opened: string | null;
  /** The line's position in INDEX.md from 0, the order Argus wrote them: the fallback for `opened`. */
  index: number;
  /** `links.pr` from the file, else the run's PR. */
  prUrl: string | null;
  fileMissing: boolean;
  run: FindingRunView;
  verification: ParsedVerification | null;
  /** Where the file and the run disagree, one line each. Empty when they agree. */
  drift: string[];
  /** Why a row with no open run is as designed, in one quiet line; not a drift flag. */
  quietReason: string | null;
  /** The finding's body below the H1, rendered as safe HTML. Empty without a file. */
  body: string;
  /** The H2 sections in file order, each as safe HTML. */
  sections: FindingSection[];
  /** Dated history, oldest first. */
  events: FindingEvent[];
  /**
   * The buttons the foot offers: only where the CLI's own gate accepts the verb (`fixRefusal`, the verifier's
   * gate with a merged PR). Decided on the server; the page never re-derives them. Fix is for a row with no
   * open run, so it is false until the loader has seen the run list.
   */
  actions: { fix: boolean; verify: boolean };
}

export interface SiteSection {
  site: string;
  rows: FindingRow[];
  /** INDEX.md lines per status. */
  counts: Record<string, number>;
  /** Open `findingWorkflow` runs under `finding/<site>/`, as `steward finding list` counts them. */
  openRuns: number;
  /** Open runs whose key has no INDEX.md line. */
  orphanRuns: string[];
}

export interface FailedVerifyRun {
  workflowId: string;
  site: string;
  key: string;
  status: string;
  closeTime: string | null;
}

export interface FindingsModel {
  generatedAt: string;
  repo: string;
  sites: SiteSection[];
  failedVerifies: FailedVerifyRun[];
  /** What this refresh cost, so the footer can show it against the design's line. */
  cost: { treeCalls: number; blobReads: number; stateQueries: number; dispatcherQueries: number };
}

/** What a site's `config.yaml` and the row's kind change about a row with no open run. */
export interface DriftContext {
  /** The site's `stop_after`; `verdict` means no fixer runs, so an approved row ends with no run. */
  stopAfter?: string | null;
  kind?: string;
}

export const QUIET_NO_FIXER = 'no fixer for this site';
export const QUIET_OPPORTUNITY = 'opportunity, yours to take';

/**
 * Where a row's file and run disagree. `run.step` is only known for a queried
 * row; an unqueried row is judged on whether a run is open at all.
 */
export function driftFor(
  status: string,
  fileStatus: string | null,
  run: FindingRunView,
  context: DriftContext = {},
): string[] {
  return assessRow(status, fileStatus, run, context).drift;
}

/**
 * Drift plus the quiet reason. An approved row with no run is designed, not
 * drift, on a site that stops at the verdict and for an opportunity, which the
 * fixer gate refuses and which stays Matt's. The site's rule comes first.
 */
export function assessRow(
  status: string,
  fileStatus: string | null,
  run: FindingRunView,
  context: DriftContext = {},
): { drift: string[]; quietReason: string | null } {
  const drift: string[] = [];
  let quietReason: string | null = null;
  if (fileStatus !== null && fileStatus !== status) {
    drift.push(`INDEX.md says ${status}, the file says ${fileStatus}`);
  }
  switch (rowGroup(status)) {
    case 'verdict':
      if (!run.open) drift.push(`${status} with no open run`);
      break;
    case 'flight':
      if (!run.open) {
        if (status === 'approved' && context.stopAfter === 'verdict') quietReason = QUIET_NO_FIXER;
        else if (status === 'approved' && context.kind === 'opportunity') quietReason = QUIET_OPPORTUNITY;
        else drift.push(`${status} with no open run`);
      } else if (run.step === 'waiting-verdict') drift.push(`${status}, but the run still waits for a verdict`);
      else if (status === 'fixing' && run.step === 'waiting-fix') drift.push('fixing, but the run waits for a fix');
      else if (run.step === 'done') drift.push(`${status}, but the run is done`);
      break;
    case 'done':
      if (run.open) drift.push(`${status} with an open run`);
      break;
    case 'other':
      drift.push(`unknown status "${status}"`);
      break;
  }
  return { drift, quietReason };
}

/** A site's `stop_after`, read with Steward's one YAML reader; null when the file sets none. */
export function siteStopAfter(configText: string): string | null {
  const data = parseFrontmatter(`---\n${configText}\n---\n`).data as Record<string, any>;
  const value = data.stop_after ?? data.site?.stop_after;
  return typeof value === 'string' ? value : null;
}

/** The H1 of a finding file, the finding in one line. */
export function findingTitle(body: string): string {
  const h1 = /^#\s+(.+?)\s*$/m.exec(body);
  return h1 ? h1[1] : '';
}

function str(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/** One entry of a workflow list, as the console reads it. */
export interface ConsoleWorkflowInfo {
  workflowId: string;
  startTime: Date;
  closeTime?: Date;
  status: { name: string };
}

/** The part of a Temporal `Client` the loader uses. */
export interface ConsoleClient {
  workflow: {
    list(options: { query: string }): AsyncIterable<ConsoleWorkflowInfo>;
    getHandle(workflowId: string): { query<R>(def: QueryDefinition<R, []>): Promise<R> };
  };
}

export interface FindingsSources {
  /** `owner/name` of the findings store. */
  repo: string;
  /** A GitHub REST GET returning parsed JSON: `gh` from `lib/github.ts`. */
  ghJson: (pathname: string) => Promise<any>;
  client: ConsoleClient;
  now?: () => Date;
}

const BRANCH = 'main';
const PARALLEL = 8;
const FAILED_VERIFY_DAYS = 7;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function errorLine(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A loader with its blob cache. One per console process: the cache is the
 * reason a refresh stays at one GitHub call when nothing changed.
 */
export function createFindingsLoader(sources: FindingsSources): { load(): Promise<FindingsModel> } {
  const blobs = new Map<string, string>();
  // A merged PR stays merged, so a yes is asked once per process; a no is asked again on the next refresh.
  const mergedPrs = new Set<string>();
  const prMerged = async (prUrl: string): Promise<boolean> => {
    if (mergedPrs.has(prUrl)) return true;
    const pr = parsePrUrl(prUrl) as { repo: string; number: number };
    try {
      const data = await sources.ghJson(`/repos/${pr.repo}/pulls/${pr.number}`);
      if (data.merged === true) mergedPrs.add(prUrl);
      return data.merged === true;
    } catch {
      return false;
    }
  };

  return {
    async load() {
      const now = sources.now?.() ?? new Date();
      const cost = { treeCalls: 0, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 };

      const readBlob = async (sha: string): Promise<string> => {
        const cached = blobs.get(sha);
        if (cached !== undefined) return cached;
        cost.blobReads++;
        const blob = await sources.ghJson(`/repos/${sources.repo}/git/blobs/${sha}`);
        const text = Buffer.from(String(blob.content ?? ''), 'base64').toString('utf8');
        blobs.set(sha, text);
        return text;
      };

      cost.treeCalls++;
      const tree = await sources.ghJson(`/repos/${sources.repo}/git/trees/${BRANCH}?recursive=1`);
      const shaByPath = new Map<string, string>();
      for (const entry of (tree.tree ?? []) as { path: string; type: string; sha: string }[]) {
        if (entry.type === 'blob') shaByPath.set(entry.path, entry.sha);
      }
      const sites = [...shaByPath.keys()]
        .map((p) => /^sites\/([^/]+)\/findings\/INDEX\.md$/.exec(p)?.[1])
        .filter((s): s is string => !!s && isFindingSlug(s))
        .sort();

      // The open runs: one free list for every site.
      const openRuns = new Map<string, ConsoleWorkflowInfo>();
      for await (const info of sources.client.workflow.list({
        query: "WorkflowType='findingWorkflow' AND ExecutionStatus='Running'",
      })) {
        openRuns.set(info.workflowId, info);
      }

      const sections: SiteSection[] = [];
      for (const site of sites) {
        const indexText = await readBlob(shaByPath.get(findingsIndexPath(site)) as string);
        const lines = parseFindingsIndex(indexText);
        const configSha = shaByPath.get(siteConfigPath(site));
        const stopAfter = configSha ? siteStopAfter(await readBlob(configSha)) : null;

        const rows = await mapLimit(lines, PARALLEL, async (line, index): Promise<FindingRow> => {
          const sha = shaByPath.get(findingPath(site, line.key));
          let data: Record<string, unknown> = {};
          let body = '';
          let text = '';
          if (sha) {
            text = await readBlob(sha);
            const parsed = parseFrontmatter(text);
            data = parsed.data;
            body = parsed.content;
          }
          const info = openRuns.get(findingWorkflowId(site, line.key));
          const run: FindingRunView = {
            open: !!info,
            since: info ? info.startTime.toISOString() : null,
            step: info && rowGroup(line.status) === 'verdict' ? 'waiting-verdict' : null,
            queried: false,
            queryError: null,
            prUrl: null,
            issueUrl: null,
            previewResult: null,
            lastFixError: null,
            slotLine: null,
          };
          const filePr = fixPrUrl(data);
          const rendered = renderFindingBody(body);
          const verification = sha ? parseVerificationSection(body) : null;
          return {
            site,
            key: line.key,
            status: line.status,
            fileStatus: sha ? str(data.status) : null,
            kind: line.kind || str(data.kind) || '',
            type: str(data.type),
            title: findingTitle(body) || line.key,
            titleShort: str(data.title_short),
            summary: str(data.summary),
            keyShort: str(data.key_short),
            reason: line.reason,
            priority: str(data.priority),
            verdictAt: str(data.verdict_at),
            verdictSource: str(data.verdict_source),
            opened: str(data.first_seen)?.slice(0, 10) ?? null,
            index,
            prUrl: filePr || null,
            fileMissing: !sha,
            run,
            verification,
            drift: [],
            quietReason: null,
            body: rendered.body,
            sections: rendered.sections,
            events: sha ? buildEvents({ data, body, status: line.status, prUrl: filePr || null, verification }) : [],
            actions: {
              fix: sha
                ? fixOffered({ site, status: line.status, runOpen: run.open, stopAfter, data, text })
                : false,
              verify: sha ? await verifyOffered({ site, data }, prMerged) : false,
            },
          };
        });

        // The billed part: the runs that need watching, and nothing else.
        const watched = rows.filter(
          (row) => row.run.open && (STATE_QUERIED_STATUSES as readonly string[]).includes(row.status),
        );
        const states = new Map<string, FindingState>();
        await mapLimit(watched, PARALLEL, async (row) => {
          cost.stateQueries++;
          try {
            const state = await sources.client.workflow
              .getHandle(findingWorkflowId(site, row.key))
              .query(findingStateQuery);
            states.set(row.key, state);
            row.run.queried = true;
            row.run.step = state.step ?? (state.status === 'done' ? 'done' : 'waiting-verdict');
            row.run.prUrl = state.prUrl ?? null;
            row.run.issueUrl = state.issueUrl ?? null;
            row.run.previewResult = state.previewResult ?? null;
            row.run.lastFixError = state.lastFixError ?? null;
            if (!row.prUrl && state.prUrl) row.prUrl = state.prUrl;
          } catch (err) {
            row.run.queryError = errorLine(err);
          }
        });

        // One dispatcher query for the site, only when a run waits for a slot.
        const slotted = rows.filter((row) => row.run.step === 'waiting-slot');
        if (slotted.length > 0) {
          cost.dispatcherQueries++;
          let dispatch: DispatchState | null = null;
          try {
            dispatch = await sources.client.workflow.getHandle(dispatchWorkflowId(site)).query(dispatchStateQuery);
          } catch {
            dispatch = null;
          }
          for (const row of slotted) {
            row.run.slotLine = waitingSlotLine(
              dispatch,
              findingWorkflowId(site, row.key),
              states.get(row.key)?.slotPaths,
            );
          }
        }

        for (const row of rows) {
          const assessed = assessRow(row.status, row.fileStatus, row.run, { stopAfter, kind: row.kind });
          row.drift = assessed.drift;
          row.quietReason = assessed.quietReason;
          if (row.fileMissing) row.drift.unshift('no finding file');
        }

        const counts: Record<string, number> = {};
        for (const line of lines) counts[line.status] = (counts[line.status] ?? 0) + 1;
        const keys = new Set(lines.map((l) => l.key));
        const prefix = `finding/${site}/`;
        const siteRuns = [...openRuns.keys()].filter((id) => id.startsWith(prefix));
        sections.push({
          site,
          rows,
          counts,
          openRuns: siteRuns.length,
          orphanRuns: siteRuns.filter((id) => !keys.has(id.slice(prefix.length))).sort(),
        });
      }

      // Failed verifies: a closed `verify/...` run writes nothing to the file, so this list is the only place it shows.
      const since = new Date(now.getTime() - FAILED_VERIFY_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const failedVerifies: FailedVerifyRun[] = [];
      for await (const info of sources.client.workflow.list({
        query:
          "WorkflowType='verifyFindingWorkflow' AND ExecutionStatus!='Running' AND ExecutionStatus!='Completed' " +
          `AND CloseTime > '${since}'`,
      })) {
        const [, site = '', key = ''] = info.workflowId.split('/');
        failedVerifies.push({
          workflowId: info.workflowId,
          site,
          key,
          status: info.status.name,
          closeTime: info.closeTime ? info.closeTime.toISOString() : null,
        });
      }
      failedVerifies.sort((a, b) => (b.closeTime ?? '').localeCompare(a.closeTime ?? ''));

      return { generatedAt: now.toISOString(), repo: sources.repo, sites: sections, failedVerifies, cost };
    },
  };
}

