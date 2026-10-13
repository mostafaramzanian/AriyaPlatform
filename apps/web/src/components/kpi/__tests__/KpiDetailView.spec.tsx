import { render, screen } from '@testing-library/react';

import { KpiDetailView } from '../KpiDetailView';
import { CoreApiError } from '@/lib/core-http';
import { fetchKpi, fetchKpiHistory } from '@/lib/kpi-api';
import { authState, grant, history, kpi } from './kpi-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/kpi-api', () => ({
  ...jest.requireActual('@/lib/kpi-api'),
  fetchKpi: jest.fn(),
  fetchKpiHistory: jest.fn(),
}));

const fetchMock = fetchKpi as jest.MockedFunction<typeof fetchKpi>;
const historyMock = fetchKpiHistory as jest.MockedFunction<typeof fetchKpiHistory>;

/**
 * Phase KPI-RUNTIME — what the KPI detail promises, as executable behaviour:
 *
 *  1. THE VALUE is the payload's own, rendered once — display conversion when the catalogue
 *     authorised one, the governed value in its semantic unit otherwise.
 *  2. ABSENCE IS A FINDING — an em dash plus the reason sentence, never `۰`.
 *  3. QUALITY ≠ PERFORMANCE — the classification is labelled as DATA readiness, the
 *     performance sentence is unconditional, and target/threshold are stated as undefined.
 *  4. THE PROVENANCE arrives as the catalogue's own wording — population, exclusions,
 *     the cohort field, the four counts, evidence, limitations and governance.
 *  5. STATES — a 404 reads as "no such approved KPI", a real failure as an error with a
 *     retry, and a caller with none of the three remits never triggers a request.
 */

const KEY = 'production-bom-decision-cycle-time';

beforeEach(() => {
  fetchMock.mockReset();
  historyMock.mockReset();
  historyMock.mockResolvedValue(history());
  grant(['production.bom.read']);
  authState();
});

describe('the value — the payload’s own, rendered exactly once', () => {
  it('fetches the key from the route and renders its display conversion', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    expect(await screen.findByTestId('kpi-detail-value')).toHaveTextContent('۹ ساعت');
    expect(fetchMock).toHaveBeenCalledWith(KEY);
  });

  it('renders the governed value in its semantic unit when no conversion is authorised', async () => {
    fetchMock.mockResolvedValue(kpi({ display: null }));

    render(<KpiDetailView technicalKey={KEY} />);

    expect(await screen.findByTestId('kpi-detail-value')).toHaveTextContent('۳۲۴۰۰ ثانیه');
  });

  it('renders absence as an em dash plus its reason — never a zero', async () => {
    fetchMock.mockResolvedValue(
      kpi({
        availability: 'NOT_AVAILABLE',
        unavailableReason: 'EMPTY_DENOMINATOR',
        value: null,
        display: null,
      })
    );

    render(<KpiDetailView technicalKey={KEY} />);

    const unavailable = await screen.findByTestId('kpi-detail-unavailable');
    expect(unavailable).toHaveTextContent('—');
    expect(unavailable).toHaveTextContent('به جمع مخرج این نسبت تعلق ندارد');
    expect(unavailable).not.toHaveTextContent('۰');
  });
});

describe('quality is data readiness; performance is never assessed', () => {
  it('names the classification as data readiness and keeps the performance sentence', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    const card = await screen.findByTestId('kpi-quality-card');
    expect(card).toHaveTextContent('طبقه‌بندی زرد');
    expect(card).toHaveTextContent('هدف: تعریف نشده');
    expect(card).toHaveTextContent('عملکرد: ارزیابی نشده');
    expect(card).toHaveTextContent('عملکرد ارزیابی نشده');
  });
});

describe('provenance — the catalogue’s own wording, and the four honest counts', () => {
  it('carries the counts, the population and the cohort field the month was built from', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    expect(await screen.findByTestId('kpi-count-cohort')).toHaveTextContent('۴');
    expect(screen.getByTestId('kpi-count-valid')).toHaveTextContent('۳');
    expect(screen.getByTestId('kpi-count-excluded')).toHaveTextContent('۱');
    expect(screen.getByTestId('kpi-read-limit')).toHaveTextContent('۵۰۰۰');

    const context = screen.getByTestId('kpi-context-card');
    expect(context).toHaveTextContent('فهرست‌های مواد ارجاع‌شده در ماه.');
    // The cohort-field row belongs to the value card: it qualifies the NUMBER, not the story.
    expect(screen.getByTestId('kpi-value-card')).toHaveTextContent('ماه تصمیم');
    expect(screen.getByTestId('kpi-evidence')).toHaveTextContent('لاگ تصمیمات سامانه');
    expect(screen.getByTestId('kpi-known-limitations')).toHaveTextContent('دور دوم');
  });

  it('carries the authorization the value was served under', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    const governance = await screen.findByTestId('kpi-governance-card');
    expect(governance).toHaveTextContent('production.bom.read');
    // The formula-shape row belongs to the value card, next to the number it describes.
    expect(screen.getByTestId('kpi-value-card')).toHaveTextContent('میانگین مدت');
  });
});

