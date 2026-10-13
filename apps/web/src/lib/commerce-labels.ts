import { toPersianDigits } from './calendar-api';
import type {
  CommerceApprovalDecision,
  CommerceApprovalStatus,
  CommerceAssignmentSource,
  CommerceAssignmentState,
  CommerceCommercialApprovalActivation,
  CommerceCommercialApprovalApprover,
  CommerceCommercialMatchBehavior,
  CommerceCommercialNoAssignmentBehavior,
  CommerceCommercialProjectionPolicy,
  CommerceDocumentKind,
  CommerceDocumentStatus,
  CommerceIdentity,
  CommerceLineType,
  CommercePaymentMethod,
  CommercePaymentStatus,
  CommerceReceivingStatus,
  CommerceReturnState,
  CommerceWorkflowActorSource,
  CommerceWorkflowConditionFalseBehavior,
  CommerceWorkflowParallelJoinPolicy,
  CommerceWorkflowStepExecutionMode,
  CommerceWorkflowTriggerEvent,
  CommerceWorkflowVersionStatus,
} from './commerce-api';
import { CoreApiError } from './core-http';

/**
 * PHASE UI-1: the ONE place a backend Commerce concept becomes Persian product language.
 *
 * WHY A MODULE AND NOT STRINGS INSIDE COMPONENTS
 * ----------------------------------------------
 * The same state is rendered in several screens (register, home, tasks), and §1.5 of the
 * UI-0 contract requires one wording per concept: a status spelled two ways is how two
 * screens end up disagreeing about what the user is looking at. Every mapping below is
 * keyed by the BACKEND's own vocabulary (the tuples in `commerce-api.ts` mirror the
 * platform's enums), and every function falls back to the raw token for a value this
 * client does not know — mirroring `hrRecordStatusLabel`'s `?? status`: showing the
 * machine value is honest; inventing a Persian label for a state nobody defined is not.
 *
 * NO BUSINESS LOGIC LIVES HERE. These are words, tones and formats — no rule about what a
 * status MEANS, nothing that decides anything, and no computation over more than the one
 * value it renders. UI-2 adds ONE function that is still vocabulary rather than rule:
 * `commerceActionErrorMessage` turns a failed mutation into the sentence a person reads,
 * from a fixed table of KNOWN backend refusals plus HTTP-class fallbacks — the UI-2 §27
 * "map errors centrally" requirement, in the same module §1.5 already designates as the
 * single home of Commerce product language.
 */

/** The tones a Commerce badge may carry. `info` is the neutral in-flight tint. */
export type CommerceTone = 'ok' | 'muted' | 'danger' | 'info';

/** The document lifecycle, in product language. */
const DOCUMENT_STATUS_LABELS: Record<CommerceDocumentStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'در حال بررسی',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  CANCELLED: 'لغوشده',
  CLOSED: 'بسته‌شده',
};

export function commerceDocumentStatusLabel(status: string): string {
  return DOCUMENT_STATUS_LABELS[status as CommerceDocumentStatus] ?? status;
}

/**
 * Tone is a SECOND, redundant channel — the word is primary (§19.8 of the UI-0 contract).
 * `SUBMITTED` is `info` because it is in flight, not a success and not a failure.
 */
export function commerceDocumentStatusTone(status: string): CommerceTone {
  if (status === 'APPROVED') return 'ok';
  if (status === 'REJECTED') return 'danger';
  if (status === 'SUBMITTED') return 'info';
  return 'muted';
}

const DOCUMENT_KIND_LABELS: Record<CommerceDocumentKind, string> = {
  PURCHASE_REQUEST: 'درخواست خرید',
};

export function commerceDocumentKindLabel(kind: string): string {
  return DOCUMENT_KIND_LABELS[kind as CommerceDocumentKind] ?? kind;
}

const LINE_TYPE_LABELS: Record<CommerceLineType, string> = {
  STANDARD: 'استاندارد',
  NON_STANDARD: 'غیراستاندارد',
  SERVICE: 'خدمات',
};

export function commerceLineTypeLabel(lineType: string): string {
  return LINE_TYPE_LABELS[lineType as CommerceLineType] ?? lineType;
}

/** The commercial-approval lifecycle, in product language. */
const APPROVAL_STATUS_LABELS: Record<CommerceApprovalStatus, string> = {
  PENDING: 'در انتظار تصمیم',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
};

export function commerceApprovalStatusLabel(status: string): string {
  return APPROVAL_STATUS_LABELS[status as CommerceApprovalStatus] ?? status;
}

export function commerceApprovalStatusTone(status: string): CommerceTone {
  if (status === 'APPROVED') return 'ok';
  if (status === 'REJECTED') return 'danger';
  if (status === 'PENDING') return 'info';
  return 'muted';
}

/** A person's display name, or the caller's fallback — never an id, never empty. */
export function commerceDisplayName(identity: CommerceIdentity | null, fallback: string): string {
  if (!identity) return fallback;
  const name = [identity.firstName, identity.lastName].filter(Boolean).join(' ');
  return name.length > 0 ? name : fallback;
}

