import { render, screen, waitFor } from '@testing-library/react';

import { CheckRequestTimeline } from '../CheckRequestTimeline';
import { fetchFinancialCheckRequestTimeline } from '@/lib/financial-api';

jest.mock('@/lib/financial-api', () => ({
  ...jest.requireActual('@/lib/financial-api'),
  fetchFinancialCheckRequestTimeline: jest.fn(),
}));

const timelineMock = fetchFinancialCheckRequestTimeline as jest.MockedFunction<
  typeof fetchFinancialCheckRequestTimeline
>;

/**
 * Phase F1 — FINANCIAL FOUNDATION: the audit timeline («سابقه گردش فرآیند»).
 *
 * WHAT THESE SPECS PIN: the events render with the Persian verb and the row's own date, an
 * EMPTY trail is a legitimate empty state, an OUTAGE is an ERROR with retry (never an
 * empty list — "nothing recorded" and "we could not ask" must be different screens), and
 * only the audit endpoint is asked — the source's `CheckHistory` is never reconstructed
 * locally.
 */

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Phase F1 — CheckRequestTimeline', () => {
  it('renders the recorded events with the Persian verb, in the order returned', async () => {
    timelineMock.mockResolvedValue({
      items: [
        {
          id: 'a-1',
          action: 'create',
          actorId: 'u-1',
          success: true,
          reason: null,
          changedFields: ['status'],
          createdAt: '2026-10-03T08:00:00.000Z',
        },
        {
          id: 'a-2',
          action: 'submit',
          actorId: 'u-1',
          success: true,
          reason: null,
          changedFields: ['status'],
          createdAt: '2026-10-03T09:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 2,
    });

    render(<CheckRequestTimeline requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('financial-timeline-row-create')).toHaveTextContent(
      'ایجاد درخواست'
    );
    expect(screen.getByTestId('financial-timeline-row-submit')).toHaveTextContent(
      'ارجاع برای تصمیم مدیر'
    );
    expect(screen.getAllByTestId('financial-timeline-actor')).toHaveLength(2);
    expect(timelineMock).toHaveBeenCalledWith(REQUEST_ID, { page: 1, pageSize: 20 });
  });

  it('answers an EMPTY trail with the empty state, not an error', async () => {
    timelineMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
    render(<CheckRequestTimeline requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('financial-timeline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-timeline-error')).not.toBeInTheDocument();
  });

  it('renders an OUTAGE as an error with a retry control — never an empty list', async () => {
    timelineMock.mockRejectedValueOnce(new Error('تاریخچه در دسترس نیست'));
    timelineMock.mockResolvedValueOnce({ items: [], page: 1, pageSize: 20, total: 0 });

    render(<CheckRequestTimeline requestId={REQUEST_ID} />);

    const errorBox = await screen.findByTestId('financial-timeline-error');
    expect(errorBox).toHaveTextContent('تاریخچه در دسترس نیست');
    // The retry control exists inside the error state (CoreError renders it).
    await waitFor(() => expect(errorBox.querySelector('button')).not.toBeNull());
  });

  it('renders neither list nor empty state before the first answer (loading)', () => {
    timelineMock.mockReturnValue(new Promise(() => undefined) as never);
    render(<CheckRequestTimeline requestId={REQUEST_ID} />);

    expect(screen.queryByTestId('financial-timeline-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-timeline-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-timeline-error')).not.toBeInTheDocument();
  });
});
