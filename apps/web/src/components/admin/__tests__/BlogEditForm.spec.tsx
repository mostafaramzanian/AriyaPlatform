import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlogEditForm } from '../BlogEditForm';
import * as cmsApi from '@/lib/cms-api';
import { CmsApiError } from '@/lib/cms-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/blog/post-1/edit',
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. `omitEmpty` stays real so payload shaping is verified.
jest.mock('@/lib/cms-api', () => ({
  ...jest.requireActual('@/lib/cms-api'),
  getAdminPost: jest.fn(),
  updatePost: jest.fn(),
  publishPost: jest.fn(),
  schedulePost: jest.fn(),
  archivePost: jest.fn(),
  restorePost: jest.fn(),
  deletePost: jest.fn(),
}));

const getAdminPost = cmsApi.getAdminPost as jest.MockedFunction<typeof cmsApi.getAdminPost>;
const updatePost = cmsApi.updatePost as jest.MockedFunction<typeof cmsApi.updatePost>;
const publishPost = cmsApi.publishPost as jest.MockedFunction<typeof cmsApi.publishPost>;
const schedulePost = cmsApi.schedulePost as jest.MockedFunction<typeof cmsApi.schedulePost>;
const archivePost = cmsApi.archivePost as jest.MockedFunction<typeof cmsApi.archivePost>;
const restorePost = cmsApi.restorePost as jest.MockedFunction<typeof cmsApi.restorePost>;
const deletePost = cmsApi.deletePost as jest.MockedFunction<typeof cmsApi.deletePost>;

function existingPost(overrides: Partial<cmsApi.AdminBlogPost> = {}): cmsApi.AdminBlogPost {
  return {
    id: 'post-1',
    title: 'عنوان موجود',
    slug: 'existing-post',
    content: 'محتوای موجود که به‌اندازه کافی طولانی است برای عبور از اعتبارسنجی.',
    excerpt: 'خلاصه موجود',
    status: 'DRAFT',
    publishedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    deletedAt: null,
    authorId: 'user-1',
    readingTimeMin: 2,
    featuredImageId: null,
    seoMetadata: null,
    categories: [],
    tags: [],
    ...overrides,
  };
}

