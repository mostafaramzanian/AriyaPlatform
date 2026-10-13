import { COMMERCE_DOCUMENT_STATUSES, COMMERCE_WORKFLOW_VERSION_STATUSES } from '../commerce-api';
import {
  commerceActionErrorMessage,
  commerceApprovalDecisionLabel,
  commerceApprovalDecisionTone,
  commerceApprovalStatusLabel,
  commerceApprovalStatusTone,
  commerceAssignmentSourceLabel,
  commerceAssignmentStatusLabel,
  commerceCommercialApprovalActivationLabel,
  commerceCommercialApprovalApproverLabel,
  commerceCommercialAssignmentTriggerLabel,
  commerceCommercialMatchBehaviorLabel,
  commerceCommercialNoAssignmentBehaviorLabel,
  commerceCommercialProjectionPolicyLabel,
  commerceComparisonOperatorLabel,
  commerceDateLabel,
  commerceDisplayName,
  commerceDocumentKindLabel,
  commerceDocumentStatusLabel,
  commerceDocumentStatusTone,
  commerceInstantLabel,
  commerceLineTypeLabel,
  commerceMoneyLabel,
  commercePaymentMethodLabel,
  commercePaymentStatusLabel,
  commerceReceivingStatusLabel,
  commerceReturnStateLabel,
  commerceRuleFactLabel,
  commerceWorkflowActorSourceLabel,
  commerceWorkflowConditionFalseBehaviorLabel,
  commerceWorkflowParallelJoinPolicyLabel,
  commerceWorkflowRefusalLabel,
  commerceWorkflowStepExecutionModeLabel,
  commerceWorkflowTriggerEventLabel,
  commerceWorkflowVersionStatusLabel,
  commerceWorkflowVersionStatusHint,
  commerceWorkflowVersionStatusTone,
  COMMERCE_RETURN_CHAIN,
} from '../commerce-labels';
import { CoreApiError } from '../core-http';

/**
 * PHASE UI-1: the labels module's contract.
 *
 * The point of these specs is the two rules that could otherwise rot silently: every
 * CONFIRMED backend value renders as Persian product language (never as its raw token),
 * and an UNKNOWN value renders as itself — the honest fallback `hrRecordStatusLabel`
 * established, not an invented label for a state nobody defined.
 */
describe('commerce-labels — the document lifecycle', () => {
  it('has a Persian word and a tone for every confirmed status', () => {
    for (const status of COMMERCE_DOCUMENT_STATUSES) {
      const label = commerceDocumentStatusLabel(status);
      expect(label).not.toBe(status);
      expect(label.length).toBeGreaterThan(0);
      expect(['ok', 'muted', 'danger', 'info']).toContain(commerceDocumentStatusTone(status));
    }
  });

  it('uses the UI-0 vocabulary for the load-bearing states', () => {
    expect(commerceDocumentStatusLabel('DRAFT')).toBe('پیش‌نویس');
    expect(commerceDocumentStatusLabel('SUBMITTED')).toBe('در حال بررسی');
    expect(commerceDocumentStatusTone('APPROVED')).toBe('ok');
    expect(commerceDocumentStatusTone('REJECTED')).toBe('danger');
    expect(commerceDocumentStatusTone('SUBMITTED')).toBe('info');
  });

  it('returns the raw token for a status this client does not know — never an invented word', () => {
    expect(commerceDocumentStatusLabel('ON_HOLD')).toBe('ON_HOLD');
    expect(commerceDocumentStatusTone('ON_HOLD')).toBe('muted');
  });
});