/**
 * `Asia/Tehran` — the API's own `APP_TIME_ZONE` display convention (the same constant
 * `hr-api` restates). A FORMAT is a decision about where to READ an instant, never about
 * what was stored: the exact ISO string stays the cell's `title` wherever a screen renders
 * one of these labels.
 */
const DISPLAY_TIME_ZONE = 'Asia/Tehran';

const MONEY_FORMAT = new Intl.NumberFormat('fa-IR', {
  maximumFractionDigits: 4,
  minimumFractionDigits: 0,
  useGrouping: true,
});

/**
 * An exact `Decimal(18,4)` wire STRING as a display label.
 *
 * THE VALUE IS NEVER RE-ROUNDED OR RE-SCALED: the string is formatted as the number it
 * represents (four decimals is the wire's ceiling, so no digit can be lost), trailing
 * zeros after the decimal point fall away because they carry no information
 * ("1250.0000" is «۱٬۲۵۰»), and the currency CODE is appended verbatim when the document
 * states one. `null` — "not priced" — is «—», never ۰: an unpriced document and a
 * zero-priced one are different facts (UI-0 §1.5).
 */
export function commerceMoneyLabel(amount: string | null, currency: string | null): string {
  if (amount === null) return '—';

  const value = Number(amount);
  if (Number.isNaN(value)) return amount;

  const formatted = MONEY_FORMAT.format(value);
  return currency ? `${formatted} ${currency}` : formatted;
}

/** A Jalali calendar date for an instant, `—` when there is none, the input if unparseable. */
export function commerceDateLabel(iso: string | null): string {
  if (!iso) return '—';

  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;

  return new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(instant);
}

/** A Jalali date AND 24-hour time for an instant — «۱۴۰۵/۰۷/۰۸، ۱۳:۴۵». */
export function commerceInstantLabel(iso: string | null): string {
  if (!iso) return '—';

  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;

  const date = new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(instant);

  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(instant);

  return `${date}، ${toPersianDigits(time)}`;
}

// =============================================================================
// PHASE UI-2 — payment vocabulary (C1-Q)
// =============================================================================

/**
 * Payment methods, in product language — closed at the backend's three members.
 * `CHECK` is a METHOD this tenant states, not an entity: no cheque/Finance model
 * exists here, and none is implied by this word.
 */
const PAYMENT_METHOD_LABELS: Record<CommercePaymentMethod, string> = {
  CASH: 'نقد',
  PETTY_CASH: 'تنخواه',
  CHECK: 'چک',
};

export function commercePaymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method as CommercePaymentMethod] ?? method;
}

/**
 * The payment projection, in product language. `null` is deliberately NOT mapped to
 * «پرداخت‌نشده»: an unstated total is «جمع کل اعلام نشده» — a different fact (C1-Q rule 1).
 */
const PAYMENT_STATUS_LABELS: Record<CommercePaymentStatus, string> = {
  UNPAID: 'پرداخت‌نشده',
  PARTIAL: 'پرداخت جزئی',
  PAID: 'پرداخت‌شده',
  OVERPAID: 'بیش‌پرداخت',
};

