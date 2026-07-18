import { SCORECARD_VERIFIED } from './sitemap-lastmod.mjs';

export type ScorecardStatus = 'Pass' | 'Partial' | 'Fail';
export type IsoTimestamp = `${number}-${number}-${number}T${number}:${number}:${number}${
  | 'Z'
  | `+${number}:${number}`
  | `-${number}:${number}`}`;

interface ScorecardVerification {
  iso: string;
  label: string;
  /** Exact ISO 8601 audit time. Omit when the run only has a calendar date. */
  timestamp?: IsoTimestamp;
}

export interface ScorecardMetric {
  name: string;
  value: string;
  maximum: string;
  status: ScorecardStatus;
  description: string;
}

export interface ScorecardSnapshot {
  description: string;
  verified: ScorecardVerification;
  scope: string;
  tools: readonly string[];
  entry: string;
  metrics: readonly ScorecardMetric[];
}

export interface ScorecardHistoryRun {
  id: string;
  verified: ScorecardVerification;
  scope: string;
  tools: readonly string[];
  entry: string;
  commentary: string;
  metrics: readonly ScorecardMetric[];
}

export const SCORECARD: ScorecardSnapshot = {
  description: "This website's scores on the latest deploy.",
  verified: SCORECARD_VERIFIED,
  scope: '5 live page types',
  tools: ['Lighthouse 13.4', 'axe-core 4.12'],
  entry: 'Manual · intentional',
  metrics: [
    {
      name: 'Accessibility',
      value: '100',
      maximum: '100',
      status: 'Pass',
      description:
        'Every tested page received the maximum Lighthouse accessibility score. An axe scan also found no automated WCAG violations.',
    },
    {
      name: 'Performance',
      value: '98',
      maximum: '100',
      status: 'Pass',
      description:
        'The lowest Lighthouse performance score across five tested pages. The other four pages scored 100.',
    },
    {
      name: 'SEO',
      value: '100',
      maximum: '100',
      status: 'Pass',
      description:
        'Every tested page received the maximum Lighthouse SEO score. The audit covered the homepage, about, writing index, builds index, and a published article.',
    },
    {
      name: 'Agentic Browsing',
      value: '3',
      maximum: '3',
      status: 'Pass',
      description:
        'Every applicable Lighthouse agent check passes: accessibility tree, layout stability, and llms.txt.',
    },
  ],
};

/**
 * The two historical runs below are the public live-network baselines already
 * recorded in the changelog. Their exact times were not captured, so their
 * optional ISO timestamps are omitted rather than reconstructed.
 */
export const SCORECARD_HISTORY: readonly ScorecardHistoryRun[] = [
  {
    id: '2026-07-14-self-hosted-fonts',
    verified: {
      iso: '2026-07-14',
      label: '14 Jul 2026',
    },
    scope: '5 live page types',
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    entry: 'Manual · after self-hosting fonts',
    commentary:
      'Self-hosting the site fonts removed the render-blocking cross-origin request. The lowest Performance result returned to the passing range.',
    metrics: [
      {
        name: 'Accessibility',
        value: '100',
        maximum: '100',
        status: 'Pass',
        description: 'Maximum Lighthouse Accessibility score across the tested pages.',
      },
      {
        name: 'Performance',
        value: '97',
        maximum: '100',
        status: 'Pass',
        description: 'Lowest Lighthouse Performance score across the tested pages.',
      },
      {
        name: 'SEO',
        value: '100',
        maximum: '100',
        status: 'Pass',
        description: 'Maximum Lighthouse SEO score across the tested pages.',
      },
      {
        name: 'Agentic Browsing',
        value: '3',
        maximum: '3',
        status: 'Pass',
        description: 'All applicable Lighthouse Agentic Browsing checks passed.',
      },
    ],
  },
  {
    id: '2026-07-14-first-live-baseline',
    verified: {
      iso: '2026-07-14',
      label: '14 Jul 2026',
    },
    scope: '5 live page types',
    tools: ['Lighthouse 13.4', 'axe-core 4.12'],
    entry: 'Manual · first live-network baseline',
    commentary:
      'The first live-network baseline exposed a Performance regression hidden by localhost testing: a cross-origin font stylesheet held first paint to roughly 3.2–3.5 seconds.',
    metrics: [
      {
        name: 'Accessibility',
        value: '100',
        maximum: '100',
        status: 'Pass',
        description: 'Maximum Lighthouse Accessibility score across the tested pages.',
      },
      {
        name: 'Performance',
        value: '84',
        maximum: '100',
        status: 'Fail',
        description: 'Lowest Lighthouse Performance score across the tested pages.',
      },
      {
        name: 'SEO',
        value: '100',
        maximum: '100',
        status: 'Pass',
        description: 'Maximum Lighthouse SEO score across the tested pages.',
      },
      {
        name: 'Agentic Browsing',
        value: '3',
        maximum: '3',
        status: 'Pass',
        description: 'All applicable Lighthouse Agentic Browsing checks passed.',
      },
    ],
  },
];