describe('states — an unknown key, a failure, and no remit are three different things', () => {
  it('reads a 404 as “no such approved KPI”, with a way back to the list', async () => {
    fetchMock.mockRejectedValue(new CoreApiError('not found', 404));

    render(<KpiDetailView technicalKey="no-such-kpi" />);

    expect(
      await screen.findByText('چنین شاخصی در فهرست شاخص‌های مصوب وجود ندارد.')
    ).toBeInTheDocument();
    expect(screen.getByText('بازگشت به فهرست شاخص‌ها')).toHaveAttribute('href', '/admin/kpis');
  });

  it('renders a retryable error for a real failure', async () => {
    fetchMock.mockRejectedValue(new CoreApiError('downstream failed', 500));

    render(<KpiDetailView technicalKey={KEY} />);

    expect(
      await screen.findByText('دریافت شاخص با خطا مواجه شد. لطفاً دوباره تلاش کنید.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-value-card')).not.toBeInTheDocument();
  });

  it('issues no request and renders forbidden without one of the three remits', async () => {
    grant([]);
    authState();

    render(<KpiDetailView technicalKey={KEY} />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(historyMock).not.toHaveBeenCalled();
  });
});

describe('history — comparison, trend, meaning and the source report', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    historyMock.mockReset();
    historyMock.mockResolvedValue(history());
    grant(['production.bom.read']);
    authState();
  });

  it('fetches the default six months and renders the human comparison plus the target sentence', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    expect(historyMock).toHaveBeenCalledWith(KEY, { periodCount: 6 });

    const summary = await screen.findByTestId('kpi-comparison-summary');
    expect(summary).toHaveTextContent('مهر ۱۴۰۵');
    expect(summary).toHaveTextContent('آبان ۱۴۰۵');
    expect(summary).toHaveTextContent('کاهش');
    expect(summary).toHaveTextContent('ساعت');

    // The no-target sentence travels with every comparison — a verdict cannot form.
    expect(screen.getByTestId('kpi-comparison-target')).toHaveTextContent(
      'هدف عملکردی برای این شاخص هنوز تعریف نشده است'
    );
  });

  it('renders the honest trend: exact points, no gap when every month has a value', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    // All three points are server values rendered as text — the chart's accessible half.
    await screen.findByTestId('kpi-trend-chart-table');
    expect(screen.getByTestId('kpi-trend-chart-row-1405-6')).toHaveTextContent('شهریور ۱۴۰۵');
    expect(screen.getByTestId('kpi-trend-chart-row-1405-7')).toHaveTextContent('مهر ۱۴۰۵');
    expect(screen.getByTestId('kpi-trend-chart-row-1405-8')).toHaveTextContent('آبان ۱۴۰۵');
    // One polyline joins the three consecutive values — plotted from the same numbers.
    expect(screen.getByTestId('kpi-trend-chart-segment-0')).toBeInTheDocument();
    // No gap marker anywhere: every requested month produced a value.
    expect(screen.queryByTestId('kpi-trend-chart-gap-1405-6')).not.toBeInTheDocument();
  });

  it('marks a missing month as a gap — never a zero, never a bridge', async () => {
    fetchMock.mockResolvedValue(kpi());
    historyMock.mockResolvedValue(
      history({}, (jy, jm, value) =>
        kpi({
          value: jm === 7 ? null : value,
          availability: jm === 7 ? 'NOT_AVAILABLE' : 'AVAILABLE',
          unavailableReason: jm === 7 ? 'EMPTY_COHORT' : null,
          display:
            jm === 7 || value === null
              ? null
              : { value: value / 3600, unitToken: 'HOURS', unitLabelFa: 'ساعت' },
          period: {
            jy,
            jm,
            monthName: jm === 8 ? 'آبان' : jm === 7 ? 'مهر' : 'شهریور',
            start: '',
            end: '',
            timeZone: 'Asia/Tehran',
            calendar: 'JALALI',
            completed: true,
          },
        })
      )
    );

    render(<KpiDetailView technicalKey={KEY} />);

    // The gap marker stands where the line breaks, and the table names the absence.
    expect(await screen.findByTestId('kpi-trend-chart-gap-1405-7')).toBeInTheDocument();
    const gapRow = screen.getByTestId('kpi-trend-chart-row-1405-7');
    expect(gapRow).toHaveTextContent('—');
    expect(gapRow).toHaveTextContent('در دسترس نیست');
    // A single available point on each side of the gap is a dot, not a line.
    expect(screen.getByTestId('kpi-trend-chart-point-1405-6')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-trend-chart-point-1405-8')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-trend-chart-segment-0')).not.toBeInTheDocument();
  });

  it('links the drill-down to the governed source report — never to another KPI', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    const link = await screen.findByTestId('kpi-supporting-report-link');
    expect(link).toHaveAttribute('href', '/admin/reporting/production');
    expect(screen.getByTestId('kpi-report-link')).toHaveTextContent('مشاهده گزارش مبنا');
    expect(screen.getByTestId('kpi-report-link')).toHaveTextContent('نه به شاخص دیگری');
  });

  it('guides without guessing: formula, comparison rule, absence, direction and no target', async () => {
    fetchMock.mockResolvedValue(kpi());

    render(<KpiDetailView technicalKey={KEY} />);

    const guide = await screen.findByTestId('kpi-guide');
    expect(guide).toHaveTextContent('واحد درصد');
    expect(guide).toHaveTextContent('نه اینکه عدد صفر باشد');
    expect(guide).toHaveTextContent('هدف یا آستانه عملکردی برای این شاخص تعریف نشده است');
  });

  it('isolates a history outage: retryable there, value intact here', async () => {
    fetchMock.mockResolvedValue(kpi());
    historyMock.mockRejectedValue(new CoreApiError('history down', 500));

    render(<KpiDetailView technicalKey={KEY} />);

    expect(await screen.findByTestId('kpi-history-error')).toHaveTextContent(
      'دریافت تاریخچه شاخص با خطا مواجه شد'
    );
    expect(screen.getByTestId('kpi-detail-value')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-comparison')).not.toBeInTheDocument();
  });
});
