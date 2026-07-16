export type ScorecardStatus = 'Pass' | 'Partial' | 'Fail';

export interface ScorecardMetric {
  name: string;
  value: string;
  maximum: string;
  status: ScorecardStatus;
  description: string;
}

export interface ScorecardSnapshot {
  description: string;
  verified: { iso: string; label: string };
  scope: string;
  tools: readonly string[];
  entry: string;
  metrics: readonly ScorecardMetric[];
}

export const SCORECARD = {
  description: "This website's scores on the latest deploy.",
  verified: { iso: '2026-07-15', label: '15 Jul 2026' },
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
} as const satisfies ScorecardSnapshot;
