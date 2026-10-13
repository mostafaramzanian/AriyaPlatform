import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreSurveyEditorView } from '../CoreSurveyEditorView';
import { CoreApiError } from '@/lib/core-http';
import { fetchMyRbac } from '@/lib/rbac-api';
import { createSurvey, getSurvey, updateSurvey, type SurveyDetail } from '@/lib/surveys-api';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => '/admin/surveys/new',
}));

jest.mock('@/lib/rbac-api', () => ({ fetchMyRbac: jest.fn() }));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. Bounds constants and label helpers stay real, which is what
// makes the client-side `validate()` assertions meaningful.
jest.mock('@/lib/surveys-api', () => ({
  ...jest.requireActual('@/lib/surveys-api'),
  createSurvey: jest.fn(),
  getSurvey: jest.fn(),
  updateSurvey: jest.fn(),
}));

const rbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;
const createMock = createSurvey as jest.MockedFunction<typeof createSurvey>;
const getMock = getSurvey as jest.MockedFunction<typeof getSurvey>;
const updateMock = updateSurvey as jest.MockedFunction<typeof updateSurvey>;

const MANAGE = 'admin.surveys.manage';
const RESULTS = 'admin.surveys.results';

/** `GET /rbac` reply carrying exactly the given permission strings. */
function rbac(permissions: string[]) {
  return { userId: 'u1', roles: [], permissions, highestRole: null };
}

function detail(overrides: Partial<SurveyDetail> = {}): SurveyDetail {
  return {
    id: 's1',
    title: 'نظرسنجی رضایت',
    description: null,
    status: 'DRAFT',
    isAnonymous: false,
    startsAt: null,
    endsAt: null,
    publishedAt: null,
    closedAt: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    createdBy: { id: 'u1', firstName: 'بهار', lastName: 'نوری', avatarUrl: null, jobTitle: null },
    questionCount: 1,
    canManage: true,
    canViewResults: false,
    canRespond: false,
    hasResponded: false,
    availableTransitions: ['PUBLISHED'],
    questions: [
      {
        id: 'q1',
        type: 'SINGLE_CHOICE',
        text: 'میزان رضایت شما؟',
        isRequired: true,
        order: 0,
        maxSelections: null,
        options: [
          { id: 'o1', label: 'زیاد', order: 0 },
          { id: 'o2', label: 'کم', order: 1 },
        ],
      },
    ],
    ...overrides,
  };
}

/** Fills the first (blank) question with a valid single-choice questionnaire. */
async function fillValidQuestion() {
  await userEvent.type(screen.getByLabelText('متن پرسش'), 'میزان رضایت شما؟');
  const options = screen.getAllByLabelText('عنوان گزینه');
  await userEvent.type(options[0], 'زیاد');
  await userEvent.type(options[1], 'کم');
}