describe('commerce-labels — kind, lines and approvals', () => {
  it('names the document kind and every line type', () => {
    expect(commerceDocumentKindLabel('PURCHASE_REQUEST')).toBe('درخواست خرید');
    expect(commerceLineTypeLabel('STANDARD')).toBe('استاندارد');
    expect(commerceLineTypeLabel('NON_STANDARD')).toBe('غیراستاندارد');
    expect(commerceLineTypeLabel('SERVICE')).toBe('خدمات');
  });

  it('falls back to raw tokens for unknown kind and line type values', () => {
    expect(commerceDocumentKindLabel('RFQ')).toBe('RFQ');
    expect(commerceLineTypeLabel('EXPENSE')).toBe('EXPENSE');
  });

  it('names the commercial-approval lifecycle and tones it', () => {
    expect(commerceApprovalStatusLabel('PENDING')).toBe('در انتظار تصمیم');
    expect(commerceApprovalStatusLabel('APPROVED')).toBe('تأییدشده');
    expect(commerceApprovalStatusLabel('REJECTED')).toBe('ردشده');
    expect(commerceApprovalStatusTone('PENDING')).toBe('info');
    expect(commerceApprovalStatusTone('APPROVED')).toBe('ok');
    expect(commerceApprovalStatusTone('REJECTED')).toBe('danger');
    expect(commerceApprovalStatusLabel('CANCELLED')).toBe('CANCELLED');
    expect(commerceApprovalStatusTone('CANCELLED')).toBe('muted');
  });
});

describe('commerce-labels — names, money and dates', () => {
  it('renders a person name, and the fallback when the profile is absent or empty', () => {
    expect(
      commerceDisplayName(
        {
          id: 'u-1',
          firstName: 'سارا',
          lastName: 'محمدی',
          avatarUrl: null,
          jobTitle: null,
          department: null,
        },
        'بدون پروفایل'
      )
    ).toBe('سارا محمدی');
    expect(commerceDisplayName(null, 'بدون پروفایل')).toBe('بدون پروفایل');
    expect(
      commerceDisplayName(
        {
          id: 'u-2',
          firstName: null,
          lastName: null,
          avatarUrl: null,
          jobTitle: null,
          department: null,
        },
        'بدون نام'
      )
    ).toBe('بدون نام');
  });

  it('formats exact decimal strings without re-rounding, and appends the currency code', () => {
    const format = (value: number) =>
      new Intl.NumberFormat('fa-IR', {
        maximumFractionDigits: 4,
        minimumFractionDigits: 0,
        useGrouping: true,
      }).format(value);

    expect(commerceMoneyLabel('1250.0000', 'IRR')).toBe(`${format(1250)} IRR`);
    expect(commerceMoneyLabel('1250.5000', 'IRR')).toBe(`${format(1250.5)} IRR`);
    expect(commerceMoneyLabel('1250.0000', null)).toBe(format(1250));
  });

  it('renders an unstated amount as a dash — never as zero', () => {
    expect(commerceMoneyLabel(null, 'IRR')).toBe('—');
  });

  it('returns an unparseable amount as-is rather than guessing', () => {
    expect(commerceMoneyLabel('not-a-number', 'IRR')).toBe('not-a-number');
  });

  it('renders Jalali dates with Persian digits, and dashes/raw input for absence/defects', () => {
    const expected = new Intl.DateTimeFormat('fa-IR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'Asia/Tehran',
    }).format(new Date('2026-02-01T08:00:00.000Z'));

    expect(commerceDateLabel('2026-02-01T08:00:00.000Z')).toBe(expected);
    expect(commerceDateLabel(null)).toBe('—');
    expect(commerceDateLabel('not-a-date')).toBe('not-a-date');
    expect(commerceInstantLabel('2026-02-01T08:00:00.000Z')).toContain('،');
  });
});

/**
 * PHASE UI-2 — the vocabulary added for the detail workspace and one central
 * mutation-error mapping. The labels are pinned so a status can never be rendered with a
 * second, different word in another section.
 */
