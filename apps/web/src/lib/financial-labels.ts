/**
 * Phase F1 — FINANCIAL FOUNDATION: the Financial labels and error mapping the screens
 * render.
 *
 * WHY THIS FILE IS SEPARATE FROM THE API CLIENT
 * ---------------------------------------------
 * `financial-api.ts` mirrors the WIRE (English code points, exact field names); this file
 * is the Persian RENDERING of those code points plus the mapping from a typed domain
 * error code to the sentence a user reads. Keeping them apart is the rule
 * `commerce-labels.ts` and `production-labels.ts` state: the API returns the stored fact,
 * and a screen renders the Persian label — so no response ever carries a `displayStatus`
 * and no component has to re-derive one.
 *
 * THE ERROR MAPPING IS BY CODE, NEVER BY SENTENCE. The backend refuses with a typed
 * `error.code` (`CHECK_REQUEST_*`), and `StandardExceptionFilter` passes it through.
 * Matching on an English message would break the first time somebody reworded one;
 * matching on the code cannot.
 */

import type {
  FinancialCheckDocumentType,
  FinancialCheckIssueType,
  FinancialCheckPurchaseType,
  FinancialManagerDecision,
  FinancialRequesterOpinion,
} from './financial-api';

export type FinancialTone = 'ok' | 'muted' | 'danger' | 'info';

/**
 * The stage ordinals, in the source's own numbering — the full set Phase
 * CHECK-ISSUATION implements ({0..8, 50}). The LABELS name what the stage MEANS for a
 * reader; the number is what the API carries.
 */
export const FINANCIAL_CHECK_REQUEST_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 50] as const;

/** A request's lifecycle word — the source's stage headers, rendered. */
export const FINANCIAL_STATUS_LABELS: Record<number, string> = {
  0: 'پیش‌نویس',
  1: 'ارجاع شده / برای اصلاح',
  2: 'در انتظار تصمیم مدیر',
  3: 'صدور فرم تخصیص',
  4: 'بررسی اسناد',
  5: 'تأیید ریاست',
  6: 'صدور چک',
  7: 'تحویل چک',
  8: 'پایان گردش',
  50: 'خاتمه یافته',
};

/** The tone is the redundant second channel, so state is never colour-only. */
export const FINANCIAL_STATUS_TONES: Record<number, FinancialTone> = {
  0: 'muted',
  1: 'info',
  2: 'info',
  3: 'info',
  4: 'info',
  5: 'info',
  6: 'info',
  7: 'info',
  8: 'ok',
  50: 'danger',
};

export function financialStatusLabel(status: number): string {
  return FINANCIAL_STATUS_LABELS[status] ?? `نامشخص (${status})`;
}

export function financialStatusTone(status: number): FinancialTone {
  return FINANCIAL_STATUS_TONES[status] ?? 'muted';
}

/** The source's `c_NoeaSodoorCheck` labels: خرید / تنخواه / حقوق. */
export const FINANCIAL_ISSUE_TYPE_LABELS: Record<FinancialCheckIssueType, string> = {
  PURCHASE: 'خرید',
  PETTY_CASH: 'تنخواه',
  SALARY: 'حقوق',
};

/** The source's `c_NoaeKharid` labels: پروژه ای / غیر پروژه ای. */
export const FINANCIAL_PURCHASE_TYPE_LABELS: Record<FinancialCheckPurchaseType, string> = {
  PROJECT: 'پروژه ای',
  NON_PROJECT: 'غیر پروژه ای',
};

/**
 * The manager's three decisions, verbatim from the source's `c_B_NazarModir`
 * (`بله;خیر;نیازمند اصلاح است`, Preflight §8.2). A `null` means nobody has decided yet —
 * not a fourth value.
 */
export const FINANCIAL_MANAGER_DECISION_LABELS: Record<FinancialManagerDecision, string> = {
  APPROVE: 'بله',
  REJECT: 'خیر',
  REQUEST_CORRECTION: 'نیازمند اصلاح است',
};