describe('CoreSurveyEditorView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('permission gating', () => {
    it('shows a loading state while the permission read is in flight', () => {
      rbacMock.mockReturnValue(new Promise(() => undefined));

      render(<CoreSurveyEditorView />);

      expect(screen.getByText('در حال بررسی دسترسی...')).toBeInTheDocument();
      expect(screen.queryByTestId('survey-editor')).not.toBeInTheDocument();
    });

    it('renders the form for a caller holding admin.surveys.manage', async () => {
      rbacMock.mockResolvedValue(rbac([MANAGE]));

      render(<CoreSurveyEditorView />);

      expect(await screen.findByTestId('survey-editor')).toBeInTheDocument();
    });

    /**
     * `admin.surveys.results` grants reading aggregates, NOT authoring. The two are
     * separate grants, so holding results alone must not open the editor.
     */
    it('refuses the form to a caller holding only admin.surveys.results', async () => {
      rbacMock.mockResolvedValue(rbac([RESULTS]));

      render(<CoreSurveyEditorView />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'شما اجازه ساخت یا ویرایش نظرسنجی را ندارید.',
      );
      expect(screen.queryByTestId('survey-editor')).not.toBeInTheDocument();
    });

    it('refuses the form to a caller holding neither permission', async () => {
      rbacMock.mockResolvedValue(rbac([]));

      render(<CoreSurveyEditorView />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'شما اجازه ساخت یا ویرایش نظرسنجی را ندارید.',
      );
    });

    /**
     * The gate is presentation only — the server enforces the same permission. A failed
     * `/rbac` read must therefore degrade to "no permissions" and never fall open.
     */
    it('does not open the form when the permission read fails', async () => {
      rbacMock.mockRejectedValue(new CoreApiError('boom', 500));

      render(<CoreSurveyEditorView />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'شما اجازه ساخت یا ویرایش نظرسنجی را ندارید.',
      );
      expect(screen.queryByTestId('survey-editor')).not.toBeInTheDocument();
    });

    it('does not fetch the survey being edited before the permission resolves', async () => {
      rbacMock.mockResolvedValue(rbac([RESULTS]));
      getMock.mockResolvedValue(detail());

      render(<CoreSurveyEditorView surveyId="s1" />);

      await screen.findByRole('alert');
      expect(getMock).not.toHaveBeenCalled();
    });
  });

  describe('client-side validate() bounds', () => {
    beforeEach(() => {
      rbacMock.mockResolvedValue(rbac([MANAGE]));
    });

    /**
     * The title input carries the native `required` attribute, so an empty submit is
     * stopped by constraint validation before `handleSubmit` runs. The point worth
     * asserting is the outcome: no request leaves the client.
     */
    it('makes no request when the title is empty', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      expect(screen.getByLabelText('عنوان')).toBeRequired();

      await userEvent.click(screen.getByTestId('survey-save'));

      expect(createMock).not.toHaveBeenCalled();
    });

    /**
     * A whitespace-only title trims to empty. The check must run on the trimmed value,
     * otherwise the request goes out and comes back as a 400.
     */
    it('treats a whitespace-only title as blank', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), '     ');
      await userEvent.click(screen.getByTestId('survey-save'));

      expect(await screen.findByRole('alert')).toHaveTextContent('عنوان نظرسنجی الزامی است.');
      expect(createMock).not.toHaveBeenCalled();
    });

    it('rejects a blank question text', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await userEvent.click(screen.getByTestId('survey-save'));

      expect(await screen.findByRole('alert')).toHaveTextContent('متن پرسش ۱ الزامی است.');
      expect(createMock).not.toHaveBeenCalled();
    });

    it('rejects a choice question with an empty option label', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await userEvent.type(screen.getByLabelText('متن پرسش'), 'میزان رضایت شما؟');
      await userEvent.type(screen.getAllByLabelText('عنوان گزینه')[0], 'زیاد');

      await userEvent.click(screen.getByTestId('survey-save'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'گزینه‌های پرسش ۱ نمی‌توانند خالی باشند.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });

    /** Duplicates would violate the backend's per-question unique index. */
    it('rejects duplicate option labels within one question', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await userEvent.type(screen.getByLabelText('متن پرسش'), 'میزان رضایت شما؟');
      const options = screen.getAllByLabelText('عنوان گزینه');
      await userEvent.type(options[0], 'زیاد');
      await userEvent.type(options[1], 'زیاد');

      await userEvent.click(screen.getByTestId('survey-save'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'گزینه‌های پرسش ۱ تکراری هستند.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });

    /**
     * `maxSelections` may not exceed the number of options — a cap larger than the
     * choice set is unsatisfiable. The number input's own `max` already blocks typing
     * such a value, so the state is set directly to exercise `validate()` itself.
     */
    it('rejects a maxSelections cap above the option count', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await userEvent.selectOptions(screen.getByLabelText('نوع پرسش'), 'MULTIPLE_CHOICE');
      await fillValidQuestion();

      const cap = screen.getByLabelText('حداکثر انتخاب (خالی = بدون محدودیت)');
      expect(cap).toHaveAttribute('max', '2');
      fireEvent.change(cap, { target: { value: '5' } });

      // The input's own `max` makes the browser refuse this submit before any handler
      // runs, so the event is dispatched directly to exercise the JS guard behind it.
      fireEvent.submit(screen.getByTestId('survey-editor'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'حداکثر انتخاب پرسش ۱ باید عددی بین ۱ و تعداد گزینه‌ها باشد.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });

    it('rejects an end time at or before the start time', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await fillValidQuestion();
      await userEvent.type(screen.getByLabelText('زمان شروع (اختیاری)'), '2026-09-02T10:00');
      await userEvent.type(screen.getByLabelText('زمان پایان (اختیاری)'), '2026-09-01T10:00');

      await userEvent.click(screen.getByTestId('survey-save'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'زمان پایان باید بعد از زمان شروع باشد.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });

    it('keeps at least one question and at least two options', async () => {
      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      expect(screen.getByRole('button', { name: 'حذف پرسش' })).toBeDisabled();
      screen
        .getAllByRole('button', { name: 'حذف گزینه' })
        .forEach((button) => expect(button).toBeDisabled());
    });
  });

  describe('payload shape', () => {
    beforeEach(() => {
      rbacMock.mockResolvedValue(rbac([MANAGE]));
    });

    /**
     * `status`, `publishedAt`, `closedAt`, `createdById` and any tenant identifier are
     * server-owned. Creation always yields a DRAFT, so none of them may appear in the
     * payload — the query DTO runs under `forbidNonWhitelisted` and would reject them.
     */
    it('creates a survey without any server-owned or actor field', async () => {
      createMock.mockResolvedValue(detail());

      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await fillValidQuestion();
      await userEvent.click(screen.getByTestId('survey-save'));

      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

      const payload = createMock.mock.calls[0][0];
      expect(payload).not.toHaveProperty('status');
      expect(payload).not.toHaveProperty('publishedAt');
      expect(payload).not.toHaveProperty('closedAt');
      expect(payload).not.toHaveProperty('createdById');
      expect(payload).not.toHaveProperty('userId');
      expect(payload).not.toHaveProperty('tenantId');
    });

    it('omits a blank description and blank window instead of sending empty values', async () => {
      createMock.mockResolvedValue(detail());

      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await fillValidQuestion();
      await userEvent.click(screen.getByTestId('survey-save'));

      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

      const payload = createMock.mock.calls[0][0];
      expect(payload).not.toHaveProperty('description');
      expect(payload).not.toHaveProperty('startsAt');
      expect(payload).not.toHaveProperty('endsAt');
      expect(payload.title).toBe('نظرسنجی رضایت');
      expect(payload.isAnonymous).toBe(false);
    });

    /** Question order is positional; no `order` field is ever sent. */
    it('sends questions positionally with trimmed text and no order field', async () => {
      createMock.mockResolvedValue(detail());

      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await userEvent.type(screen.getByLabelText('متن پرسش'), '  میزان رضایت شما؟  ');
      const options = screen.getAllByLabelText('عنوان گزینه');
      await userEvent.type(options[0], '  زیاد  ');
      await userEvent.type(options[1], 'کم');
      await userEvent.click(screen.getByTestId('survey-save'));

      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

      const [question] = createMock.mock.calls[0][0].questions;
      expect(question).not.toHaveProperty('order');
      expect(question).not.toHaveProperty('id');
      expect(question.text).toBe('میزان رضایت شما؟');
      expect(question.options?.[0]).toEqual({ label: 'زیاد' });
    });

    /**
     * A TEXT or RATING question has no option list and no selection cap, so switching
     * type away from MULTIPLE_CHOICE must not leave a stale `maxSelections` behind.
     */
    it('drops options and maxSelections for a non-choice question', async () => {
      createMock.mockResolvedValue(detail());

      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await userEvent.selectOptions(screen.getByLabelText('نوع پرسش'), 'MULTIPLE_CHOICE');
      await fillValidQuestion();
      await userEvent.type(screen.getByLabelText('حداکثر انتخاب (خالی = بدون محدودیت)'), '2');
      await userEvent.selectOptions(screen.getByLabelText('نوع پرسش'), 'TEXT');

      await userEvent.click(screen.getByTestId('survey-save'));

      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

      const [question] = createMock.mock.calls[0][0].questions;
      expect(question.type).toBe('TEXT');
      expect(question).not.toHaveProperty('options');
      expect(question).not.toHaveProperty('maxSelections');
    });

    it('navigates to the saved survey on success', async () => {
      createMock.mockResolvedValue(detail({ id: 's9' }));

      render(<CoreSurveyEditorView />);
      await screen.findByTestId('survey-editor');

      await userEvent.type(screen.getByLabelText('عنوان'), 'نظرسنجی رضایت');
      await fillValidQuestion();
      await userEvent.click(screen.getByTestId('survey-save'));

      await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/surveys/s9'));
    });
  });

  describe('edit mode and the DRAFT-only rule', () => {
    beforeEach(() => {
      rbacMock.mockResolvedValue(rbac([MANAGE]));
    });

    it('hydrates the form from the loaded draft', async () => {
      getMock.mockResolvedValue(
        detail({ description: 'توضیح نظرسنجی', isAnonymous: true }),
      );

      render(<CoreSurveyEditorView surveyId="s1" />);

      await screen.findByTestId('survey-editor');
      expect(screen.getByLabelText('عنوان')).toHaveValue('نظرسنجی رضایت');
      expect(screen.getByLabelText('توضیحات')).toHaveValue('توضیح نظرسنجی');
      expect(screen.getByLabelText('متن پرسش')).toHaveValue('میزان رضایت شما؟');
      expect(screen.getAllByLabelText('عنوان گزینه')[0]).toHaveValue('زیاد');
    });

    /**
     * Editing sends the WHOLE questions array because the backend replaces the
     * questionnaire wholesale — a partial patch cannot express deletion or reordering.
     */
    it('sends the entire questionnaire on update', async () => {
      getMock.mockResolvedValue(detail());
      updateMock.mockResolvedValue(detail());

      render(<CoreSurveyEditorView surveyId="s1" />);
      await screen.findByTestId('survey-editor');

      await userEvent.click(screen.getByTestId('survey-save'));

      await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
      expect(updateMock.mock.calls[0][0]).toBe('s1');
      expect(updateMock.mock.calls[0][1].questions).toHaveLength(1);
    });

    /**
     * A published survey is frozen. Rather than presenting a form whose every
     * submission would 409, the view reports the state — and offers no retry, because
     * retrying cannot succeed.
     */
    it('refuses to edit a non-DRAFT survey and offers no retry', async () => {
      getMock.mockResolvedValue(detail({ status: 'PUBLISHED' }));

      render(<CoreSurveyEditorView surveyId="s1" />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'تنها نظرسنجی‌های پیش‌نویس قابل ویرایش هستند.',
      );
      expect(screen.queryByTestId('survey-editor')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
    });

    it('reports a 403 on load as forbidden rather than a retryable error', async () => {
      getMock.mockRejectedValue(new CoreApiError('forbidden', 403));

      render(<CoreSurveyEditorView surveyId="s1" />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'شما به این نظرسنجی دسترسی ندارید.',
      );
      expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
    });

    it('surfaces a 409 from the save as a frozen-survey message', async () => {
      getMock.mockResolvedValue(detail());
      updateMock.mockRejectedValue(new CoreApiError('conflict', 409));

      render(<CoreSurveyEditorView surveyId="s1" />);
      await screen.findByTestId('survey-editor');

      await userEvent.click(screen.getByTestId('survey-save'));

      expect(
        await screen.findByText('این نظرسنجی دیگر قابل ویرایش نیست.'),
      ).toBeInTheDocument();
    });

    it('offers a retry when the load fails transiently', async () => {
      getMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
      getMock.mockResolvedValueOnce(detail());

      render(<CoreSurveyEditorView surveyId="s1" />);

      expect(await screen.findByRole('alert')).toHaveTextContent('خطای سرور');

      await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

      expect(await screen.findByTestId('survey-editor')).toBeInTheDocument();
    });
  });
});