describe('commerce-labels — UI-2 vocabulary', () => {
  it('names every payment method and every payment status exactly once', () => {
    expect(commercePaymentMethodLabel('CASH')).toBe('نقد');
    expect(commercePaymentMethodLabel('PETTY_CASH')).toBe('تنخواه');
    expect(commercePaymentMethodLabel('CHECK')).toBe('چک');

    expect(commercePaymentStatusLabel('UNPAID')).toBe('پرداخت‌نشده');
    expect(commercePaymentStatusLabel('PARTIAL')).toBe('پرداخت جزئی');
    expect(commercePaymentStatusLabel('PAID')).toBe('پرداخت‌شده');
    expect(commercePaymentStatusLabel('OVERPAID')).toBe('بیش‌پرداخت');
    // `null` is NOT «پرداخت‌نشده»: an unstated total is a different fact (C1-Q rule 1).
    expect(commercePaymentStatusLabel(null)).toBe('جمع کل اعلام نشده');
  });

  it('names the receiving projection and the return lifecycle', () => {
    expect(commerceReceivingStatusLabel('NOT_RECEIVED')).toBe('دریافت‌نشده');
    expect(commerceReceivingStatusLabel('PARTIALLY_RECEIVED')).toBe('دریافت جزئی');
    expect(commerceReceivingStatusLabel('FULLY_RECEIVED')).toBe('دریافت کامل');

    expect(commerceReturnStateLabel('REQUESTED')).toBe('درخواست‌شده');
    expect(commerceReturnStateLabel('APPROVED')).toBe('تأییدشده');
    expect(commerceReturnStateLabel('RECEIVED_BACK')).toBe('کالا برگشت خورد');
    expect(commerceReturnStateLabel('REFUNDED')).toBe('بازپرداخت‌شده');
    expect(commerceReturnStateLabel('REJECTED')).toBe('ردشده');

    // The display chain marks where a return stands — it is not the transition matrix.
    expect([...COMMERCE_RETURN_CHAIN]).toEqual([
      'REQUESTED',
      'APPROVED',
      'RECEIVED_BACK',
      'REFUNDED',
    ]);
  });

  it('names assignment states and their sources, falling back to the raw token', () => {
    expect(commerceAssignmentStatusLabel('ASSIGNED')).toBe('واگذارشده');
    expect(commerceAssignmentStatusLabel('UNASSIGNED')).toBe('واگذارنشده');
    expect(commerceAssignmentSourceLabel('MANUAL')).toBe('دستی');
    expect(commerceAssignmentSourceLabel('FUTURE_SOURCE')).toBe('FUTURE_SOURCE');
  });
});

describe('commerce-labels — the central mutation-error mapping', () => {
  const fallback = 'خطای پیش‌فرض';

  it('maps the receiving over-receipt refusal with the server’s own quantities, in Persian digits', () => {
    const error = new CoreApiError(
      'Receiving line 1 would exceed its ordered quantity: ordered 100.0000, already received 90.0000, requested 20.0000',
      409
    );

    const message = commerceActionErrorMessage(error, fallback);

    expect(message).toContain('بیشتر است');
    expect(message).toContain('۱۰۰'); // Persian digits, values quoted from the server
    expect(message).toContain('۹۰');
    expect(message).toContain('۲۰');
  });

  it('maps the return refusals, and the payment double-compensation refusal', () => {
    expect(
      commerceActionErrorMessage(
        new CoreApiError(
          'Only a return in APPROVED may be received back; this return is REQUESTED',
          409
        ),
        fallback
      )
    ).toContain('وضعیت');
    expect(
      commerceActionErrorMessage(
        new CoreApiError('Refund compensation failed: The payment already has a compensating row: x', 409),
        fallback
      )
    ).toContain('بازپرداخت انجام نشد');
    expect(
      commerceActionErrorMessage(
        new CoreApiError('The payment already has a compensating row: abc', 409),
        fallback
      )
    ).toContain('جبران شده');
  });

  it('falls back to HTTP classes for unknown refusals — never the raw code', () => {
    expect(commerceActionErrorMessage(new CoreApiError('nope', 400), fallback)).toContain(
      'معتبر نیست'
    );
    expect(commerceActionErrorMessage(new CoreApiError('nope', 403), fallback)).toContain('مجوز');
    expect(commerceActionErrorMessage(new CoreApiError('nope', 404), fallback)).toContain(
      'یافت نشد'
    );
    expect(commerceActionErrorMessage(new CoreApiError('nope', 409), fallback)).toContain(
      'تغییر کرده'
    );
    expect(commerceActionErrorMessage(new CoreApiError('nope', 500), fallback)).toContain('سرور');
    // A network-shaped failure that is not a CoreApiError: the caller's own sentence.
    expect(commerceActionErrorMessage(new Error('fetch failed'), fallback)).toBe(fallback);
  });
});

/**
 * PHASE UI-3 — the commercial DECISION vocabulary and the three refusals
 * `CommercialLifecycleService.decide` can throw, matched on their own words.
 */