export function commercePaymentStatusLabel(status: CommercePaymentStatus | null): string {
  if (status === null) return 'جمع کل اعلام نشده';
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

export function commercePaymentStatusTone(status: CommercePaymentStatus | null): CommerceTone {
  if (status === 'PAID') return 'ok';
  if (status === 'OVERPAID') return 'danger';
  if (status === 'PARTIAL') return 'info';
  return 'muted';
}

// =============================================================================
// PHASE UI-2 — receiving vocabulary (C1-R)
// =============================================================================

const RECEIVING_STATUS_LABELS: Record<CommerceReceivingStatus, string> = {
  NOT_RECEIVED: 'دریافت‌نشده',
  PARTIALLY_RECEIVED: 'دریافت جزئی',
  FULLY_RECEIVED: 'دریافت کامل',
};

export function commerceReceivingStatusLabel(status: string): string {
  return RECEIVING_STATUS_LABELS[status as CommerceReceivingStatus] ?? status;
}

export function commerceReceivingStatusTone(status: string): CommerceTone {
  if (status === 'FULLY_RECEIVED') return 'ok';
  if (status === 'PARTIALLY_RECEIVED') return 'info';
  return 'muted';
}

// =============================================================================
// PHASE UI-2 — return vocabulary (C1-S): a child lifecycle, own words
// =============================================================================

const RETURN_STATE_LABELS: Record<CommerceReturnState, string> = {
  REQUESTED: 'درخواست‌شده',
  APPROVED: 'تأییدشده',
  RECEIVED_BACK: 'کالا برگشت خورد',
  REFUNDED: 'بازپرداخت‌شده',
  REJECTED: 'ردشده',
};

export function commerceReturnStateLabel(state: string): string {
  return RETURN_STATE_LABELS[state as CommerceReturnState] ?? state;
}

export function commerceReturnStateTone(state: string): CommerceTone {
  if (state === 'REJECTED') return 'danger';
  if (state === 'REQUESTED') return 'info';
  if (state === 'APPROVED' || state === 'RECEIVED_BACK' || state === 'REFUNDED') return 'ok';
  return 'muted';
}

/**
 * The four allowed transitions as a display chain (S-D2) — used to MARK where a
 * return stands, never to decide anything: the backend matrix remains the only
 * authority on which command is legal.
 */
export const COMMERCE_RETURN_CHAIN = ['REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED'] as const;

// =============================================================================
// PHASE UI-2 — commercial assignment vocabulary (C1-P)
// =============================================================================

const ASSIGNMENT_STATE_LABELS: Record<CommerceAssignmentState, string> = {
  ASSIGNED: 'واگذارشده',
  UNASSIGNED: 'واگذارنشده',
};

export function commerceAssignmentStatusLabel(status: string): string {
  return ASSIGNMENT_STATE_LABELS[status as CommerceAssignmentState] ?? status;
}

export function commerceAssignmentStatusTone(status: string): CommerceTone {
  if (status === 'ASSIGNED') return 'info';
  return 'muted';
}

const ASSIGNMENT_SOURCE_LABELS: Record<CommerceAssignmentSource, string> = {
  PURCHASE_SUBMITTED: 'هنگام ثبت درخواست',
  AFTER_DOCUMENT_WORKFLOW_APPROVED: 'پس از تأیید گردش کار',
  MANUAL: 'دستی',
};

export function commerceAssignmentSourceLabel(source: string): string {
  return ASSIGNMENT_SOURCE_LABELS[source as CommerceAssignmentSource] ?? source;
}

// =============================================================================
// PHASE UI-3 — commercial DECISION vocabulary (C1-P §9)
// =============================================================================

/**
 * The two decision ACTIONS in product language — the labels a decision button wears.
 * (`commerceApprovalStatusLabel` remains the word for the record's STATE after the
 * decision; this is the word for the CHOICE the decider makes.)
 */
const APPROVAL_DECISION_LABELS: Record<CommerceApprovalDecision, string> = {
  APPROVED: 'تأیید بازرگانی',
  REJECTED: 'رد بازرگانی',
};

export function commerceApprovalDecisionLabel(decision: string): string {
  return APPROVAL_DECISION_LABELS[decision as CommerceApprovalDecision] ?? decision;
}

/** Tone for a decision button — redundant with its explicit word, never a replacement. */
export function commerceApprovalDecisionTone(decision: string): 'ok' | 'danger' {
  return decision === 'REJECTED' ? 'danger' : 'ok';
}

// =============================================================================
// PHASE UI-2 — ONE central mutation-error → Persian product language mapping
// =============================================================================

/**
 * Phase REPORTING-PURCHASE-REPORT: the audit actions the purchase report's flow section
 * renders, in product language.
 *
 * WHY THIS MAP LIVES HERE AND NOT BESIDE THE REPORT. This file is designated (§1.5) as
 * the single home of Commerce product language — status words, kind words, error
 * sentences — and the platform trail stores RAW verbs precisely so presentation can
 * change without rewriting history. The vocabulary is closed by what
 * `PURCHASE_AUDIT_ACTION` and the later Commerce steps actually emit; an unknown verb
 * falls through to itself rather than being hidden, because a trail entry the UI
 * cannot translate is still a fact that happened.
 *
 * No action is invented here: every key below is a verb a Commerce service writes
 * through `CommerceAuditGateway`, and no key exists for a verb nobody writes.
 *
 * Two UI-5-honesty constraints, recorded so the map stays inside them: the labels
 * never use the bare product term the final gate refuses (the document is the
 * «سند درخواست خرید», never the bare synonym), and nothing here names a Close
 * CONTROL (C4-R §30 defers the close control to a later UI task — the COMPLETION
 * trail verb is translated as the document's state change, not as a button the
 * report does not offer).
 */
const PURCHASE_AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'ایجاد درخواست خرید',
  update: 'ویرایش درخواست خرید',
  submit: 'ارجاع برای تصمیم',
  complete: 'تکمیل سند درخواست خرید',
};