describe('BlogEditForm', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('loads the existing post into the form', async () => {
    getAdminPost.mockResolvedValue(existingPost());

    render(<BlogEditForm id="post-1" />);

    expect(await screen.findByDisplayValue('عنوان موجود')).toBeInTheDocument();
    expect(screen.getByDisplayValue('existing-post')).toBeInTheDocument();
    expect(getAdminPost).toHaveBeenCalledWith('post-1');
  });

  it('sends expectedUpdatedAt and shows a success message', async () => {
    getAdminPost.mockResolvedValue(existingPost());
    updatePost.mockResolvedValue(existingPost({ title: 'عنوان تازه' }));

    render(<BlogEditForm id="post-1" />);
    const titleInput = await screen.findByDisplayValue('عنوان موجود');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'عنوان تازه');
    await userEvent.click(screen.getByRole('button', { name: 'ذخیره تغییرات' }));

    await waitFor(() =>
      expect(updatePost).toHaveBeenCalledWith('post-1', {
        title: 'عنوان تازه',
        slug: 'existing-post',
        content: 'محتوای موجود که به‌اندازه کافی طولانی است برای عبور از اعتبارسنجی.',
        excerpt: 'خلاصه موجود',
        expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    expect(await screen.findByText('تغییرات ذخیره شد.')).toBeInTheDocument();
  });

  it('renders a not-found state on 404', async () => {
    getAdminPost.mockRejectedValue(new CmsApiError(404, 'NOT_FOUND', 'Post not found'));

    render(<BlogEditForm id="missing" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('یافت نشد');
    expect(screen.queryByRole('button', { name: 'ذخیره تغییرات' })).not.toBeInTheDocument();
  });

  it('renders a forbidden state on 403', async () => {
    getAdminPost.mockRejectedValue(new CmsApiError(403, 'FORBIDDEN', 'دسترسی ندارید'));

    render(<BlogEditForm id="post-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('دسترسی ندارید');
  });

  it('offers a reload path on a 409 optimistic-lock conflict', async () => {
    getAdminPost.mockResolvedValue(existingPost());
    updatePost.mockRejectedValue(
      new CmsApiError(409, 'CONFLICT', 'The post was modified by another request'),
    );

    render(<BlogEditForm id="post-1" />);
    await screen.findByDisplayValue('عنوان موجود');
    await userEvent.click(screen.getByRole('button', { name: 'ذخیره تغییرات' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('modified by another request');

    getAdminPost.mockResolvedValue(
      existingPost({ title: 'نسخه سرور', updatedAt: '2026-02-02T00:00:00.000Z' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'بارگذاری نسخه جدید' }));

    expect(await screen.findByDisplayValue('نسخه سرور')).toBeInTheDocument();
  });

  describe('workflow actions', () => {
    let confirmSpy: jest.SpyInstance<boolean, [message?: string]>;

    beforeEach(() => {
      confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    });

    afterEach(() => {
      confirmSpy.mockRestore();
    });

    // BlogService.isValidTransition() rejects DRAFT → PUBLISHED and
    // DRAFT → SCHEDULED, so a draft only offers "send to review".
    it('offers only the review transition for a DRAFT', async () => {
      getAdminPost.mockResolvedValue(existingPost());

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');

      expect(screen.getByRole('button', { name: 'ارسال برای بازبینی' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'انتشار' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'زمان‌بندی انتشار' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'بایگانی' })).not.toBeInTheDocument();
      expect(screen.getByText(/انتشار مستقیم پیش‌نویس/)).toBeInTheDocument();
    });

    it('sends a DRAFT to review through PATCH and reloads the record', async () => {
      getAdminPost.mockResolvedValue(existingPost());
      updatePost.mockResolvedValue(existingPost({ status: 'REVIEW' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');

      getAdminPost.mockResolvedValue(existingPost({ status: 'REVIEW' }));
      await userEvent.click(screen.getByRole('button', { name: 'ارسال برای بازبینی' }));

      await waitFor(() =>
        expect(updatePost).toHaveBeenCalledWith('post-1', {
          status: 'REVIEW',
          expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
        }),
      );
      expect(await screen.findByText('مطلب برای بازبینی ارسال شد.')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'انتشار' })).toBeInTheDocument();
    });

    // publishPost() rejects the call when neither the stored SEO title nor
    // dto.metaTitle is present, so the form supplies one for a post without SEO.
    it('publishes a REVIEW post with the entered SEO title', async () => {
      getAdminPost.mockResolvedValue(existingPost({ status: 'REVIEW' }));
      publishPost.mockResolvedValue(existingPost({ status: 'PUBLISHED' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');

      await userEvent.type(screen.getByLabelText(/عنوان سئو/), 'عنوان سئو');
      getAdminPost.mockResolvedValue(existingPost({ status: 'PUBLISHED' }));
      await userEvent.click(screen.getByRole('button', { name: 'انتشار' }));

      await waitFor(() =>
        expect(publishPost).toHaveBeenCalledWith('post-1', {
          metaTitle: 'عنوان سئو',
          expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
        }),
      );
      expect(await screen.findByText('مطلب منتشر شد.')).toBeInTheDocument();
    });

    it('omits metaTitle when the post already has one', async () => {
      getAdminPost.mockResolvedValue(
        existingPost({ status: 'REVIEW', seoMetadata: { metaTitle: 'سئوی موجود' } }),
      );
      publishPost.mockResolvedValue(existingPost({ status: 'PUBLISHED' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');

      expect(screen.queryByLabelText(/عنوان سئو/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'انتشار' }));

      await waitFor(() =>
        expect(publishPost).toHaveBeenCalledWith('post-1', {
          expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
        }),
      );
    });

    it('surfaces a 403 from publish', async () => {
      getAdminPost.mockResolvedValue(
        existingPost({ status: 'REVIEW', seoMetadata: { metaTitle: 'سئوی موجود' } }),
      );
      publishPost.mockRejectedValue(
        new CmsApiError(403, 'FORBIDDEN', 'شما اجازه انتشار این مطلب را ندارید.'),
      );

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'انتشار' }));

      expect(await screen.findByText('شما اجازه انتشار این مطلب را ندارید.')).toBeInTheDocument();
    });

    it('schedules a REVIEW post with a future ISO timestamp', async () => {
      getAdminPost.mockResolvedValue(
        existingPost({ status: 'REVIEW', seoMetadata: { metaTitle: 'سئوی موجود' } }),
      );
      schedulePost.mockResolvedValue(existingPost({ status: 'SCHEDULED' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');

      // `datetime-local` is local wall-clock; the component converts to ISO.
      const future = new Date(Date.now() + 86_400_000);
      const localValue = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
      await userEvent.type(screen.getByLabelText('زمان انتشار'), localValue);

      getAdminPost.mockResolvedValue(existingPost({ status: 'SCHEDULED' }));
      await userEvent.click(screen.getByRole('button', { name: 'زمان‌بندی انتشار' }));

      await waitFor(() => expect(schedulePost).toHaveBeenCalledTimes(1));
      const [calledId, payload] = schedulePost.mock.calls[0];
      expect(calledId).toBe('post-1');
      expect(new Date(payload.scheduledAt).getTime()).toBeGreaterThan(Date.now());
      expect(await screen.findByText('زمان انتشار ثبت شد.')).toBeInTheDocument();
    });

    it('rejects an empty schedule time before calling the API', async () => {
      getAdminPost.mockResolvedValue(
        existingPost({ status: 'REVIEW', seoMetadata: { metaTitle: 'سئوی موجود' } }),
      );

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'زمان‌بندی انتشار' }));

      expect(await screen.findByText('زمان انتشار را مشخص کنید.')).toBeInTheDocument();
      expect(schedulePost).not.toHaveBeenCalled();
    });

    it('surfaces a 403 from schedule', async () => {
      getAdminPost.mockResolvedValue(
        existingPost({ status: 'SCHEDULED', seoMetadata: { metaTitle: 'سئوی موجود' } }),
      );
      schedulePost.mockRejectedValue(
        new CmsApiError(403, 'FORBIDDEN', 'شما اجازه زمان‌بندی این مطلب را ندارید.'),
      );

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');

      const future = new Date(Date.now() + 86_400_000);
      const localValue = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
      await userEvent.type(screen.getByLabelText('زمان انتشار'), localValue);
      await userEvent.click(screen.getByRole('button', { name: 'زمان‌بندی انتشار' }));

      expect(
        await screen.findByText('شما اجازه زمان‌بندی این مطلب را ندارید.'),
      ).toBeInTheDocument();
    });

    // BlogRepository.archive() stamps `deletedAt` too, so GET /blog/admin/:id
    // starts returning 404 and the form is replaced by a restore panel.
    it('archives a PUBLISHED post and offers restore', async () => {
      getAdminPost.mockResolvedValue(existingPost({ status: 'PUBLISHED' }));
      archivePost.mockResolvedValue(existingPost({ status: 'ARCHIVED' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'بایگانی' }));

      await waitFor(() => expect(archivePost).toHaveBeenCalledWith('post-1'));
      expect(confirmSpy).toHaveBeenCalled();
      expect(await screen.findByText('مطلب بایگانی شد.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'بازگردانی مطلب' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'ذخیره تغییرات' })).not.toBeInTheDocument();
    });

    it('does not archive when the confirm dialog is dismissed', async () => {
      confirmSpy.mockReturnValue(false);
      getAdminPost.mockResolvedValue(existingPost({ status: 'PUBLISHED' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'بایگانی' }));

      expect(archivePost).not.toHaveBeenCalled();
    });

    it('deletes the post and offers restore', async () => {
      getAdminPost.mockResolvedValue(existingPost());
      deletePost.mockResolvedValue(existingPost({ deletedAt: '2026-03-01T00:00:00.000Z' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      await waitFor(() => expect(deletePost).toHaveBeenCalledWith('post-1'));
      expect(await screen.findByText('مطلب حذف شد.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'بازگردانی مطلب' })).toBeInTheDocument();
    });

    it('surfaces a 404 from delete', async () => {
      getAdminPost.mockResolvedValue(existingPost());
      deletePost.mockRejectedValue(new CmsApiError(404, 'NOT_FOUND', 'Post not found'));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      expect(await screen.findByText('Post not found')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'بازگردانی مطلب' })).not.toBeInTheDocument();
    });

    it('surfaces a 403 from delete', async () => {
      getAdminPost.mockResolvedValue(existingPost());
      deletePost.mockRejectedValue(
        new CmsApiError(403, 'FORBIDDEN', 'شما اجازه حذف این مطلب را ندارید.'),
      );

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));

      expect(await screen.findByText('شما اجازه حذف این مطلب را ندارید.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'ذخیره تغییرات' })).toBeInTheDocument();
    });

    // restore() only clears `deletedAt`; the status is re-read from the server
    // rather than assumed.
    it('restores a deleted post and re-reads the record', async () => {
      getAdminPost.mockResolvedValue(existingPost());
      deletePost.mockResolvedValue(existingPost({ deletedAt: '2026-03-01T00:00:00.000Z' }));
      restorePost.mockResolvedValue(existingPost());

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));
      await screen.findByRole('button', { name: 'بازگردانی مطلب' });

      getAdminPost.mockResolvedValue(existingPost({ title: 'عنوان بازگردانی‌شده' }));
      await userEvent.click(screen.getByRole('button', { name: 'بازگردانی مطلب' }));

      await waitFor(() => expect(restorePost).toHaveBeenCalledWith('post-1'));
      expect(await screen.findByDisplayValue('عنوان بازگردانی‌شده')).toBeInTheDocument();
      expect(screen.getByText('مطلب بازگردانی شد.')).toBeInTheDocument();
    });

    it('surfaces a 403 from restore and keeps the restore panel', async () => {
      getAdminPost.mockResolvedValue(existingPost());
      deletePost.mockResolvedValue(existingPost({ deletedAt: '2026-03-01T00:00:00.000Z' }));
      restorePost.mockRejectedValue(
        new CmsApiError(403, 'FORBIDDEN', 'شما اجازه بازگردانی این مطلب را ندارید.'),
      );

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');
      await userEvent.click(screen.getByRole('button', { name: 'حذف' }));
      await screen.findByRole('button', { name: 'بازگردانی مطلب' });

      await userEvent.click(screen.getByRole('button', { name: 'بازگردانی مطلب' }));

      expect(
        await screen.findByText('شما اجازه بازگردانی این مطلب را ندارید.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'بازگردانی مطلب' })).toBeInTheDocument();
    });

    it('offers only archive as a forward transition for a PUBLISHED post', async () => {
      getAdminPost.mockResolvedValue(existingPost({ status: 'PUBLISHED' }));

      render(<BlogEditForm id="post-1" />);
      await screen.findByDisplayValue('عنوان موجود');

      expect(screen.getByRole('button', { name: 'بایگانی' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'انتشار' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'زمان‌بندی انتشار' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'ارسال برای بازبینی' }),
      ).not.toBeInTheDocument();
    });
  });
});