describe('commerce-labels — UI-3 decision vocabulary', () => {
  it('names the two decision actions as actions, not as states', () => {
    expect(commerceApprovalDecisionLabel('APPROVED')).toBe('تأیید بازرگانی');
    expect(commerceApprovalDecisionLabel('REJECTED')).toBe('رد بازرگانی');
    // The STATE labels from UI-1 are untouched and different words.
    expect(commerceApprovalStatusLabel('APPROVED')).toBe('تأییدشده');
    expect(commerceApprovalDecisionTone('REJECTED')).toBe('danger');
    expect(commerceApprovalDecisionTone('APPROVED')).toBe('ok');
    expect(commerceApprovalDecisionLabel('UNKNOWN')).toBe('UNKNOWN');
  });

  it('maps the actor-mismatch refusal — only the stored approver may decide', () => {
    const message = commerceActionErrorMessage(
      new CoreApiError('Only the approver resolved at activation may decide this record (§3-G).', 400),
      'fallback'
    );
    expect(message).toContain('تصمیم‌گیرندهٔ تعیین‌شده');
  });

  it('maps the two not-pending refusals — already decided, and the concurrent race', () => {
    expect(
      commerceActionErrorMessage(
        new CoreApiError('This commercial approval is already APPROVED.', 409),
        'fallback'
      )
    ).toContain('دیگر در انتظار تصمیم نیست');
    expect(
      commerceActionErrorMessage(
        new CoreApiError('This commercial approval was decided while this request was being applied.', 409),
        'fallback'
      )
    ).toContain('همزمان با درخواست شما');
  });

  it('maps a missing approval into the generic not-found sentence (no id probing)', () => {
    expect(
      commerceActionErrorMessage(new CoreApiError('Commercial approval not found', 404), 'fallback')
    ).toContain('یافت نشد');
  });
});

// =============================================================================
// PHASE UI-4 — configuration vocabulary (C1-M / C1-P)
// =============================================================================

describe('commerce-labels — UI-4 configuration vocabulary', () => {
  it('names every workflow version state as Persian product language with a hint', () => {
    for (const status of COMMERCE_WORKFLOW_VERSION_STATUSES) {
      const label = commerceWorkflowVersionStatusLabel(status);
      expect(label).not.toBe(status);
      expect(label.length).toBeGreaterThan(0);
      expect(commerceWorkflowVersionStatusTone(status)).toBeTruthy();
      expect(commerceWorkflowVersionStatusHint(status).length).toBeGreaterThan(0);
    }

    expect(commerceWorkflowVersionStatusLabel('DRAFT')).toBe('پیش‌نویس');
    expect(commerceWorkflowVersionStatusLabel('PUBLISHED')).toBe('منتشرشده');
    expect(commerceWorkflowVersionStatusTone('PUBLISHED')).toBe('ok');
    expect(commerceWorkflowVersionStatusHint('PUBLISHED')).toContain('قابل ویرایش نیست');
    // Unknown tokens fall back to themselves — never an invented word.
    expect(commerceWorkflowVersionStatusLabel('LIVE')).toBe('LIVE');
    expect(commerceWorkflowVersionStatusHint('LIVE')).toBe('');
  });

  it('names the step modes, actor sources and false-path behaviours', () => {
    expect(commerceWorkflowStepExecutionModeLabel('SEQUENTIAL')).toBe('ترتیبی');
    expect(commerceWorkflowStepExecutionModeLabel('PARALLEL')).toBe('موازی');
    expect(commerceWorkflowStepExecutionModeLabel('CONDITIONAL')).toBe('شرطی');

    expect(commerceWorkflowActorSourceLabel('REQUESTER_MANAGER')).toBe('مدیر درخواست‌کننده');
    expect(commerceWorkflowActorSourceLabel('CONFIGURED_USER')).toBe('کاربر مشخص');
    expect(commerceWorkflowActorSourceLabel('X')).toBe('X');

    expect(commerceWorkflowConditionFalseBehaviorLabel('SKIPPED')).toContain('ادامه');
    expect(commerceWorkflowConditionFalseBehaviorLabel('BLOCKED')).toContain('پذیرفته نمی‌شود');

    expect(commerceWorkflowTriggerEventLabel('PURCHASE_SUBMITTED')).toContain('ثبت درخواست');
    expect(commerceWorkflowParallelJoinPolicyLabel('ALL')).toContain('همه');
  });

  it('names the frozen facts and the operators the simple editor authors', () => {
    expect(commerceRuleFactLabel('totalAmount')).toBe('مبلغ کل');
    expect(commerceRuleFactLabel('lineType')).toBe('نوع ردیف');
    expect(commerceRuleFactLabel('madeUpFact')).toBe('madeUpFact');

    expect(commerceComparisonOperatorLabel('greaterThan')).toBe('بیشتر است از');
    expect(commerceComparisonOperatorLabel('isEmpty')).toBe('خالی است');
    expect(commerceComparisonOperatorLabel('dateBetween')).toBe('dateBetween');
  });

  it('names every commercial configuration vocabulary member', () => {
    expect(commerceCommercialAssignmentTriggerLabel('PURCHASE_SUBMITTED')).toContain('ثبت درخواست');
    expect(commerceCommercialNoAssignmentBehaviorLabel('LEAVE_UNASSIGNED')).toContain('بدون گروه');
    expect(commerceCommercialMatchBehaviorLabel('HIGHEST_PRIORITY')).toContain('بالاترین');
    expect(commerceCommercialApprovalActivationLabel('NOT_REQUIRED')).toContain('لازم نیست');
    expect(commerceCommercialApprovalApproverLabel('LINE_COMMERCIAL_LIAISON')).toContain('رابط');
    expect(commerceCommercialProjectionPolicyLabel('ALL_LINES')).toContain('ردیف');
    expect(commerceCommercialProjectionPolicyLabel('X')).toBe('X');
  });
});