export function commercePurchaseAuditActionLabel(action: string): string {
  return PURCHASE_AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * The single place a failed Commerce MUTATION becomes a sentence a person can act on.
 * Sections must not re-parse errors individually (UI-2 §27): the ladder is
 *
 *   1. a KNOWN backend refusal (matched on the exact message the C1 service throws)
 *      → its own Persian sentence, including the quantities the server stated;
 *   2. a known HTTP class (400/403/404/409/500) → its product-language fallback;
 *   3. the caller's `fallback`.
 *
 * Raw status codes and raw English technical sentences are never the PRIMARY message.
 * Matching is on `CoreApiError.message`, which `core-http` fills from the response
 * body's own `message` — so a refusal we do not recognise still reaches the user as
 * the caller's neutral fallback rather than as an untranslated server string. This is
 * a WORD mapping, not a rule: it decides nothing about what the backend refused.
 */
export function commerceActionErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  const status = error instanceof CoreApiError ? error.status : null;

  // 1. Known refusals — needles from the C1 services' own throw sites.
  if (/would exceed its ordered quantity/i.test(message)) {
    const numbers = message.match(
      /ordered ([\d.]+), already received ([\d.]+), requested ([\d.]+)/i
    );
    return numbers
      ? `این دریافت از مقدار سفارش‌داده‌شده بیشتر است (سفارش: ${toPersianDigits(
          numbers[1]
        )}، دریافت‌شده: ${toPersianDigits(numbers[2])}، درخواستی: ${toPersianDigits(numbers[3])}).`
      : 'این دریافت از مقدار سفارش‌داده‌شده بیشتر است.';
  }
  if (/Return quantity exceeds the net received quantity/i.test(message)) {
    return 'مقدار مرجوعی از مقدار خالص دریافت‌شدهٔ این ردیف بیشتر است. مقادیر دریافت و مرجوعی را بررسی کنید.';
  }
  if (/Only a return in .* may be/i.test(message)) {
    return 'این مرجوعی در وضعیتی نیست که این اقدام روی آن انجام شود. وضعیت فعلی را بازخوانی کنید.';
  }
  if (/line_reference_mismatch|receipt line does not belong/i.test(message)) {
    return 'ردیف مرجوعی با رسید موردنظر هم‌خوانی ندارد.';
  }
  if (/Refund compensation failed/i.test(message)) {
    return 'بازپرداخت انجام نشد و هیچ تغییری در وضعیت مرجوعی ثبت نشده است. وضعیت را بازخوانی کنید.';
  }
  if (/already has a compensating row/i.test(message)) {
    return 'این پرداخت پیش‌تر جبران شده و امکان جبران دوباره ندارد.';
  }
  if (/Compensation exceeds what remains on the receipt line/i.test(message)) {
    return 'مقدار جبران از باقی‌ماندهٔ قابل جبران این رسید بیشتر است.';
  }
  if (/cannot itself be compensated/i.test(message)) {
    return 'خودِ رویداد جبرانی قابل جبران نیست؛ رویداد اصلی را جبران کنید.';
  }
  if (/is no longer editable|left the editable state/i.test(message)) {
    return 'این سند دیگر قابل ویرایش نیست و فقط پیش‌نویس‌ها تغییر می‌پذیرند. وضعیت سند را بازخوانی کنید.';
  }
  if (/cannot be submitted|already submitted/i.test(message)) {
    return 'این سند در وضعیتی نیست که قابل ارسال باشد. وضعیت سند را بازخوانی کنید.';
  }
  if (/can no longer be assigned/i.test(message)) {
    return 'این سند در وضعیتی است که امکان واگذاری ردیف ندارد.';
  }
  if (/already assigned to that group and liaison/i.test(message)) {
    return 'این ردیف همین حالا به همین گروه و رابط واگذار شده است.';
  }
  if (/No commercial configuration is published/i.test(message)) {
    return 'هیچ پیکربندی بازرگانی منتشرشده‌ای وجود ندارد؛ پیش از واگذاری، پیکربندی را منتشر کنید.';
  }

  // Commercial DECISION refusals — needles from `CommercialLifecycleService.decide`.
  if (/Only the approver resolved at activation/i.test(message)) {
    return 'فقط تصمیم‌گیرندهٔ تعیین‌شده هنگام فعال‌سازی می‌تواند این تصمیم را ثبت کند.';
  }
  if (/This commercial approval is already/i.test(message)) {
    return 'این تأیید بازرگانی دیگر در انتظار تصمیم نیست؛ وضعیت آن را بازخوانی کنید.';
  }
  if (/was decided while this request was being applied/i.test(message)) {
    return 'همزمان با درخواست شما، تصمیم دیگری روی این مورد ثبت شد؛ وضعیت را بازخوانی کنید.';
  }

  // 1b. CONFIGURATION refusals — needles from `workflow-configuration.service.ts` /
  // `commercial-configuration.service.ts`. The workflow validate/publish walk answers with
  // a STRUCTURED report beside the message; screens render that report through
  // `commerceWorkflowRefusalLabel`, and these sentences cover the messages that arrive
  // without one.
  if (/A workflow definition already uses the code/i.test(message)) {
    return 'فرآیندی با همین کد از قبل وجود دارد؛ کد دیگری برگزینید.';
  }
  if (/This definition already has a version labelled/i.test(message)) {
    return 'نسخه‌ای با همین برچسب در این فرآیند وجود دارد؛ برچسب دیگری برگزینید.';
  }
  if (/does not pass the configuration checks/i.test(message)) {
    return 'نسخه از بررسی‌های پیکربندی عبور نکرد؛ موارد گزارش‌شده را اصلاح کنید.';
  }
  if (/already states a step with that key or that ordering/i.test(message)) {
    return 'کلید یا ترتیب این مرحله در نسخه تکراری است؛ مقادیر را اصلاح کنید.';
  }
  if (/no longer a DRAFT|is no longer a draft/i.test(message)) {
    return 'این نسخه دیگر پیش‌نویس نیست؛ برای تغییر، نسخهٔ جدید بسازید.';
  }
  if (/changed while this request was being applied/i.test(message)) {
    return 'هم‌زمان با درخواست شما، این پیکربندی از سوی دیگری تغییر کرد؛ آن را بازخوانی کنید.';
  }
  if (/The stated order must name every step/i.test(message)) {
    return 'ترتیب ارسالی با مراحل این نسخه هم‌خوانی ندارد؛ نسخه را بازخوانی کنید.';
  }
  if (/is not a member of this tenant/i.test(message)) {
    return 'کاربر انتخاب‌شده عضو این سازمان نیست.';
  }
  if (/A commercial group with code/i.test(message)) {
    return 'گروهی با همین کد از قبل وجود دارد؛ کد دیگری برگزینید.';
  }
  if (/A commercial configuration in status/i.test(message)) {
    return 'این پیکربندی در وضعیت کنونی تغییرپذیر نیست؛ نسخهٔ جدید بسازید.';
  }
  if (/A published configuration is immutable/i.test(message)) {
    return 'پیکربندی منتشرشده تغییرپذیر نیست؛ نسخهٔ جدید بسازید.';
  }
  if (/An archived configuration cannot be published/i.test(message)) {
    return 'پیکربندی آرشیوشده قابل انتشار نیست؛ نسخهٔ جدید بسازید.';
  }
  if (/Only a DRAFT configuration may be validated|may not be validated|may not be edited/i.test(message)) {
    return 'فقط پیش‌نویس پیکربندی قابل اعتبارسنجی یا ویرایش است؛ وضعیت آن را بازخوانی کنید.';
  }
  if (/is already archived/i.test(message)) {
    return 'این پیکربندی پیش‌تر آرشیو شده است.';
  }
  if (/could not be published from its current state|could not be archived from its current state/i.test(message)) {
    return 'وضعیت این پیکربندی تغییر کرده است؛ آن را بازخوانی کنید.';
  }
  if (/requires an approvalApprover/i.test(message)) {
    return 'برای این زمان فعال‌سازی، تعیین تصمیم‌گیرندهٔ تأیید بازرگانی لازم است.';
  }
  if (/requires approverUserId/i.test(message)) {
    return 'برای تصمیم‌گیرندهٔ «کاربر مشخص»، انتخاب کاربر لازم است.';
  }
  if (/is earlier than assignmentTrigger/i.test(message)) {
    return 'زمان فعال‌سازی تأیید بازرگانی نمی‌تواند پیش‌تر از زمان واگذاری ردیف‌ها باشد.';
  }
  if (/does not exist in this tenant/i.test(message)) {
    return 'گروه انتخاب‌شده در این سازمان وجود ندارد؛ گروه دیگری برگزینید.';
  }
  if (/duplicates the rule label/i.test(message)) {
    return 'دو قاعدهٔ هم‌نام برای یک گروه مجاز نیست؛ برچسب یکی را تغییر دهید.';
  }
  if (/the assignment rule set is invalid|the applicability condition is invalid/i.test(message)) {
    return 'شرط یکی از قواعد با فهرست واقعیت‌های مجاز هم‌خوان نیست.';
  }

  // 2. HTTP classes, only when no known refusal matched.
  if (status === 400) return 'اطلاعات واردشده معتبر نیست؛ فیلدها را بررسی کنید.';
  if (status === 403) return 'شما مجوز انجام این اقدام را ندارید.';
  if (status === 404) return 'مورد درخواستی یافت نشد.';
  if (status === 409) {
    return 'وضعیت سند از زمان باز شدن این صفحه تغییر کرده است؛ وضعیت را بازخوانی کنید.';
  }
  if (status !== null && status >= 500) return 'خطای سرور؛ چند لحظه دیگر دوباره تلاش کنید.';

  // 3. Caller's neutral fallback (network failure, unexpected shape, …).
  return fallback;
}