export function financialManagerDecisionLabel(decision: string | null): string | null {
  if (!decision) return null;
  return FINANCIAL_MANAGER_DECISION_LABELS[decision as FinancialManagerDecision] ?? decision;
}

/** The reviewer's two words — the source's `BarasiAsnad`, verbatim (`تایید;اصلاح`). */
export const FINANCIAL_DOCUMENT_REVIEW_LABELS: Record<string, string> = {
  APPROVE: 'تایید',
  CORRECTION: 'اصلاح',
};

export function financialDocumentReviewLabel(decision: string | null): string | null {
  if (!decision) return null;
  return FINANCIAL_DOCUMENT_REVIEW_LABELS[decision] ?? decision;
}

/**
 * The presidency's RESOLVED words — `تایید;رد`. The source control's third value is
 * DEFERRED / SOURCE-CONFLICT and has no label here either: nothing renders a control
 * the backend cannot serve.
 */
export const FINANCIAL_EXECUTIVE_DECISION_LABELS: Record<string, string> = {
  APPROVE: 'تایید',
  REJECT: 'رد',
};

export function financialExecutiveDecisionLabel(decision: string | null): string | null {
  if (!decision) return null;
  return FINANCIAL_EXECUTIVE_DECISION_LABELS[decision] ?? decision;
}

/** The source's `c_NazarDarkhastKonande` labels. */
export const FINANCIAL_REQUESTER_OPINION_LABELS: Record<FinancialRequesterOpinion, string> = {
  CONTINUE: 'تایید و ادامه',
  CANCEL: 'لغو کامل گردش درخواست',
};

export function financialRequesterOpinionLabel(opinion: string | null): string | null {
  if (!opinion) return null;
  return FINANCIAL_REQUESTER_OPINION_LABELS[opinion as FinancialRequesterOpinion] ?? opinion;
}

/** The source's eleven `c_NoeaSanad` document types, in the source's order. */
export const FINANCIAL_DOCUMENT_TYPES = [
  'DASTOOR_PARDAKHT',
  'PISH_FACTOR',
  'GOVAHI_EZAFAT',
  'KART_MELLI_TAMIN_KONANDE',
  'SOORATGHALME',
  'SOORATGHALME_KOMISION',
  'SOORATGHALME_FAZ_BANDI',
  'GARARDAD',
  'FACTOOR_MAHAR',
  'ENGLISH_FACTOR_TRANSLATION',
  'OTHER',
] as const;

export const FINANCIAL_DOCUMENT_TYPE_LABELS: Record<FinancialCheckDocumentType, string> = {
  DASTOOR_PARDAKHT: 'دستور پرداخت',
  PISH_FACTOR: 'پیش فاکتور',
  GOVAHI_EZAFAT: 'گواهی ارزش افزوده',
  KART_MELLI_TAMIN_KONANDE: 'کارت ملی تامین کننده',
  SOORATGHALME: 'صورتجلسه',
  SOORATGHALME_KOMISION: 'صورتجلسه کمیسیون معاملات',
  SOORATGHALME_FAZ_BANDI: 'صورتجلسه فاز بندی قرارداد',
  GARARDAD: 'قرارداد',
  FACTOOR_MAHAR: 'فاکتور مهردار',
  ENGLISH_FACTOR_TRANSLATION: 'ترجمه فاکتور انگلیسی',
  OTHER: 'سایر',
};

export function financialDocumentTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return FINANCIAL_DOCUMENT_TYPE_LABELS[type as FinancialCheckDocumentType] ?? type;
}

/**
 * Every typed refusal this domain can produce, mapped to the Persian a user reads.
 *
 * THE KEYS ARE THE BACKEND'S CODES, duplicated here deliberately: they are the stable
 * contract between a service and its screens, and a screen that imported the API module
 * just for a message would be coupling presentation to a transport module. A code missing
 * from this map falls back to the server's own message rather than rendering the token.
 *
 * THE FIVE VALIDATION SENTENCES ARE THE SOURCE'S OWN WORDS (Preflight §6.1): each one is
 * the exact message the legacy `btn_sabt` script printed, so a requester who knows the
 * old form reads the same sentence here.
 */
