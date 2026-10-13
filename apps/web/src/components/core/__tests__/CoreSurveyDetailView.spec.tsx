import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreSurveyDetailView } from '../CoreSurveyDetailView';
import { CoreApiError } from '@/lib/core-http';
import {
  changeSurveyStatus,
  getSurvey,
  getSurveyResults,
  submitSurveyResponse,
  type SurveyDetail,
  type SurveyQuestion,
  type SurveyResults,
} from '@/lib/surveys-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/surveys/s1',
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. Pure helpers (labels, sharePercent, formatting) stay real.
jest.mock('@/lib/surveys-api', () => ({
  ...jest.requireActual('@/lib/surveys-api'),
  getSurvey: jest.fn(),
  getSurveyResults: jest.fn(),
  submitSurveyResponse: jest.fn(),
  changeSurveyStatus: jest.fn(),
  deleteSurvey: jest.fn(),
}));

const getMock = getSurvey as jest.MockedFunction<typeof getSurvey>;
const resultsMock = getSurveyResults as jest.MockedFunction<typeof getSurveyResults>;
const submitMock = submitSurveyResponse as jest.MockedFunction<typeof submitSurveyResponse>;
const statusMock = changeSurveyStatus as jest.MockedFunction<typeof changeSurveyStatus>;

function singleChoice(overrides: Partial<SurveyQuestion> = {}): SurveyQuestion {
  return {
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
    ...overrides,
  };
}

function detail(overrides: Partial<SurveyDetail> = {}): SurveyDetail {
  return {
    id: 's1',
    title: 'نظرسنجی رضایت',
    description: null,
    status: 'PUBLISHED',
    isAnonymous: false,
    startsAt: null,
    endsAt: null,
    publishedAt: '2026-08-29T10:00:00.000Z',
    closedAt: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    createdBy: { id: 'u1', firstName: 'بهار', lastName: 'نوری', avatarUrl: null, jobTitle: null },
    questionCount: 1,
    canManage: false,
    canViewResults: false,
    canRespond: true,
    hasResponded: false,
    availableTransitions: [],
    questions: [singleChoice()],
    ...overrides,
  };
}

function results(overrides: Partial<SurveyResults> = {}): SurveyResults {
  return {
    surveyId: 's1',
    title: 'نظرسنجی رضایت',
    status: 'PUBLISHED',
    isAnonymous: true,
    responseCount: 4,
    questions: [
      {
        questionId: 'q1',
        type: 'SINGLE_CHOICE',
        text: 'میزان رضایت شما؟',
        order: 0,
        answeredCount: 4,
        options: [
          { optionId: 'o1', label: 'زیاد', order: 0, count: 3 },
          { optionId: 'o2', label: 'کم', order: 1, count: 1 },
        ],
        ratingAverage: null,
        ratingDistribution: [],
        textAnswers: [],
      },
    ],
    ...overrides,
  };
}