// =============================================================================
// PHASE UI-4 — CONFIGURATION vocabulary (C1-M workflow, C1-P commercial)
// =============================================================================

/**
 * The version lifecycle in the words an administrator reads. `PUBLISHED` is `ok` — it is
 * the version in force — and `VALIDATED` is `info`, because it is accepted but not yet
 * adopted. `DRAFT` and `ARCHIVED` are `muted`: neither is a live state.
 */
const WORKFLOW_VERSION_STATUS_LABELS: Record<CommerceWorkflowVersionStatus, string> = {
  DRAFT: 'پیش‌نویس',
  VALIDATED: 'اعتبارسنجی‌شده',
  PUBLISHED: 'منتشرشده',
  ARCHIVED: 'آرشیوشده',
};

export function commerceWorkflowVersionStatusLabel(status: string): string {
  return WORKFLOW_VERSION_STATUS_LABELS[status as CommerceWorkflowVersionStatus] ?? status;
}

export function commerceWorkflowVersionStatusTone(status: string): CommerceTone {
  if (status === 'PUBLISHED') return 'ok';
  if (status === 'VALIDATED') return 'info';
  return 'muted';
}

/**
 * One line of helper text per state, where the review UI needs to say what the state
 * MEANS — each sentence is the backend's own semantics, never a claim about effects.
 */
export function commerceWorkflowVersionStatusHint(status: string): string {
  if (status === 'DRAFT') return 'قابل ویرایش است؛ هنوز منتشر نشده است.';
  if (status === 'VALIDATED') return 'اعتبارسنجی شده و آمادهٔ انتشار است؛ هنوز در جریان نیست.';
  if (status === 'PUBLISHED') return 'این نسخه منتشر شده و قابل ویرایش نیست.';
  if (status === 'ARCHIVED') return 'این نسخه آرشیو شده و فقط برای مطالعه باقی می‌ماند.';
  return '';
}