export const FINANCIAL_ERROR_MESSAGES: Record<string, string> = {
  /** V1 — «نوع صدور چک انتخاب کنید!» */
  CHECK_REQUEST_ISSUE_TYPE_REQUIRED: 'نوع صدور چک انتخاب کنید!',
  /** V2 — «نوع خرید را انتخاب کنید!» */
  CHECK_REQUEST_PURCHASE_TYPE_REQUIRED: 'نوع خرید را انتخاب کنید!',
  /** V3 — «عنوان پروژه را انتخاب کنید!» */
  CHECK_REQUEST_PROJECT_REQUIRED: 'عنوان پروژه را انتخاب کنید!',
  /** V4 — «شناسه شماره سفارش ثبت گردد!» */
  CHECK_REQUEST_ORDER_REFERENCE_REQUIRED: 'شناسه شماره سفارش ثبت گردد!',
  /** V5 — «مدیر پروژه انتخاب گردد!» */
  CHECK_REQUEST_PROJECT_MANAGER_REQUIRED: 'مدیر پروژه انتخاب گردد!',
  /** V6 — «درخواست کننده انتخاب گردد!» */
  CHECK_REQUEST_REQUESTER_REQUIRED: 'درخواست کننده انتخاب گردد!',
  CHECK_REQUEST_PROJECT_MANAGER_NOT_MEMBER:
    'مدیر پروژه انتخاب شده عضو این سازمان نیست یا وجود ندارد.',
  CHECK_REQUEST_STATE_CONFLICT:
    'این درخواست در وضعیت فعلی قابل این عمل نیست؛ صفحه را تازه‌سازی کنید.',
  CHECK_REQUEST_SELF_APPROVAL:
    'درخواست‌کننده نمی‌تواند درخواست خودش را تأیید کند؛ تأیید هم‌زمانی پذیرفته نیست.',
  CHECK_REQUEST_DECIDER_REQUIRED: 'ثبت تصمیم نیازمند کاربر واردشده است.',
  CHECK_REQUEST_NOT_EDITABLE: 'فقط در مرحله پیش‌نویس یا برای اصلاح می‌توان اسناد را تغییر داد.',
  /** The source's upload gate — «نوع سند انتخاب گردد.» */
  CHECK_REQUEST_DOCUMENT_TYPE_REQUIRED: 'نوع سند انتخاب گردد.',
  CHECK_REQUEST_DOCUMENT_TYPE_INVALID: 'نوع سند معتبر نیست.',
  CHECK_REQUEST_FILE_REQUIRED: 'فایلی برای بارگذاری انتخاب نشده است.',
  CHECK_REQUEST_FILE_TYPE_NOT_ALLOWED: 'نوع فایل انتخابی مجاز نیست.',
  CHECK_REQUEST_FILE_TOO_LARGE: 'حجم فایل بیش از حد مجاز است.',
  CHECK_REQUEST_STORAGE_UPLOAD_FAILED: 'ذخیره‌سازی فایل با خطا مواجه شد؛ دوباره تلاش کنید.',
  CHECK_REQUEST_STORAGE_DELETE_FAILED: 'حذف فایل با خطا مواجه شد.',
  // -- Phase CHECK-ISSUATION stage refusals — the SOURCE'S OWN SENTENCES ---------------
  /** V9 — «محل تخصیص نمی تواند خالی باشد.» */
  CHECK_REQUEST_ALLOCATION_PLACE_REQUIRED: 'محل تخصیص نمی تواند خالی باشد.',
  /** V10 — «مبلغ چک نمی تواند خالی باشد.» */
  CHECK_REQUEST_ALLOCATION_AMOUNT_REQUIRED: 'مبلغ چک نمی تواند خالی باشد.',
  /** V11 — «مبلغ چک از مانده موجودی نمی تواند بیشتر باشد.» */
  CHECK_REQUEST_ALLOCATION_AMOUNT_EXCEEDS_BALANCE:
    'مبلغ چک از مانده موجودی نمی تواند بیشتر باشد.',
  /** Stage 6 — «تصویر چک صادر شده بارگذاری نشده است!» */
  CHECK_REQUEST_ISSUE_IMAGE_REQUIRED: 'تصویر چک صادر شده بارگذاری نشده است!',
  /** Stage 6 — «گزینه تایید چک صادر شده انتخاب نشده است!» */
  CHECK_REQUEST_ISSUE_CONFIRMATION_REQUIRED: 'گزینه تایید چک صادر شده انتخاب نشده است!',
  /** Stage 7 — «تصویر رسید تحویل بارگذاری نشده است!» */
  CHECK_REQUEST_DELIVERY_RECEIPT_REQUIRED: 'تصویر رسید تحویل بارگذاری نشده است!',
  /** Stage 7 — «گزینه خاتمه صدور چک انتخاب نشده است!» */
  CHECK_REQUEST_DELIVERY_CONFIRMATION_REQUIRED: 'گزینه خاتمه صدور چک انتخاب نشده است!',
  CHECK_REQUEST_SECTION_UNKNOWN: 'بخش سند درخواستی در گردش کار تعریف نشده است.',
  CHECK_REQUEST_SECTION_UNAVAILABLE:
    'این بخش سند در مرحله فعلی قابل ویرایش نیست؛ مرحله مربوطه را کامل کنید.',
  CHECK_REQUEST_SECTION_ROUTE_MISMATCH: 'این سند به بخش دیگری تعلق دارد.',
  CHECK_REQUEST_DOCUMENT_TYPE_NOT_ALLOWED: 'این بخش سند، نوع سند نمی‌پذیرد.',
  CHECK_REQUEST_DOCUMENT_TYPE_NOT_IN_SECTION: 'نوع سند انتخابی برای این بخش مجاز نیست.',
  AUDIT_READ_FAILED: 'تاریخچه درخواست در حال حاضر در دسترس نیست.',
};

