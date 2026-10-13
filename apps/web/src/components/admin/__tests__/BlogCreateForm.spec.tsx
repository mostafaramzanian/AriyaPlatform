import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlogCreateForm } from '../BlogCreateForm';
import * as cmsApi from '@/lib/cms-api';
import { CmsApiError } from '@/lib/cms-api';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => '/admin/blog/new',
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. `omitEmpty` stays real so payload shaping is verified.
jest.mock('@/lib/cms-api', () => ({
  ...jest.requireActual('@/lib/cms-api'),
  createPost: jest.fn(),
}));

const createPost = cmsApi.createPost as jest.MockedFunction<typeof cmsApi.createPost>;

const VALID_CONTENT = 'این یک محتوای آزمایشی به‌اندازه کافی طولانی برای اعتبارسنجی است.';

async function fillRequiredFields() {
  // Required-field labels render an asterisk from the Input/Textarea primitives.
  await userEvent.type(screen.getByLabelText(/^عنوان\*$/), 'یک عنوان معتبر');
  await userEvent.type(screen.getByLabelText(/^محتوا/), VALID_CONTENT);
}

describe('BlogCreateForm', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('submits only non-empty supported DTO fields and redirects to the edit page', async () => {
    createPost.mockResolvedValue({ id: 'new-id' } as cmsApi.AdminBlogPost);

    render(<BlogCreateForm />);
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'ذخیره پیش‌نویس' }));

    await waitFor(() =>
      expect(createPost).toHaveBeenCalledWith({
        title: 'یک عنوان معتبر',
        content: VALID_CONTENT,
      }),
    );
    expect(push).toHaveBeenCalledWith('/admin/blog/new-id/edit');
  });

  it('renders backend validation errors with field details', async () => {
    createPost.mockRejectedValue(
      new CmsApiError(422, 'VALIDATION_FAILED', 'Validation failed', [
        { property: 'title', constraints: { minLength: 'title must be longer' } },
      ]),
    );

    render(<BlogCreateForm />);
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'ذخیره پیش‌نویس' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Validation failed');
    expect(screen.getByText(/title must be longer/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('surfaces a 403 without redirecting', async () => {
    createPost.mockRejectedValue(new CmsApiError(403, 'FORBIDDEN', 'دسترسی ندارید'));

    render(<BlogCreateForm />);
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'ذخیره پیش‌نویس' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('دسترسی ندارید');
    expect(push).not.toHaveBeenCalled();
  });
});
