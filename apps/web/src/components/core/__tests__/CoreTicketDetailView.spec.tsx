import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreTicketDetailView } from '../CoreTicketDetailView';
import { CoreApiError } from '@/lib/core-http';
import {
  addTicketComment,
  changeTicketStatus,
  getTicket,
  getTicketAttachmentDownload,
  listTicketComments,
  submitTicketSatisfaction,
  uploadTicketAttachment,
  type TicketComment,
  type TicketDetail,
} from '@/lib/support-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/support/t1',
}));

jest.mock('@/lib/support-api', () => ({
  ...jest.requireActual('@/lib/support-api'),
  getTicket: jest.fn(),
  listTicketComments: jest.fn(),
  addTicketComment: jest.fn(),
  changeTicketStatus: jest.fn(),
  submitTicketSatisfaction: jest.fn(),
  getTicketAttachmentDownload: jest.fn(),
  uploadTicketAttachment: jest.fn(),
}));

const getMock = getTicket as jest.MockedFunction<typeof getTicket>;
const commentsMock = listTicketComments as jest.MockedFunction<typeof listTicketComments>;
const addCommentMock = addTicketComment as jest.MockedFunction<typeof addTicketComment>;
const statusMock = changeTicketStatus as jest.MockedFunction<typeof changeTicketStatus>;
const satisfactionMock = submitTicketSatisfaction as jest.MockedFunction<
  typeof submitTicketSatisfaction
>;
const uploadMock = uploadTicketAttachment as jest.MockedFunction<typeof uploadTicketAttachment>;
const downloadMock = getTicketAttachmentDownload as jest.MockedFunction<
  typeof getTicketAttachmentDownload
>;

/**
 * Builds a real `File`. jsdom supports the constructor, so the component's size/MIME
 * checks run against a genuine object rather than a hand-rolled stand-in.
 */
function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  // `size` is derived from the blob parts and read-only; redefine it so an oversized
  // file can be simulated without allocating 10 MB in the test process.
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function person(id: string) {
  return { id, firstName: 'بهار', lastName: 'نوری', avatarUrl: null, jobTitle: null };
}

function detail(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: 't1',
    trackingNumber: 'TK-ABCDEFGHJK',
    type: 'SUPPORT',
    priority: 'NORMAL',
    status: 'NEW',
    subject: 'موضوع تیکت',
    body: 'متن تیکت',
    category: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    requester: person('u1'),
    assignee: null,
    canManage: false,
    availableTransitions: [],
    attachments: [],
    statusHistory: [
      {
        id: 'h1',
        fromStatus: null,
        toStatus: 'NEW',
        note: null,
        createdAt: '2026-08-29T10:00:00.000Z',
        changedBy: person('u1'),
      },
    ],
    satisfaction: null,
    ...overrides,
  };
}

function comment(overrides: Partial<TicketComment> = {}): TicketComment {
  return {
    id: 'c1',
    ticketId: 't1',
    body: 'پاسخ کارشناس',
    isInternal: false,
    createdAt: '2026-08-29T11:00:00.000Z',
    author: person('u2'),
    attachments: [],
    ...overrides,
  };
}