/** Maps a typed refusal code to Persian, falling back to the server's own message. */
export function financialErrorMessage(code: string | undefined, fallback: string): string {
  if (code && FINANCIAL_ERROR_MESSAGES[code]) return FINANCIAL_ERROR_MESSAGES[code];
  return fallback;
}

/**
 * The audit `action` values F1 records, rendered in Persian. A CONSERVATIVE mapping: only
 * the nine actions this phase writes have labels — a future action falls back to its raw
 * verb rather than being guessed at.
 */
export const FINANCIAL_AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'ایجاد درخواست',
  update: 'ویرایش درخواست',
  submit: 'ارجاع برای تصمیم مدیر',
  approve: 'تأیید مدیر (بله)',
  reject: 'رد مدیر (خیر)',
  request_correction: 'درخواست اصلاح مدیر (نیازمند اصلاح است)',
  // Phase CHECK-ISSUATION — one verb per stage act.
  allocate: 'ثبت فرم تخصیص',
  document_review: 'بررسی اسناد (تایید)',
  document_review_correction: 'بررسی اسناد (اصلاح)',
  executive_approve: 'تأیید ریاست',
  executive_reject: 'رد ریاست',
  issue: 'صدور چک',
  deliver: 'تحویل چک',
  attachment_upload: 'بارگذاری سند پیوست',
  attachment_update: 'ویرایش مشخصات سند پیوست',
  attachment_delete: 'حذف سند پیوست',
};

export function financialAuditActionLabel(action: string): string {
  return FINANCIAL_AUDIT_ACTION_LABELS[action] ?? action;
}

/** Renders a stored ISO instant as the platform's Persian date (fa-IR). */
export function financialDateLabel(iso: string | null): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('fa-IR');
}
