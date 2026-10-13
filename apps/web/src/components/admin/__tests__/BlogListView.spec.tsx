import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlogListView } from '../BlogListView';
import {
  AdminBlogListItem,
  CmsApiError,
  archivePost,
  deletePost,
  listAdminPosts,
  listTrashedPosts,
  restorePost,
} from '@/lib/cms-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/blog',
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. Everything except the network call stays real.
jest.mock('@/lib/cms-api', () => ({
  ...jest.requireActual('@/lib/cms-api'),
  listAdminPosts: jest.fn(),
  listTrashedPosts: jest.fn(),
  archivePost: jest.fn(),
  deletePost: jest.fn(),
  restorePost: jest.fn(),
}));

const listAdminPostsMock = listAdminPosts as jest.MockedFunction<typeof listAdminPosts>;
const listTrashedPostsMock = listTrashedPosts as jest.MockedFunction<typeof listTrashedPosts>;
const archivePostMock = archivePost as jest.MockedFunction<typeof archivePost>;
const deletePostMock = deletePost as jest.MockedFunction<typeof deletePost>;
const restorePostMock = restorePost as jest.MockedFunction<typeof restorePost>;

function post(overrides: Partial<AdminBlogListItem> = {}): AdminBlogListItem {
  return {
    id: 'post-1',
    title: 'اولین مطلب',
    slug: 'first-post',
    excerpt: null,
    publishedAt: null,
    status: 'DRAFT',
    readingTimeMin: 3,
    featuredImageId: null,
    authorId: 'user-1',
    ...overrides,
  };
}

