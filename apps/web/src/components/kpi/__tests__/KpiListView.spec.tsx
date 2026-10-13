import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KpiListView } from '../KpiListView';
import { fetchKpis } from '@/lib/kpi-api';
import {
  authState,
  comparison as comparisonFixture,
  grant,
  kpi,
  list,
  PERIOD,
} from './kpi-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/kpi-api', () => ({
  ...jest.requireActual('@/lib/kpi-api'),
  fetchKpis: jest.fn(),
}));

const fetchMock = fetchKpis as jest.MockedFunction<typeof fetchKpis>;

/**
 * Phase KPI-RUNTIME — what the KPI overview promises, as executable behaviour.
 *
 *  1. AUTHORIZATION — without one of the three read remits NO request is issued.
 *  2. VALUE HONESTY — every rendered figure is the payload's own, Persian-digits converted
 *     and nothing more; an unavailable KPI renders an em dash plus its reason, never `۰`.
 *  3. PERIOD HONESTY — the month on the label is the RESPONSE's `period`, not a browser
 *     clock, and moving a month sends `jy`/`jm` to the server rather than filtering locally.
 *  4. QUALITY ≠ PERFORMANCE — the readiness word is labelled as data, and the performance
 *     sentence is always present.
 *  5. STATES — forbidden, error and empty are three different things.
 *
 * The fixture shapes live in `./kpi-fixtures` — one `KpiResult` builder for both KPI specs,
 * so a contract change is a type error in one place.
 */

// Each test states its own permission set and its own payload, so the fetch mock is cleared
// between them — a `mockResolvedValue` left behind by a previous case would otherwise let a
// later test pass against data it never asked for.
beforeEach(() => {
  fetchMock.mockReset();
});