describe('commerce-labels — UI-4 refusals and configuration errors', () => {
  it('translates every backend refusal code into a fix-it sentence', () => {
    const refusals = [
      'STEP_KEY_MISSING',
      'STEP_DISPLAY_NAME_MISSING',
      'STEP_PARALLEL_GROUP_MISSING',
      'STEP_CONDITION_REQUIRED',
      'STEP_ACTOR_SOURCE_MISSING',
      'WORKFLOW_TRIGGER_MISSING',
      'WORKFLOW_JOIN_POLICY_MISSING',
      'WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED',
      'WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING',
      'WORKFLOW_ACTOR_SOURCE_UNSUPPORTED',
      'WORKFLOW_LINE_SCOPE_UNSUPPORTED',
      'WORKFLOW_STEP_COUNT_EXCEEDED',
      'WORKFLOW_SELECTION_RULE_INVALID',
      'WORKFLOW_VERSION_RULE_INVALID',
      'VERSION_HAS_NO_STEPS',
      'STEP_KEY_DUPLICATED',
      'STEP_ORDERING_DUPLICATED',
    ];

    for (const refusal of refusals) {
      const label = commerceWorkflowRefusalLabel(refusal);
      expect(label).not.toBe(refusal);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(commerceWorkflowRefusalLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('maps the configuration refusals the lifecycle throws into Persian sentences', () => {
    expect(
      commerceActionErrorMessage(
        new CoreApiError('A workflow definition already uses the code "standard".', 409),
        'fallback'
      )
    ).toContain('کد');

    expect(
      commerceActionErrorMessage(
        new CoreApiError(
          'This workflow version is no longer a DRAFT, so its steps may not change.',
          409
        ),
        'fallback'
      )
    ).toContain('نسخهٔ جدید');

    expect(
      commerceActionErrorMessage(
        new CoreApiError('The workflow version does not pass the configuration checks.', 400),
        'fallback'
      )
    ).toContain('موارد گزارش‌شده');

    expect(
      commerceActionErrorMessage(
        new CoreApiError('A published configuration is immutable; publish a new version instead.', 409),
        'fallback'
      )
    ).toContain('تغییرپذیر نیست');

    expect(
      commerceActionErrorMessage(
        new CoreApiError('A commercial group with code IT already exists in this tenant.', 409),
        'fallback'
      )
    ).toContain('گروهی با همین کد');

    expect(
      commerceActionErrorMessage(
        new CoreApiError('§7.5: approverUserId is not a member of this tenant.', 409),
        'fallback'
      )
    ).toContain('عضو این سازمان نیست');

    expect(
      commerceActionErrorMessage(
        new CoreApiError(
          '§7.8: approvalActivation PURCHASE_SUBMITTED requires an approvalApprover.',
          409
        ),
        'fallback'
      )
    ).toContain('تصمیم‌گیرنده');
  });
});