describe('BlogListView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('loads posts with the default DRAFT status', async () => {
    listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });

    render(<BlogListView />);

    expect(await screen.findByText('اولین مطلب')).toBeInTheDocument();
    expect(screen.getByText('first-post')).toBeInTheDocument();
    expect(listAdminPostsMock).toHaveBeenCalledWith({ status: 'DRAFT', cursor: undefined });
  });

  it('renders the empty state when no posts exist', async () => {
    listAdminPostsMock.mockResolvedValue({ items: [], hasMore: false });

    render(<BlogListView />);

    expect(await screen.findByText(/یافت نشد/)).toBeInTheDocument();
  });

  it('renders an error state when the API fails', async () => {
    listAdminPostsMock.mockRejectedValue(new CmsApiError(500, 'INTERNAL_SERVER_ERROR', 'خطای سرور'));

    render(<BlogListView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('خطای سرور');
  });

  it('renders a forbidden message on 403', async () => {
    listAdminPostsMock.mockRejectedValue(
      new CmsApiError(403, 'FORBIDDEN', 'شما اجازه دسترسی به این بخش را ندارید.'),
    );

    render(<BlogListView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('اجازه دسترسی');
  });

  it('refetches using the selected status', async () => {
    listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });

    render(<BlogListView />);
    await screen.findByText('اولین مطلب');

    listAdminPostsMock.mockResolvedValue({
      items: [post({ id: 'post-2', title: 'مطلب منتشرشده', status: 'PUBLISHED' })],
      hasMore: false,
    });

    await userEvent.selectOptions(screen.getByLabelText(/وضعیت/), 'PUBLISHED');

    await waitFor(() =>
      expect(listAdminPostsMock).toHaveBeenLastCalledWith({ status: 'PUBLISHED', cursor: undefined }),
    );
    expect(await screen.findByText('مطلب منتشرشده')).toBeInTheDocument();
  });

  it('paginates forward using the last item id as cursor', async () => {
    listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: true });

    render(<BlogListView />);
    await screen.findByText('اولین مطلب');

    listAdminPostsMock.mockResolvedValue({
      items: [post({ id: 'post-9', title: 'صفحه دوم' })],
      hasMore: false,
    });

    await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));

    await waitFor(() =>
      expect(listAdminPostsMock).toHaveBeenLastCalledWith({ status: 'DRAFT', cursor: 'post-1' }),
    );
    expect(await screen.findByText('صفحه دوم')).toBeInTheDocument();
  });

  describe('row workflow actions', () => {
    let confirmSpy: jest.SpyInstance<boolean, [message?: string]>;

    beforeEach(() => {
      confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    });

    afterEach(() => {
      confirmSpy.mockRestore();
    });

    // Archive is only a legal transition from PUBLISHED
    // (BlogService.isValidTransition), so it must not be offered on a DRAFT row.
    it('hides Archive for a non-publishable status and shows it for PUBLISHED', async () => {
      listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });
      const { unmount } = render(<BlogListView />);
      await screen.findByText('اولین مطلب');
      expect(screen.queryByRole('button', { name: 'بایگانی' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'حذف' })).toBeInTheDocument();
      unmount();

      listAdminPostsMock.mockResolvedValue({
        items: [post({ status: 'PUBLISHED' })],
        hasMore: false,
      });
      render(<BlogListView />);
      await screen.findByText('اولین مطلب');
      expect(screen.getByRole('button', { name: 'بایگانی' })).toBeInTheDocument();
    });

    it('archives a published post and refetches the current page', async () => {
      listAdminPostsMock.mockResolvedValue({
        items: [post({ status: 'PUBLISHED' })],
        hasMore: false,
      });
      archivePostMock.mockResolvedValue({} as never);

      render(<BlogListView />);
      await screen.findByText('اولین مطلب');

      // Archive soft-deletes the row, so it disappears from every status list.
      listAdminPostsMock.mockResolvedValue({ items: [], hasMore: false });
      await userEvent.click(screen.getByRole('button', { name: 'بایگانی' }));

      await waitFor(() => expect(archivePostMock).toHaveBeenCalledWith('post-1'));
      expect(confirmSpy).toHaveBeenCalled();
      expect(await screen.findByText('مطلب بایگانی شد.')).toBeInTheDocument();
      await waitFor(() => expect(listAdminPostsMock).toHaveBeenCalledTimes(2));
      // The status filter itself is untouched by a row action; only the page is
      // re-fetched.
      expect(listAdminPostsMock).toHaveBeenLastCalledWith({
        status: 'DRAFT',
        cursor: undefined,
      });
    });

    it('does not call the API when the confirm dialog is dismissed', async () => {
      confirmSpy.mockReturnValue(false);
      listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });

      render(<BlogListView />);
      await screen.findByText('اولین مطلب');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      expect(deletePostMock).not.toHaveBeenCalled();
      expect(listAdminPostsMock).toHaveBeenCalledTimes(1);
    });

    it('deletes a post and refetches the list', async () => {
      listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });
      deletePostMock.mockResolvedValue({} as never);

      render(<BlogListView />);
      await screen.findByText('اولین مطلب');

      listAdminPostsMock.mockResolvedValue({ items: [], hasMore: false });
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('post-1'));
      expect(await screen.findByText('مطلب حذف شد.')).toBeInTheDocument();
      await waitFor(() => expect(listAdminPostsMock).toHaveBeenCalledTimes(2));
    });

    // The frontend has no permission metadata; authorization is decided by the
    // API, so a 403 must be surfaced instead of being swallowed.
    it('surfaces a 403 from delete without dropping the row', async () => {
      listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });
      deletePostMock.mockRejectedValue(
        new CmsApiError(403, 'FORBIDDEN', 'شما اجازه حذف این مطلب را ندارید.'),
      );

      render(<BlogListView />);
      await screen.findByText('اولین مطلب');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      expect(await screen.findByText('شما اجازه حذف این مطلب را ندارید.')).toBeInTheDocument();
      expect(screen.getByText('اولین مطلب')).toBeInTheDocument();
      expect(listAdminPostsMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces a 404 from delete as an already-removed message', async () => {
      listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });
      deletePostMock.mockRejectedValue(new CmsApiError(404, 'NOT_FOUND', 'Post not found'));

      render(<BlogListView />);
      await screen.findByText('اولین مطلب');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      expect(await screen.findByText(/پیش‌تر حذف شده است/)).toBeInTheDocument();
    });

    it('surfaces a 403 from archive', async () => {
      listAdminPostsMock.mockResolvedValue({
        items: [post({ status: 'PUBLISHED' })],
        hasMore: false,
      });
      archivePostMock.mockRejectedValue(
        new CmsApiError(403, 'FORBIDDEN', 'شما اجازه بایگانی این مطلب را ندارید.'),
      );

      render(<BlogListView />);
      await screen.findByText('اولین مطلب');
      await userEvent.click(screen.getByRole('button', { name: 'بایگانی' }));

      expect(await screen.findByText('شما اجازه بایگانی این مطلب را ندارید.')).toBeInTheDocument();
    });

    it('keeps the selected status filter after a row action', async () => {
      listAdminPostsMock.mockResolvedValue({
        items: [post({ status: 'PUBLISHED' })],
        hasMore: false,
      });
      deletePostMock.mockResolvedValue({} as never);

      render(<BlogListView />);
      await screen.findByText('اولین مطلب');
      await userEvent.selectOptions(screen.getByLabelText(/وضعیت/), 'PUBLISHED');
      await waitFor(() =>
        expect(listAdminPostsMock).toHaveBeenLastCalledWith({
          status: 'PUBLISHED',
          cursor: undefined,
        }),
      );

      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('post-1'));
      expect(screen.getByLabelText(/وضعیت/)).toHaveValue('PUBLISHED');
      expect(listAdminPostsMock).toHaveBeenLastCalledWith({
        status: 'PUBLISHED',
        cursor: undefined,
      });
    });
  });

  /**
   * Phase 34H. Archive stamps `deletedAt` together with `status = ARCHIVED` and
   * delete stamps `deletedAt` alone, and every status list filters
   * `deletedAt: null` — so those rows were previously unreachable after a page
   * reload and could not be restored. This view is backed by
   * GET /blog/admin/trash instead of GET /blog/admin?status=.
   */
  describe('archived / deleted (trash) view', () => {
    let confirmSpy: jest.SpyInstance<boolean, [message?: string]>;

    beforeEach(() => {
      confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    });

    afterEach(() => {
      confirmSpy.mockRestore();
    });

    async function openTrashView() {
      listAdminPostsMock.mockResolvedValue({ items: [], hasMore: false });
      render(<BlogListView />);
      await waitFor(() => expect(listAdminPostsMock).toHaveBeenCalledTimes(1));
      await userEvent.selectOptions(screen.getByLabelText(/وضعیت/), 'TRASH');
    }

    it('offers the archived/deleted option in the same status filter', async () => {
      listAdminPostsMock.mockResolvedValue({ items: [post()], hasMore: false });
      render(<BlogListView />);
      await screen.findByText('اولین مطلب');

      expect(
        screen.getByRole('option', { name: 'بایگانی/حذف‌شده (قابل بازگردانی)' }),
      ).toBeInTheDocument();
    });

    it('loads archived and deleted posts from the trash endpoint', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [
          post({ id: 'post-a', title: 'مطلب بایگانی‌شده', status: 'ARCHIVED' }),
          // softDelete() does not touch `status`, so a deleted DRAFT keeps DRAFT
          // and must still show up here.
          post({ id: 'post-b', title: 'پیش‌نویس حذف‌شده', status: 'DRAFT' }),
        ],
        hasMore: false,
      });

      await openTrashView();

      await waitFor(() =>
        expect(listTrashedPostsMock).toHaveBeenCalledWith({ cursor: undefined }),
      );
      expect(await screen.findByText('مطلب بایگانی‌شده')).toBeInTheDocument();
      expect(screen.getByText('پیش‌نویس حذف‌شده')).toBeInTheDocument();
      // The status-based endpoint is not used for this view.
      expect(listAdminPostsMock).toHaveBeenCalledTimes(1);
    });

    // The row is soft-deleted: GET /blog/admin/:id 404s and archive/delete are
    // both rejected by the backend, so restore is the only offered action.
    it('offers only Restore on a trashed row', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [post({ status: 'PUBLISHED' })],
        hasMore: false,
      });

      await openTrashView();
      await screen.findByText('اولین مطلب');

      expect(screen.getByRole('button', { name: 'بازگردانی' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'حذف' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'بایگانی' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'ویرایش' })).not.toBeInTheDocument();
    });

    it('restores a post and refetches the trash list', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [post({ status: 'ARCHIVED' })],
        hasMore: false,
      });
      restorePostMock.mockResolvedValue({} as never);

      await openTrashView();
      await screen.findByText('اولین مطلب');

      // Restore clears `deletedAt`, so the row leaves this view.
      listTrashedPostsMock.mockResolvedValue({ items: [], hasMore: false });
      await userEvent.click(screen.getByRole('button', { name: 'بازگردانی' }));

      await waitFor(() => expect(restorePostMock).toHaveBeenCalledWith('post-1'));
      expect(confirmSpy).toHaveBeenCalled();
      expect(await screen.findByText('مطلب بازگردانی شد.')).toBeInTheDocument();
      await waitFor(() => expect(listTrashedPostsMock).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/حذف‌شده‌ای وجود ندارد/)).toBeInTheDocument();
    });

    it('does not call restore when the confirm dialog is dismissed', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [post({ status: 'ARCHIVED' })],
        hasMore: false,
      });

      await openTrashView();
      await screen.findByText('اولین مطلب');

      confirmSpy.mockReturnValue(false);
      await userEvent.click(screen.getByRole('button', { name: 'بازگردانی' }));

      expect(restorePostMock).not.toHaveBeenCalled();
      expect(listTrashedPostsMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      [401, 'UNAUTHORIZED', 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.'],
      [403, 'FORBIDDEN', 'شما اجازه دسترسی به این بخش را ندارید.'],
      [500, 'INTERNAL_SERVER_ERROR', 'خطای سرور. لطفاً بعداً دوباره تلاش کنید.'],
    ])('surfaces a %s from the trash listing', async (status, code, message) => {
      listTrashedPostsMock.mockRejectedValue(
        new CmsApiError(status as number, code as string, message as string),
      );

      await openTrashView();

      expect(await screen.findByRole('alert')).toHaveTextContent(message as string);
    });

    it('surfaces a 404 from restore as an already-removed message', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [post({ status: 'ARCHIVED' })],
        hasMore: false,
      });
      restorePostMock.mockRejectedValue(new CmsApiError(404, 'NOT_FOUND', 'Post not found'));

      await openTrashView();
      await screen.findByText('اولین مطلب');
      await userEvent.click(screen.getByRole('button', { name: 'بازگردانی' }));

      expect(await screen.findByText(/پیش‌تر حذف شده است/)).toBeInTheDocument();
      // The failed row stays visible; nothing is refetched.
      expect(screen.getByText('اولین مطلب')).toBeInTheDocument();
      expect(listTrashedPostsMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces a 403 from restore without dropping the row', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [post({ status: 'ARCHIVED' })],
        hasMore: false,
      });
      restorePostMock.mockRejectedValue(
        new CmsApiError(403, 'FORBIDDEN', 'شما اجازه بازگردانی این مطلب را ندارید.'),
      );

      await openTrashView();
      await screen.findByText('اولین مطلب');
      await userEvent.click(screen.getByRole('button', { name: 'بازگردانی' }));

      expect(
        await screen.findByText('شما اجازه بازگردانی این مطلب را ندارید.'),
      ).toBeInTheDocument();
      expect(screen.getByText('اولین مطلب')).toBeInTheDocument();
    });

    it('paginates the trash list with its own cursor', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [post({ status: 'ARCHIVED' })],
        hasMore: true,
      });

      await openTrashView();
      await screen.findByText('اولین مطلب');

      listTrashedPostsMock.mockResolvedValue({
        items: [post({ id: 'post-9', title: 'صفحه دوم بایگانی', status: 'ARCHIVED' })],
        hasMore: false,
      });
      await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));

      await waitFor(() =>
        expect(listTrashedPostsMock).toHaveBeenLastCalledWith({ cursor: 'post-1' }),
      );
      expect(await screen.findByText('صفحه دوم بایگانی')).toBeInTheDocument();
    });

    it('switching back to an active status uses the status endpoint again', async () => {
      listTrashedPostsMock.mockResolvedValue({
        items: [post({ status: 'ARCHIVED' })],
        hasMore: false,
      });

      await openTrashView();
      await screen.findByText('اولین مطلب');

      listAdminPostsMock.mockResolvedValue({
        items: [post({ id: 'post-3', title: 'مطلب فعال' })],
        hasMore: false,
      });
      await userEvent.selectOptions(screen.getByLabelText(/وضعیت/), 'DRAFT');

      await waitFor(() =>
        expect(listAdminPostsMock).toHaveBeenLastCalledWith({
          status: 'DRAFT',
          cursor: undefined,
        }),
      );
      expect(await screen.findByText('مطلب فعال')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'حذف' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'بازگردانی' })).not.toBeInTheDocument();
    });
  });
});