/** The three execution modes of a step (§5.6/§5.10). */
const STEP_EXECUTION_MODE_LABELS: Record<CommerceWorkflowStepExecutionMode, string> = {
  SEQUENTIAL: 'ترتیبی',
  PARALLEL: 'موازی',
  CONDITIONAL: 'شرطی',
};

export function commerceWorkflowStepExecutionModeLabel(mode: string): string {
  return STEP_EXECUTION_MODE_LABELS[mode as CommerceWorkflowStepExecutionMode] ?? mode;
}

/** The six modelled actor sources (§5.8), as mechanisms — never as people. */
const ACTOR_SOURCE_LABELS: Record<CommerceWorkflowActorSource, string> = {
  REQUESTER_MANAGER: 'مدیر درخواست‌کننده',
  GROUP_MANAGER: 'مدیر واحد سازمانی درخواست‌کننده',
  COMMERCIAL_LIAISON: 'رابط بازرگانی',
  CONFIGURED_USER: 'کاربر مشخص',
  CONFIGURED_ROLE: 'دارندهٔ نقش مشخص',
  RULE_RESOLVER: 'تعیین بر اساس قاعده',
};

export function commerceWorkflowActorSourceLabel(source: string): string {
  return ACTOR_SOURCE_LABELS[source as CommerceWorkflowActorSource] ?? source;
}

/**
 * The false-path behaviours of a step's condition (§4). `BLOCKED` is worded with the
 * fact that matters: it is modelled, and publication refuses it today.
 */
const CONDITION_FALSE_BEHAVIOR_LABELS: Record<CommerceWorkflowConditionFalseBehavior, string> = {
  SKIPPED: 'نادیده گرفته شود و فرآیند ادامه یابد',
  BLOCKED: 'متوقف شود (امروز در انتشار پذیرفته نمی‌شود)',
  TERMINATED: 'فرآیند خاتمه یابد',
};

export function commerceWorkflowConditionFalseBehaviorLabel(behavior: string): string {
  return (
    CONDITION_FALSE_BEHAVIOR_LABELS[behavior as CommerceWorkflowConditionFalseBehavior] ?? behavior
  );
}

/** The trigger events (§2.1/§2.2) — when a version becomes a candidate. */
const TRIGGER_EVENT_LABELS: Record<CommerceWorkflowTriggerEvent, string> = {
  PURCHASE_SUBMITTED: 'هنگام ثبت درخواست خرید',
  AFTER_DOCUMENT_WORKFLOW_APPROVED: 'پس از تأیید گردش کار سند',
};

export function commerceWorkflowTriggerEventLabel(event: string): string {
  return TRIGGER_EVENT_LABELS[event as CommerceWorkflowTriggerEvent] ?? event;
}

/** How a group of parallel branches completes (§3). */
const PARALLEL_JOIN_POLICY_LABELS: Record<CommerceWorkflowParallelJoinPolicy, string> = {
  ALL: 'با تأیید همهٔ شاخه‌ها',
  ANY: 'با تأیید هر یک از شاخه‌ها',
};

export function commerceWorkflowParallelJoinPolicyLabel(policy: string): string {
  return PARALLEL_JOIN_POLICY_LABELS[policy as CommerceWorkflowParallelJoinPolicy] ?? policy;
}

/**
 * The frozen fact names, in the words an administrator reads. The names are the
 * engine's catalogue keys; these are only their display names, and an unknown key falls
 * back to itself (the honest fallback this module states once).
 */
const RULE_FACT_LABELS: Record<string, string> = {
  // Document facts (COMMERCE_WORKFLOW_FACT_CATALOGUE)
  kind: 'نوع سند',
  currency: 'واحد پول',
  supplierId: 'شناسهٔ تأمین‌کننده',
  requesterId: 'شناسهٔ درخواست‌کننده',
  subtotalAmount: 'مبلغ خالص',
  taxAmount: 'مبلغ مالیات',
  totalAmount: 'مبلغ کل',
  lineCount: 'تعداد ردیف‌ها',
  maxLineTotal: 'بیشترین مبلغ ردیف',
  // Line facts (COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE)
  lineType: 'نوع ردیف',
  lineNumber: 'شمارهٔ ردیف',
  quantity: 'مقدار',
  unit: 'واحد',
  unitPrice: 'قیمت واحد',
  tax: 'مالیات ردیف',
  lineTotal: 'مبلغ ردیف',
  itemReference: 'کد کالا',
  externalRef: 'ارجاع بیرونی',
  technicalDescription: 'شرح فنی',
};

export function commerceRuleFactLabel(field: string): string {
  return RULE_FACT_LABELS[field] ?? field;
}

/** The enum members a fact may take, where the catalogue declares them. */
const RULE_ENUM_VALUE_LABELS: Record<string, string> = {
  PURCHASE_REQUEST: 'درخواست خرید',
  STANDARD: 'استاندارد',
  NON_STANDARD: 'غیراستاندارد',
  SERVICE: 'خدمات',
};

export function commerceRuleEnumValueLabel(value: string): string {
  return RULE_ENUM_VALUE_LABELS[value] ?? value;
}