describe('CoreSurveyDetailView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Three capabilities live on this page, gated three DIFFERENT ways — participation by
   * `canRespond`, authoring by `canManage` (admin.surveys.manage) and results by
   * `canViewResults` (the separate admin.surveys.results). Each verdict comes from the
   * server and is only reflected here.
   */
  describe('three-way capability gating', () => {
    it('gives a plain participant the form but neither authoring nor results', async () => {
      getMock.mockResolvedValue(detail());

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByTestId('survey-response-form')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'ویرایش' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('survey-results')).not.toBeInTheDocument();
      // Results are never fetched speculatively.
      expect(resultsMock).not.toHaveBeenCalled();
    });

    it('gives a manager the authoring controls but no results panel', async () => {
      getMock.mockResolvedValue(
        detail({
          canManage: true,
          canRespond: false,
          status: 'DRAFT',
          availableTransitions: ['PUBLISHED'],
        }),
      );

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByRole('link', { name: 'ویرایش' })).toHaveAttribute(
        'href',
        '/admin/surveys/s1/edit',
      );
      expect(screen.getByTestId('survey-transition-PUBLISHED')).toBeInTheDocument();
      expect(screen.queryByTestId('survey-results')).not.toBeInTheDocument();
      expect(resultsMock).not.toHaveBeenCalled();
    });

    it('gives a results viewer the aggregates without any authoring control', async () => {
      getMock.mockResolvedValue(detail({ canViewResults: true, canRespond: false }));
      resultsMock.mockResolvedValue(results());

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByTestId('survey-results')).toBeInTheDocument();
      await waitFor(() => expect(resultsMock).toHaveBeenCalledWith('s1'));
      expect(screen.queryByRole('link', { name: 'ویرایش' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('survey-transition-PUBLISHED')).not.toBeInTheDocument();
    });

    /**
     * A 403 on the results call is reported rather than silently swallowed, because
     * `canViewResults` is a hint and the endpoint is the authority.
     */
    it('reports a results 403 instead of hiding the panel', async () => {
      getMock.mockResolvedValue(detail({ canViewResults: true, canRespond: false }));
      resultsMock.mockRejectedValue(new CoreApiError('forbidden', 403));

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(
        await screen.findByText('شما به نتایج این نظرسنجی دسترسی ندارید.'),
      ).toBeInTheDocument();
    });
  });

  describe('participation and the one-response rule', () => {
    it('submits the selected answer with no respondent identifier', async () => {
      getMock.mockResolvedValue(detail());
      submitMock.mockResolvedValue({
        responseId: 'r1',
        surveyId: 's1',
        submittedAt: '2026-08-31T08:00:00.000Z',
      });

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-response-form');

      await userEvent.click(screen.getByRole('radio', { name: 'زیاد' }));
      await userEvent.click(screen.getByTestId('survey-submit'));

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      expect(submitMock).toHaveBeenCalledWith('s1', [{ questionId: 'q1', optionIds: ['o1'] }]);

      const [answer] = submitMock.mock.calls[0][1];
      expect(answer).not.toHaveProperty('userId');
      expect(answer).not.toHaveProperty('respondentId');
    });

    it('blocks submission of a required question left blank', async () => {
      getMock.mockResolvedValue(detail());

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-response-form');

      await userEvent.click(screen.getByTestId('survey-submit'));

      expect(await screen.findByText('پاسخ به پرسش‌های الزامی ضروری است.')).toBeInTheDocument();
      expect(submitMock).not.toHaveBeenCalled();
    });

    /**
     * The backend's `@ArrayMinSize(1)` rejects an empty answer list with 422 before any
     * lifecycle or visibility check runs, so an all-optional survey with nothing filled
     * in is stopped here rather than being sent as an empty body.
     */
    it('refuses to send an empty answer list', async () => {
      getMock.mockResolvedValue(
        detail({ questions: [singleChoice({ isRequired: false })] }),
      );

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-response-form');

      await userEvent.click(screen.getByTestId('survey-submit'));

      expect(await screen.findByText('حداقل به یک پرسش پاسخ دهید.')).toBeInTheDocument();
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('omits an untouched optional question instead of sending an empty answer', async () => {
      getMock.mockResolvedValue(
        detail({
          questions: [
            singleChoice(),
            {
              id: 'q2',
              type: 'TEXT',
              text: 'توضیح بیشتر',
              isRequired: false,
              order: 1,
              maxSelections: null,
              options: [],
            },
          ],
        }),
      );
      submitMock.mockResolvedValue({
        responseId: 'r1',
        surveyId: 's1',
        submittedAt: '2026-08-31T08:00:00.000Z',
      });

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-response-form');

      await userEvent.click(screen.getByRole('radio', { name: 'زیاد' }));
      await userEvent.click(screen.getByTestId('survey-submit'));

      await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
      expect(submitMock.mock.calls[0][1]).toEqual([{ questionId: 'q1', optionIds: ['o1'] }]);
    });

    /** `maxSelections` is enforced client-side for feedback and again server-side. */
    it('refuses a selection beyond maxSelections', async () => {
      getMock.mockResolvedValue(
        detail({ questions: [singleChoice({ type: 'MULTIPLE_CHOICE', maxSelections: 1 })] }),
      );

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-response-form');

      await userEvent.click(screen.getByRole('checkbox', { name: 'زیاد' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'کم' }));

      expect(
        await screen.findByText('برای این پرسش حداکثر ۱ گزینه قابل انتخاب است.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'کم' })).not.toBeChecked();
    });

    /**
     * One response per user. A 409 cannot be retried into success, so it is reported and
     * the survey is re-read so `hasResponded` / `canRespond` come from the server rather
     * than being assumed client-side.
     */
    it('reports a 409 second submission and re-reads the survey', async () => {
      getMock.mockResolvedValueOnce(detail());
      getMock.mockResolvedValueOnce(detail({ hasResponded: true, canRespond: false }));
      submitMock.mockRejectedValue(new CoreApiError('conflict', 409));

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-response-form');

      await userEvent.click(screen.getByRole('radio', { name: 'زیاد' }));
      await userEvent.click(screen.getByTestId('survey-submit'));

      expect(await screen.findByTestId('survey-already-responded')).toBeInTheDocument();
      await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('survey-response-form')).not.toBeInTheDocument();
    });

    it('shows the already-responded notice and no form when hasResponded is set', async () => {
      getMock.mockResolvedValue(detail({ hasResponded: true, canRespond: false }));

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByTestId('survey-already-responded')).toHaveTextContent(
        'هر کاربر تنها یک‌بار می‌تواند پاسخ دهد.',
      );
      expect(screen.queryByTestId('survey-response-form')).not.toBeInTheDocument();
    });

    it('explains a closed window without offering the form', async () => {
      getMock.mockResolvedValue(
        detail({ status: 'CLOSED', canRespond: false, hasResponded: false }),
      );

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(
        await screen.findByText('در حال حاضر امکان پاسخ‌دهی به این نظرسنجی وجود ندارد.'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('survey-response-form')).not.toBeInTheDocument();
    });
  });

  describe('lifecycle, privacy and error states', () => {
    /**
     * `ChangeSurveyStatusDto` types `status` as 'PUBLISHED' | 'CLOSED', so un-publishing
     * is unrepresentable. Only transitions the server listed are offered, which means the
     * UI cannot propose a move the server would refuse.
     */
    it('offers only the transitions the server listed', async () => {
      getMock.mockResolvedValue(
        detail({ canManage: true, canRespond: false, availableTransitions: ['CLOSED'] }),
      );

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByTestId('survey-transition-CLOSED')).toHaveTextContent('بستن');
      expect(screen.queryByTestId('survey-transition-PUBLISHED')).not.toBeInTheDocument();
      expect(screen.queryByTestId('survey-transition-DRAFT')).not.toBeInTheDocument();
    });

    it('sends the chosen transition and adopts the server’s returned survey', async () => {
      getMock.mockResolvedValue(
        detail({
          canManage: true,
          canRespond: false,
          status: 'DRAFT',
          availableTransitions: ['PUBLISHED'],
        }),
      );
      statusMock.mockResolvedValue(
        detail({ canManage: true, canRespond: false, status: 'PUBLISHED', availableTransitions: ['CLOSED'] }),
      );

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-transition-PUBLISHED');

      await userEvent.click(screen.getByTestId('survey-transition-PUBLISHED'));

      await waitFor(() => expect(statusMock).toHaveBeenCalledWith('s1', 'PUBLISHED'));
      expect(await screen.findByTestId('survey-transition-CLOSED')).toBeInTheDocument();
    });

    /** Deleting is a DRAFT-only affordance: a published survey is closed, never deleted. */
    it('offers deletion only while the survey is a draft', async () => {
      getMock.mockResolvedValue(
        detail({ canManage: true, canRespond: false, status: 'PUBLISHED' }),
      );

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByText('نظرسنجی رضایت');

      expect(screen.queryByRole('button', { name: 'حذف پیش‌نویس' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'ویرایش' })).not.toBeInTheDocument();
    });

    /**
     * The results shape carries NO respondent identifier of any kind, and the backend
     * enforces no minimum-respondent threshold. The notice must therefore describe what
     * results VIEWERS see, not promise that respondents cannot be identified.
     */
    it('states that identities are hidden from viewers without claiming anonymity', async () => {
      getMock.mockResolvedValue(detail({ canViewResults: true, canRespond: false }));
      resultsMock.mockResolvedValue(results({ responseCount: 1 }));

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-results');

      expect(
        screen.getByText('هویت پاسخ‌دهندگان برای مشاهده‌کنندگان نتایج نمایش داده نمی‌شود.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/قابل شناسایی نیستند/)).not.toBeInTheDocument();
    });

    it('renders aggregate counts without any respondent field', async () => {
      getMock.mockResolvedValue(detail({ canViewResults: true, canRespond: false }));
      resultsMock.mockResolvedValue(results());

      render(<CoreSurveyDetailView surveyId="s1" />);
      await screen.findByTestId('survey-results');

      expect(await screen.findByText('تعداد پاسخ‌ها: ۴')).toBeInTheDocument();
      // 3 of 4 answered "زیاد" → 75%.
      expect(await screen.findByText('۳ (۷۵٪)')).toBeInTheDocument();
    });

    it('renders a 404 as a not-found message with no retry', async () => {
      getMock.mockRejectedValue(new CoreApiError('not found', 404));

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByRole('alert')).toHaveTextContent('نظرسنجی مورد نظر یافت نشد.');
      expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
    });

    /**
     * Cross-tenant surveys come back as 404, not 403, so the client cannot be used to
     * probe for the existence of another tenant's survey.
     */
    it('renders a 403 as forbidden, distinct from the cross-tenant 404', async () => {
      getMock.mockRejectedValue(new CoreApiError('forbidden', 403));

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'شما به این نظرسنجی دسترسی ندارید.',
      );
    });

    it('offers a retry on a transient load failure', async () => {
      getMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
      getMock.mockResolvedValueOnce(detail());

      render(<CoreSurveyDetailView surveyId="s1" />);

      expect(await screen.findByRole('alert')).toHaveTextContent('خطای سرور');

      await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

      expect(await screen.findByTestId('survey-response-form')).toBeInTheDocument();
    });
  });
});