describe('CoreTicketDetailView', () => {
  beforeEach(() => {
    commentsMock.mockResolvedValue({ items: [], hasMore: false });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state first', () => {
    getMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreTicketDetailView ticketId="t1" />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('در حال بارگذاری تیکت...')).toBeInTheDocument();
  });

  it('renders the ticket, its tracking number and its lifecycle trail', async () => {
    getMock.mockResolvedValue(detail());

    render(<CoreTicketDetailView ticketId="t1" />);

    expect(await screen.findByText('موضوع تیکت')).toBeInTheDocument();
    expect(screen.getByText('TK-ABCDEFGHJK')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-history')).toHaveTextContent('ایجاد تیکت');
  });

  it('renders one identical not-found state for a missing or foreign ticket', async () => {
    getMock.mockRejectedValue(new CoreApiError('Ticket not found', 404));

    render(<CoreTicketDetailView ticketId="t1" />);

    expect(await screen.findByTestId('ticket-not-found')).toBeInTheDocument();
  });

  it('renders a forbidden state on 403', async () => {
    getMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<CoreTicketDetailView ticketId="t1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('دسترسی ندارید');
  });

  /**
   * `canManage` and `availableTransitions` are computed server-side, so the controls
   * are driven entirely by them — the client never decides who is an agent.
   */
  it('offers no agent controls to a requester', async () => {
    getMock.mockResolvedValue(detail({ canManage: false, availableTransitions: [] }));

    render(<CoreTicketDetailView ticketId="t1" />);

    await screen.findByText('موضوع تیکت');
    expect(screen.queryByTestId('ticket-transitions')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/یادداشت داخلی/)).not.toBeInTheDocument();
  });

  it('offers exactly the transitions the server reported, and nothing else', async () => {
    getMock.mockResolvedValue(
      detail({ canManage: true, status: 'RESOLVED', availableTransitions: ['CLOSED'] }),
    );

    render(<CoreTicketDetailView ticketId="t1" />);

    const panel = await screen.findByTestId('ticket-transitions');
    expect(panel).toHaveTextContent('بسته‌شده');
    expect(panel).not.toHaveTextContent('در حال بررسی');
  });

  it('sends the chosen transition and reloads', async () => {
    getMock.mockResolvedValue(
      detail({ canManage: true, status: 'RESOLVED', availableTransitions: ['CLOSED'] }),
    );
    statusMock.mockResolvedValue(detail({ status: 'CLOSED' }));

    render(<CoreTicketDetailView ticketId="t1" />);
    await screen.findByTestId('ticket-transitions');

    await userEvent.click(screen.getByRole('button', { name: 'بسته‌شده' }));

    await waitFor(() => expect(statusMock).toHaveBeenCalledWith('t1', { status: 'CLOSED' }));
  });

  it('posts a requester reply without an isInternal flag', async () => {
    getMock.mockResolvedValue(detail());
    addCommentMock.mockResolvedValue(comment());

    render(<CoreTicketDetailView ticketId="t1" />);
    await screen.findByTestId('ticket-reply');

    await userEvent.type(screen.getByLabelText('ثبت پاسخ'), 'پاسخ من');
    await userEvent.click(screen.getByRole('button', { name: 'ارسال پاسخ' }));

    await waitFor(() => expect(addCommentMock).toHaveBeenCalledWith('t1', { body: 'پاسخ من' }));
  });

  it('lets an agent mark a reply as internal', async () => {
    getMock.mockResolvedValue(detail({ canManage: true }));
    addCommentMock.mockResolvedValue(comment({ isInternal: true }));

    render(<CoreTicketDetailView ticketId="t1" />);
    await screen.findByTestId('ticket-reply');

    await userEvent.type(screen.getByLabelText('ثبت پاسخ'), 'یادداشت');
    await userEvent.click(screen.getByLabelText(/یادداشت داخلی/));
    await userEvent.click(screen.getByRole('button', { name: 'ارسال پاسخ' }));

    await waitFor(() =>
      expect(addCommentMock).toHaveBeenCalledWith('t1', { body: 'یادداشت', isInternal: true }),
    );
  });

  it('hides the reply form on a closed ticket and explains why', async () => {
    getMock.mockResolvedValue(
      detail({
        status: 'CLOSED',
        resolvedAt: '2026-08-29T12:00:00.000Z',
        closedAt: '2026-08-29T12:30:00.000Z',
      }),
    );

    render(<CoreTicketDetailView ticketId="t1" />);

    await screen.findByText('موضوع تیکت');
    expect(screen.queryByTestId('ticket-reply')).not.toBeInTheDocument();
    expect(screen.getByText(/بسته شده است/)).toBeInTheDocument();
  });

  it('offers satisfaction only to the requester on a resolved ticket', async () => {
    getMock.mockResolvedValue(
      detail({ status: 'RESOLVED', resolvedAt: '2026-08-29T12:00:00.000Z' }),
    );
    satisfactionMock.mockResolvedValue({
      id: 's1',
      rating: 5,
      comment: null,
      createdAt: '2026-08-29T13:00:00.000Z',
    });

    render(<CoreTicketDetailView ticketId="t1" />);

    expect(await screen.findByTestId('ticket-satisfaction')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'ثبت بازخورد' }));

    await waitFor(() => expect(satisfactionMock).toHaveBeenCalledWith('t1', { rating: 5 }));
  });

  it('does not offer satisfaction once it has been submitted', async () => {
    getMock.mockResolvedValue(
      detail({
        status: 'RESOLVED',
        resolvedAt: '2026-08-29T12:00:00.000Z',
        satisfaction: {
          id: 's1',
          rating: 4,
          comment: 'خوب بود',
          createdAt: '2026-08-29T13:00:00.000Z',
        },
      }),
    );

    render(<CoreTicketDetailView ticketId="t1" />);

    expect(await screen.findByTestId('ticket-satisfaction-result')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-satisfaction')).not.toBeInTheDocument();
  });

  it('marks an internal note in the thread so it cannot be mistaken for a public reply', async () => {
    getMock.mockResolvedValue(detail({ canManage: true }));
    commentsMock.mockResolvedValue({
      items: [comment({ id: 'c1', isInternal: true, body: 'یادداشت داخلی' })],
      hasMore: false,
    });

    render(<CoreTicketDetailView ticketId="t1" />);

    const row = await screen.findByTestId('ticket-comment');
    expect(row).toHaveAttribute('data-internal', 'true');
    expect(row).toHaveTextContent('یادداشت داخلی');
  });

  // Phase 49G-2: attachment UI.
  describe('attachments', () => {
    const validFile = () => makeFile('report.pdf', 'application/pdf', 2048);

    const withAttachment = () =>
      detail({
        attachments: [
          {
            id: 'a1',
            fileName: 'report.pdf',
            mimeType: 'application/pdf',
            size: 2048,
            commentId: 'c1',
          },
        ],
      });

    it('offers a file picker on an open ticket', async () => {
      getMock.mockResolvedValue(detail());

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      const input = screen.getByTestId('ticket-attachment-input');
      expect(input).toHaveAttribute('type', 'file');
      // `accept` must not be a superset of what the backend allows.
      expect(input.getAttribute('accept')).toContain('application/pdf');
      expect(input.getAttribute('accept')).not.toContain('image/svg');
    });

    it('does not offer the picker on a closed ticket', async () => {
      getMock.mockResolvedValue(detail({ status: 'CLOSED', closedAt: '2026-08-29T12:30:00.000Z' }));

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByText('موضوع تیکت');

      expect(screen.queryByTestId('ticket-attachment-input')).not.toBeInTheDocument();
    });

    it('shows the selected filename and size before uploading anything', async () => {
      getMock.mockResolvedValue(detail());

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      await userEvent.upload(screen.getByTestId('ticket-attachment-input'), validFile());

      const selected = await screen.findByTestId('ticket-attachment-selected');
      expect(selected).toHaveTextContent('report.pdf');
      expect(selected).toHaveTextContent('کیلوبایت');
      // Selection alone must not touch the network.
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('rejects a file over 10MB client-side without calling the API', async () => {
      getMock.mockResolvedValue(detail());

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      const tooBig = makeFile('huge.pdf', 'application/pdf', 10 * 1024 * 1024 + 1);
      await userEvent.upload(screen.getByTestId('ticket-attachment-input'), tooBig);

      expect(await screen.findByTestId('ticket-attachment-error')).toHaveTextContent(
        /حجم فایل بیشتر/,
      );
      expect(screen.queryByTestId('ticket-attachment-selected')).not.toBeInTheDocument();
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('rejects a disallowed MIME type client-side without calling the API', async () => {
      getMock.mockResolvedValue(detail());

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      // SVG is excluded server-side because it is an executable document.
      // `applyAccept: false` bypasses the `accept` filter deliberately: `accept` is a
      // picker hint a real user can defeat (drag-and-drop, "all files"), so the
      // JS-level check is what actually has to hold.
      const svg = makeFile('logo.svg', 'image/svg+xml', 512);
      await userEvent.upload(screen.getByTestId('ticket-attachment-input'), svg, {
        applyAccept: false,
      });

      expect(await screen.findByTestId('ticket-attachment-error')).toHaveTextContent(
        'نوع این فایل پذیرفته نمی‌شود.',
      );
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('uploads the selected file and reports success', async () => {
      getMock.mockResolvedValue(detail());
      uploadMock.mockResolvedValue({
        id: 'a1',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        size: 2048,
      });

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      await userEvent.upload(screen.getByTestId('ticket-attachment-input'), validFile());
      await userEvent.click(screen.getByRole('button', { name: 'بارگذاری فایل' }));

      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
      // Only the ticket id and the file itself — no tenant, uploader or storage key.
      expect(uploadMock.mock.calls[0][0]).toBe('t1');
      expect(uploadMock.mock.calls[0][1]).toBeInstanceOf(File);

      expect(await screen.findByTestId('ticket-attachment-notice')).toBeInTheDocument();
      const pending = await screen.findByTestId('ticket-attachment-pending');
      expect(pending).toHaveTextContent('report.pdf');
      expect(pending).toHaveTextContent('PDF');
    });

    it('surfaces an upload failure and keeps nothing pending', async () => {
      getMock.mockResolvedValue(detail());
      uploadMock.mockRejectedValue(new CoreApiError('نوع فایل مجاز نیست', 400));

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      await userEvent.upload(screen.getByTestId('ticket-attachment-input'), validFile());
      await userEvent.click(screen.getByRole('button', { name: 'بارگذاری فایل' }));

      expect(await screen.findByTestId('ticket-attachment-error')).toHaveTextContent(
        'نوع فایل مجاز نیست',
      );
      expect(screen.queryByTestId('ticket-attachment-pending')).not.toBeInTheDocument();
    });

    it('lets the user drop a selected file before it is uploaded', async () => {
      getMock.mockResolvedValue(detail());

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      await userEvent.upload(screen.getByTestId('ticket-attachment-input'), validFile());
      await screen.findByTestId('ticket-attachment-selected');

      await userEvent.click(screen.getByRole('button', { name: 'حذف انتخاب' }));

      expect(screen.queryByTestId('ticket-attachment-selected')).not.toBeInTheDocument();
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('claims the uploaded attachment when the reply is submitted', async () => {
      getMock.mockResolvedValue(detail());
      uploadMock.mockResolvedValue({
        id: 'a1',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        size: 2048,
      });
      addCommentMock.mockResolvedValue(comment());

      render(<CoreTicketDetailView ticketId="t1" />);
      await screen.findByTestId('ticket-reply');

      await userEvent.upload(screen.getByTestId('ticket-attachment-input'), validFile());
      await userEvent.click(screen.getByRole('button', { name: 'بارگذاری فایل' }));
      await screen.findByTestId('ticket-attachment-pending');

      await userEvent.type(screen.getByLabelText('ثبت پاسخ'), 'با فایل');
      await userEvent.click(screen.getByRole('button', { name: 'ارسال پاسخ' }));

      await waitFor(() =>
        expect(addCommentMock).toHaveBeenCalledWith('t1', {
          body: 'با فایل',
          attachmentIds: ['a1'],
        }),
      );
    });

    it('lists bound ticket attachments with safe metadata only', async () => {
      getMock.mockResolvedValue(withAttachment());

      render(<CoreTicketDetailView ticketId="t1" />);

      const row = await screen.findByTestId('ticket-attachment-row');
      expect(row).toHaveTextContent('report.pdf');
      expect(row).toHaveTextContent('PDF');
      expect(row).toHaveTextContent('کیلوبایت');
      // Never rendered: the internal object path.
      expect(row.textContent).not.toContain('support/');
    });

    it('resolves a download through the authorized route rather than embedding a URL', async () => {
      getMock.mockResolvedValue(withAttachment());
      downloadMock.mockResolvedValue({
        url: 'https://storage.example/signed',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
      });

      const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);

      render(<CoreTicketDetailView ticketId="t1" />);

      await userEvent.click(await screen.findByRole('button', { name: 'report.pdf' }));

      await waitFor(() => expect(downloadMock).toHaveBeenCalledWith('a1'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://storage.example/signed',
        '_blank',
        'noopener,noreferrer',
      );
      // The signed URL must never be present in the markup itself.
      expect(document.body.innerHTML).not.toContain('storage.example');

      openSpy.mockRestore();
    });

    it('gives the download action a touch-sized target', async () => {
      getMock.mockResolvedValue(withAttachment());

      render(<CoreTicketDetailView ticketId="t1" />);

      const action = await screen.findByRole('button', { name: 'report.pdf' });
      expect(action.className).toContain('min-h-[2rem]');
    });
  });
});