/** The comparison operators this UI authors — the words on the operator select. */
const COMPARISON_OPERATOR_LABELS: Record<string, string> = {
  equals: 'برابر است با',
  notEquals: 'برابر نیست با',
  greaterThan: 'بیشتر است از',
  greaterThanOrEqual: 'بیشتر یا برابر است با',
  lessThan: 'کمتر است از',
  lessThanOrEqual: 'کمتر یا برابر است با',
  isEmpty: 'خالی است',
  isNotEmpty: 'خالی نیست',
};

export function commerceComparisonOperatorLabel(operator: string): string {
  return COMPARISON_OPERATOR_LABELS[operator] ?? operator;
}

/**
 * Every `WorkflowConfigurationRefusal` the backend's walk can report, in the words that
 * tell an administrator WHAT TO FIX. The refusal codes are the backend's closed
 * vocabulary (`workflow-configuration.ts`); this map renders them — it decides nothing —
 * and an unknown code falls back to the code itself, the honest fallback this module
 * uses everywhere.
 *
 * The technical `detail`/`path` of a finding is deliberately NOT merged into these
 * sentences: the UI renders it as secondary text beside the sentence, because §6's
 * audience configures without a deployment and a sentence without a location is often
 * not enough — but the sentence stays the primary message.
 */
const WORKFLOW_REFUSAL_LABELS: Record<string, string> = {
  STEP_KEY_MISSING: 'کلید مرحله تعیین نشده است.',
  STEP_KEY_TOO_LONG: 'کلید مرحله بیش از حد بلند است.',
  STEP_DISPLAY_NAME_MISSING: 'نام مرحله تعیین نشده است.',
  STEP_DISPLAY_NAME_TOO_LONG: 'نام مرحله بیش از حد بلند است.',
  STEP_ORDERING_NOT_AN_INTEGER: 'ترتیب مرحله باید یک عدد صحیح باشد.',
  STEP_ORDERING_NOT_POSITIVE: 'ترتیب مرحله باید از ۱ آغاز شود.',
  STEP_EXECUTION_MODE_UNSUPPORTED: 'حالت اجرای مرحله پذیرفته نمی‌شود.',
  STEP_PARALLEL_GROUP_MISSING: 'برای مرحلهٔ موازی باید برچسب شاخه تعیین شود.',
  STEP_PARALLEL_GROUP_UNEXPECTED: 'برچسب شاخه فقط برای مرحلهٔ موازی معنا دارد.',
  STEP_PARALLEL_GROUP_TOO_LONG: 'برچسب شاخهٔ موازی بیش از حد بلند است.',
  STEP_CONDITION_REQUIRED: 'مرحلهٔ شرطی بدون شرط تعریف نمی‌شود؛ شرط را تعیین کنید.',
  STEP_CONDITION_UNEXPECTED: 'شرط فقط برای مرحلهٔ شرطی معنا دارد.',
  STEP_CONDITION_INVALID: 'ساختار شرط با گرامر موتور قواعد همخوان نیست.',
  STEP_ACTOR_SOURCE_UNSUPPORTED: 'روش تعیین مسئول این مرحله پذیرفته نمی‌شود.',
  STEP_ACTOR_SOURCE_MISSING: 'مسئول این مرحله تعیین نشده است.',
  STEP_ACTOR_PARAMETER_MISSING: 'مقدار مربوط به روش تعیین مسئول (کاربر یا نقش) تعیین نشده است.',
  STEP_ACTOR_PARAMETER_UNEXPECTED: 'مقدار تعیین‌شده با روش انتخاب‌شدهٔ مسئول همخوان نیست.',
  STEP_THRESHOLDS_NOT_AN_OBJECT: 'ساختار آستانه‌های مرحله معتبر نیست.',
  STEP_LINE_FILTERS_NOT_AN_OBJECT: 'ساختار محدودهٔ ردیف‌های مرحله معتبر نیست.',
  STEP_CONFIGURATION_NOT_AN_OBJECT: 'ساختار تنظیمات تکمیلی مرحله معتبر نیست.',
  STEP_VISIBLE_FIELDS_INVALID: 'فهرست فیلدهای نمایشی مرحله معتبر نیست.',
  STEP_PAYLOAD_UNSAFE: 'یکی از مقادیر این مرحله الگوی ناامن دارد.',
  STEP_KEY_DUPLICATED: 'کلید این مرحله در همین نسخه تکراری است.',
  STEP_ORDERING_DUPLICATED: 'دو مرحله یک ترتیب را اعلام کرده‌اند.',
  STEP_CONDITION_FALSE_BEHAVIOR_UNSUPPORTED: 'رفتار «شرط برقرار نشد» پذیرفته نمی‌شود.',
  TRIGGER_EVENT_UNSUPPORTED: 'رویداد آغاز نسخه پذیرفته نمی‌شود.',
  JOIN_POLICY_UNSUPPORTED: 'سیاست اتصال شاخه‌های موازی پذیرفته نمی‌شود.',
  WORKFLOW_TRIGGER_MISSING: 'برای انتشار باید رویداد آغاز فرآیند تعیین شود.',
  WORKFLOW_JOIN_POLICY_MISSING: 'چون مرحلهٔ موازی وجود دارد، سیاست اتصال شاخه‌ها باید تعیین شود.',
  WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED:
    'رفتار «متوقف شود» در نسخهٔ فعلی موتور گردش کار قابل انتشار نیست؛ گزینهٔ دیگری برگزینید.',
  WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING:
    'برای مرحلهٔ دارای شرط، رفتار «شرط برقرار نشد» باید تعیین شود.',
  WORKFLOW_ACTOR_SOURCE_UNSUPPORTED:
    'در نسخهٔ فعلی موتور گردش کار تنها «کاربر مشخص» قابل انتشار است.',
  WORKFLOW_LINE_SCOPE_UNSUPPORTED:
    'محدودسازی مرحله به ردیف‌های خاص در نسخهٔ فعلی قابل انتشار نیست.',
  WORKFLOW_STEP_COUNT_EXCEEDED: 'تعداد مراحل بیش از حد مجاز موتور گردش کار است.',
  WORKFLOW_SELECTION_RULE_INVALID:
    'شرط انتخاب این نسخه با فهرست واقعیت‌های مجاز همخوان نیست.',
  WORKFLOW_VERSION_RULE_INVALID:
    'شرط فعال‌سازی یکی از مراحل با فهرست واقعیت‌های مجاز همخوان نیست.',
  VERSION_HAS_NO_STEPS: 'نسخه باید حداقل یک مرحله داشته باشد.',
};