describe('authorization — a request is only worth issuing for a remit holder', () => {
  it('issues NO request and renders forbidden without one of the three remits', async () => {
    grant([]);
    authState();
    fetchMock.mockResolvedValue(list([kpi()]));

    render(<KpiListView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['production.bom.read', 'commerce.read', 'financial.check.read'])(
    'fetches for the remit %s — all three domains the catalogue reads from',
    async (remit) => {
      grant([remit]);
      authState();
      fetchMock.mockResolvedValue(list([kpi()]));

      render(<KpiListView />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    }
  );
});

describe('value honesty — the payload is rendered, never re-derived', () => {
  it('renders the authorised display conversion in Persian digits', async () => {
    grant(['production.bom.read']);
    authState();
    fetchMock.mockResolvedValue(list([kpi()]));

    render(<KpiListView />);

    expect(
      await screen.findByTestId('kpi-value-production-bom-decision-cycle-time')
    ).toHaveTextContent('۹ ساعت');
  });

  it('falls back to the governed value in its semantic unit when no conversion exists', async () => {
    grant(['production.bom.read']);
    authState();
    fetchMock.mockResolvedValue(list([kpi({ display: null })]));

    render(<KpiListView />);

    expect(
      await screen.findByTestId('kpi-value-production-bom-decision-cycle-time')
    ).toHaveTextContent('۳۲۴۰۰ ثانیه');
  });

  it('renders an em dash plus the reason for an unavailable KPI — never a zero', async () => {
    grant(['production.bom.read']);
    authState();
    fetchMock.mockResolvedValue(
      list([
        kpi({
          availability: 'NOT_AVAILABLE',
          unavailableReason: 'EMPTY_COHORT',
          value: null,
          display: null,
        }),
      ])
    );

    render(<KpiListView />);

    const unavailable = await screen.findByTestId(
      'kpi-unavailable-production-bom-decision-cycle-time'
    );
    expect(unavailable).toHaveTextContent('—');
    expect(unavailable).toHaveTextContent('هیچ موردی از این شاخص ثبت نشده است');
    // The digit must never appear where the finding "nothing existed" belongs.
    expect(unavailable).not.toHaveTextContent('۰');
  });
});

describe('period intelligence — each card carries its delta and its month', () => {
  beforeEach(() => {
    grant(['production.bom.read']);
    authState();
  });

  it('renders the server-computed comparison delta in neutral words, never a verdict', async () => {
    fetchMock.mockResolvedValue(list([kpi()]));

    render(<KpiListView />);

    // The fixture comparison: -3600 s → summarised through the server's own fields.
    const delta = await screen.findByTestId('kpi-comparison-production-bom-decision-cycle-time');
    expect(delta).toHaveTextContent('مهر ۱۴۰۵');
    expect(delta).toHaveTextContent('آبان ۱۴۰۵');
    expect(delta).toHaveTextContent('کاهش');
    // Neutral presentation: the direction is movement, not a colour-coded grade.
    expect(delta.closest('p')?.className ?? '').not.toMatch(/emerald|green|red|destructive/);
  });

  it('renders the unavailable comparison as a reason — and the card period beside it', async () => {
    fetchMock.mockResolvedValue(
      list(
        [
          kpi({
            availability: 'NOT_AVAILABLE',
            unavailableReason: 'EMPTY_COHORT',
            value: null,
            display: null,
          }),
        ],
        5,
        { comparisons: { 'production-bom-decision-cycle-time': null } }
      )
    );

    render(<KpiListView />);

    // A null comparison (the calendar floor) renders NO delta line at all.
    await screen.findByTestId('kpi-unavailable-production-bom-decision-cycle-time');
    expect(
      screen.queryByTestId('kpi-comparison-production-bom-decision-cycle-time')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('kpi-comparison-unavailable-production-bom-decision-cycle-time')
    ).not.toBeInTheDocument();
  });

  it('names the comparison absence when the server marks it unavailable', async () => {
    fetchMock.mockResolvedValue(
      list([kpi()], 5, {
        comparisons: {
          'production-bom-decision-cycle-time': comparisonFixture({
            availability: 'NOT_AVAILABLE',
            unavailableReason: 'PREVIOUS_NOT_AVAILABLE',
            currentValue: 32_400,
            previousValue: null,
            absoluteChange: null,
            direction: null,
          }),
        },
      })
    );

    render(<KpiListView />);

    const absent = await screen.findByTestId(
      'kpi-comparison-unavailable-production-bom-decision-cycle-time'
    );
    expect(absent).toHaveTextContent('بازه مقایسه عددی ندارد');
  });

  it('marks a partial month as در جریان rather than a completed business month', async () => {
    fetchMock.mockResolvedValue(list([kpi({ period: { ...PERIOD, completed: false } })]));

    render(<KpiListView />);

    const card = await screen.findByTestId('kpi-card-production-bom-decision-cycle-time');
    expect(card).toHaveTextContent('در جریان');
  });
});

describe('period honesty — the label is the server’s month, and paging goes to the server', () => {
  beforeEach(() => {
    grant(['production.bom.read']);
    authState();
    fetchMock.mockResolvedValue(list([kpi()]));
  });

  it('labels the month from the RESPONSE period, never a browser clock', async () => {
    render(<KpiListView />);

    // The label resolves only once the SERVER's period arrives — until then the picker shows
    // a dash, because there is no month to name yet.
    await screen.findByTestId('kpi-period-label');
    const labels = await screen.findAllByText('آبان ۱۴۰۵');
    expect(labels.length).toBeGreaterThan(0);
    expect(screen.getByTestId('kpi-period-label')).toHaveTextContent('آبان ۱۴۰۵');
  });

  it('asks the server for the neighbouring month instead of filtering locally', async () => {
    render(<KpiListView />);
    await screen.findByTestId('kpi-period-label');

    await userEvent.click(screen.getByTestId('kpi-next-month'));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith({ jy: 1405, jm: 9 }));

    await userEvent.click(screen.getByTestId('kpi-prev-month'));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith({ jy: 1405, jm: 7 }));
  });

  it('returns to the server’s current month by sending an empty period again', async () => {
    render(<KpiListView />);
    await screen.findByTestId('kpi-period-label');

    await userEvent.click(screen.getByTestId('kpi-next-month'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByTestId('kpi-current-month'));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith({}));
  });

  it('states how many of the approved catalogue this caller may read', async () => {
    fetchMock.mockResolvedValue(
      list([kpi(), kpi({ technicalKey: 'commerce-purchase-cycle-time' })])
    );

    render(<KpiListView />);

    expect(await screen.findByTestId('kpi-visibility')).toHaveTextContent('۲ از ۵');
  });
});

describe('quality is never read as performance', () => {
  it('labels readiness as data and always prints the performance sentence', async () => {
    grant(['production.bom.read']);
    authState();
    fetchMock.mockResolvedValue(list([kpi()]));

    render(<KpiListView />);

    const card = await screen.findByTestId('kpi-card-production-bom-decision-cycle-time');
    expect(card).toHaveTextContent('داده: ناقص');
    expect(card).toHaveTextContent('عملکرد ارزیابی نشده');
    expect(card).toHaveTextContent('هدف و آستانه برای این شاخص تعریف نشده');
  });
});

describe('states — forbidden, error and empty are three different things', () => {
  it('offers a retry on failure without pretending the catalogue is empty', async () => {
    grant(['production.bom.read']);
    authState();
    fetchMock.mockRejectedValue(new Error('network down'));

    render(<KpiListView />);

    expect(
      await screen.findByText('دریافت شاخص‌ها با خطا مواجه شد. لطفاً دوباره تلاش کنید.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-list-empty')).not.toBeInTheDocument();
  });

  it('renders the empty state only when the API actually returned no items', async () => {
    grant(['production.bom.read']);
    authState();
    fetchMock.mockResolvedValue(list([]));

    render(<KpiListView />);

    expect(await screen.findByTestId('kpi-list-empty')).toBeInTheDocument();
    expect(screen.queryByText(/خطا مواجه شد/)).not.toBeInTheDocument();
  });
});
