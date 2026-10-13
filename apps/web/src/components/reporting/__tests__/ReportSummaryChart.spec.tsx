import { render, screen } from '@testing-library/react';

import { ReportSummaryChart } from '../ReportSummaryChart';
import { buildReportChartBuckets, isReportChartEmpty } from '@/lib/report-chart';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: what the ONE report visualization promises —
 * bars over the server's own counts, never a second counting, and an empty message
 * instead of a lying axis.
 */
describe('buildReportChartBuckets — arranging, never counting', () => {
  const label = (key: string) => ({ DRAFT: 'پیش‌نویس', APPROVED: 'تأیید شده' })[key] ?? key;

  it('orders by the report vocabulary and zero-fills a missing key', () => {
    expect(
      buildReportChartBuckets({ APPROVED: 3 }, ['DRAFT', 'SUBMITTED', 'APPROVED'], label)
    ).toEqual([
      { key: 'DRAFT', label: 'پیش‌نویس', count: 0 },
      { key: 'SUBMITTED', label: 'SUBMITTED', count: 0 },
      { key: 'APPROVED', label: 'تأیید شده', count: 3 },
    ]);
  });

  it('keeps an unknown summary key at the end, raw — shown, never hidden', () => {
    expect(buildReportChartBuckets({ APPROVED: 1, MYSTERY: 2 }, ['APPROVED'], label)).toEqual([
      { key: 'APPROVED', label: 'تأیید شده', count: 1 },
      { key: 'MYSTERY', label: 'MYSTERY', count: 2 },
    ]);
  });

  it('is empty only when every bucket is zero', () => {
    expect(isReportChartEmpty([{ key: 'A', label: 'آ', count: 0 }])).toBe(true);
    expect(
      isReportChartEmpty([
        { key: 'A', label: 'آ', count: 0 },
        { key: 'B', label: 'ب', count: 1 },
      ])
    ).toBe(false);
  });
});

describe('ReportSummaryChart — bars over the server counts', () => {
  const buckets = [
    { key: 'DRAFT', label: 'پیش‌نویس', count: 4 },
    { key: 'APPROVED', label: 'تأیید شده', count: 12 },
  ];

  it('renders every bucket with its word and its Persian-digit count', () => {
    render(<ReportSummaryChart title="توزیع وضعیت" testId="t" buckets={buckets} />);

    expect(screen.getByTestId('t-chart')).toHaveAttribute('aria-label', 'توزیع وضعیت');
    expect(screen.getByTestId('t-chart-row-DRAFT')).toHaveTextContent('پیش‌نویس');
    expect(screen.getByTestId('t-chart-count-DRAFT')).toHaveTextContent('۴');
    expect(screen.getByTestId('t-chart-count-APPROVED')).toHaveTextContent('۱۲');
  });

  it('sizes bars against the largest bucket — a zero row keeps its row, not its width', () => {
    const withZero = [...buckets, { key: 'EMPTY', label: 'خالی', count: 0 }];
    render(<ReportSummaryChart title="توزیع وضعیت" testId="t" buckets={withZero} />);

    expect(screen.getByTestId('t-chart-bar-APPROVED')).toHaveStyle({ width: '100%' });
    const draftWidth = screen.getByTestId('t-chart-bar-DRAFT').getAttribute('style') ?? '';
    expect(draftWidth).toContain('33.33');
    expect(screen.getByTestId('t-chart-row-EMPTY')).toHaveTextContent('خالی');
    expect(screen.getByTestId('t-chart-count-EMPTY')).toHaveTextContent('۰');
    expect(screen.queryByTestId('t-chart-empty')).not.toBeInTheDocument();
  });

  it('renders a truthful empty state on an all-zero summary — no bare axis', () => {
    render(
      <ReportSummaryChart
        title="توزیع وضعیت"
        testId="t"
        buckets={[{ key: 'DRAFT', label: 'پیش‌نویس', count: 0 }]}
      />
    );

    expect(screen.getByTestId('t-chart-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('t-chart-row-DRAFT')).not.toBeInTheDocument();
  });

  it('carries the numbers as text, so meaning never depends on colour or hover', () => {
    const { container } = render(
      <ReportSummaryChart title="توزیع وضعیت" testId="t" buckets={buckets} />
    );

    // The decorative track is hidden from assistive tech; the visible count is not.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByTestId('t-chart').textContent).toContain('۱۲');
  });
});