export function commerceWorkflowRefusalLabel(refusal: string): string {
  return WORKFLOW_REFUSAL_LABELS[refusal] ?? refusal;
}


// -----------------------------------------------------------------------------
// COMMERCIAL CONFIGURATION vocabulary (C1-P §9)
// -----------------------------------------------------------------------------

/**
 * The assignment trigger reuses the SAME closed `WorkflowTriggerEvent` vocabulary the
 * schema declares (`commercial.dto.ts` validates against exactly that tuple), so this is
 * the trigger label under the name the commercial form reads it by — one wording, two
 * call sites.
 */
export function commerceCommercialAssignmentTriggerLabel(event: string): string {
  return commerceWorkflowTriggerEventLabel(event);
}

const NO_ASSIGNMENT_BEHAVIOR_LABELS: Record<CommerceCommercialNoAssignmentBehavior, string> = {
  REJECT_OPERATION: 'عملیات متوقف شود و خطا اعلام گردد',
  LEAVE_UNASSIGNED: 'ردیف بدون گروه باقی بماند',
};

export function commerceCommercialNoAssignmentBehaviorLabel(behavior: string): string {
  return (
    NO_ASSIGNMENT_BEHAVIOR_LABELS[behavior as CommerceCommercialNoAssignmentBehavior] ?? behavior
  );
}

const MATCH_BEHAVIOR_LABELS: Record<CommerceCommercialMatchBehavior, string> = {
  HIGHEST_PRIORITY: 'قاعدهٔ با بالاترین اولویت انتخاب شود',
  AMBIGUOUS_ERROR: 'خطای ابهام اعلام گردد',
};

export function commerceCommercialMatchBehaviorLabel(behavior: string): string {
  return MATCH_BEHAVIOR_LABELS[behavior as CommerceCommercialMatchBehavior] ?? behavior;
}

const APPROVAL_ACTIVATION_LABELS: Record<CommerceCommercialApprovalActivation, string> = {
  NOT_REQUIRED: 'تأیید بازرگانی لازم نیست',
  PURCHASE_SUBMITTED: 'هنگام ثبت درخواست خرید',
  AFTER_DOCUMENT_WORKFLOW_APPROVED: 'پس از تأیید گردش کار سند',
};

export function commerceCommercialApprovalActivationLabel(activation: string): string {
  return approvalActivationLabel(activation);
}

function approvalActivationLabel(activation: string): string {
  return (
    APPROVAL_ACTIVATION_LABELS[activation as CommerceCommercialApprovalActivation] ?? activation
  );
}

const APPROVAL_APPROVER_LABELS: Record<CommerceCommercialApprovalApprover, string> = {
  LINE_COMMERCIAL_LIAISON: 'رابط بازرگانی ردیف',
  CONFIGURED_USER: 'کاربر مشخص',
};

export function commerceCommercialApprovalApproverLabel(approver: string): string {
  return APPROVAL_APPROVER_LABELS[approver as CommerceCommercialApprovalApprover] ?? approver;
}

const PROJECTION_POLICY_LABELS: Record<CommerceCommercialProjectionPolicy, string> = {
  DOCUMENT_WORKFLOW: 'نتیجهٔ گردش کار سند',
  ALL_LINES: 'نتیجهٔ همهٔ ردیف‌ها',
  DOCUMENT_WORKFLOW_AND_COMMERCIAL: 'گردش کار سند و تصمیم بازرگانی',
  ALL_LINES_AND_COMMERCIAL: 'همهٔ ردیف‌ها و تصمیم بازرگانی',
};

export function commerceCommercialProjectionPolicyLabel(policy: string): string {
  return PROJECTION_POLICY_LABELS[policy as CommerceCommercialProjectionPolicy] ?? policy;
}