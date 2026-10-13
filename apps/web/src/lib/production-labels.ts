/**
 * Phase PRODUCTION-BOM: the Production labels and error mapping the screens render.
 *
 * WHY THIS FILE IS SEPARATE FROM THE API CLIENT
 * ---------------------------------------------
 * `production-api.ts` mirrors the WIRE (English code points, exact field names); this file
 * is the Persian RENDERING of those code points plus the mapping from a typed domain error
 * code to the sentence a user reads. Keeping them apart is the rule `commerce-labels.ts`
 * states: the API returns the stored fact, and a screen renders the Persian label — so no
 * response ever carries a `displayStatus`, and no component has to re-derive one.
 *
 * THE ERROR MAPPING IS BY CODE, NEVER BY SENTENCE. The backend refuses with a typed
 * `error.code` (`PRODUCTION_BOM_ERROR_CODES`), and `StandardExceptionFilter` passes it
 * through as `error.code`. Matching on an English message would break the first time
 * somebody reworded one; matching on the code cannot.
 */

import type { ProductionBomChangeType, ProductionBomStatus } from './production-api';

/** The four states the BOM header lifecycle can be in, in the schema's order. */
export const PRODUCTION_BOM_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;

export type ProductionTone = 'ok' | 'muted' | 'danger' | 'info';

/** A BOM's lifecycle word, in the Persian the legacy approval task's radio used. */
export const PRODUCTION_BOM_STATUS_LABELS: Record<ProductionBomStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'ارجاع برای تایید',
  APPROVED: 'تایید شده',
  REJECTED: 'رد شده',
};

/** The tone is the redundant second channel, so state is never colour-only. */
export const PRODUCTION_BOM_STATUS_TONES: Record<ProductionBomStatus, ProductionTone> = {
  DRAFT: 'muted',
  SUBMITTED: 'info',
  APPROVED: 'ok',
  REJECTED: 'danger',
};

export function productionBomStatusLabel(status: ProductionBomStatus): string {
  return PRODUCTION_BOM_STATUS_LABELS[status] ?? status;
}

export function productionBomStatusTone(status: ProductionBomStatus): ProductionTone {
  return PRODUCTION_BOM_STATUS_TONES[status] ?? 'muted';
}

/**
 * The approver's three decisions, verbatim from the legacy `RadioButtons`
 * (`تایید;رد;نیاز به اصلاح`). A `null` means nobody has decided yet — not a fourth value.
 */
export const PRODUCTION_MANAGER_OPINION_LABELS: Record<string, string> = {
  APPROVED: 'تایید',
  REJECTED: 'رد',
  NEEDS_CORRECTION: 'نیاز به اصلاح',
};

export function productionManagerOpinionLabel(opinion: string | null): string | null {
  if (!opinion) return null;
  return PRODUCTION_MANAGER_OPINION_LABELS[opinion] ?? opinion;
}

/** The source's `Noe_Ghatae` static list, `ساختی;استاندارد`. */
export const PRODUCTION_PART_TYPES = ['STRUCTURAL', 'STANDARD'] as const;
export type ProductionPartType = (typeof PRODUCTION_PART_TYPES)[number];

export const PRODUCTION_PART_TYPE_LABELS: Record<ProductionPartType, string> = {
  STRUCTURAL: 'ساختی',
  STANDARD: 'استاندارد',
};

export function productionPartTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return PRODUCTION_PART_TYPE_LABELS[type as ProductionPartType] ?? type;
}

/** The source's `CP_Ghatae` list, `دارد;ندارد`. Optional, so `null` is a real answer. */
export const PRODUCTION_CONTROL_PLANS = ['PRESENT', 'ABSENT'] as const;
export type ProductionControlPlan = (typeof PRODUCTION_CONTROL_PLANS)[number];

export const PRODUCTION_CONTROL_PLAN_LABELS: Record<ProductionControlPlan, string> = {
  PRESENT: 'دارد',
  ABSENT: 'ندارد',
};

export function productionControlPlanLabel(plan: string | null): string {
  if (!plan) return '—';
  return PRODUCTION_CONTROL_PLAN_LABELS[plan as ProductionControlPlan] ?? plan;
}

/**
 * Every typed refusal this domain can produce, mapped to the Persian a user reads.
 *
 * THE KEYS ARE THE BACKEND'S CODES, duplicated here deliberately: they are the stable
 * contract between a service and its screens, and a screen that imported the API module
 * just for a message would be coupling presentation to a transport module. A code missing
 * from this map falls back to the server's own message rather than rendering the token.
 */
export const PRODUCTION_ERROR_MESSAGES: Record<string, string> = {
  BOM_SUBMIT_ITEMS_REQUIRED: 'اقلامی ثبت نشده است!',
  BOM_HEADER_NOT_EDITABLE: 'این BOM در وضعیت قابل ویرایش نیست؛ فقط پیش‌نویس قابل تغییر است.',
  BOM_ITEM_NOT_FOUND: 'قلم مورد نظر یافت نشد.',
  BOM_ITEM_FIELD_REQUIRED: 'برخی فیلدهای اجباری خالی است؛ لطفاً مقادیر را کامل کنید.',
  BOM_ITEM_COEFFICIENT_INVALID: 'ضریب مصرف باید عدد صحیح بزرگ‌تر یا مساوی صفر باشد.',
  BOM_ITEM_PATCH_EMPTY: 'حداقل یک فیلد را برای تغییر مشخص کنید.',
  // --- Phase PRODUCTION-BOM-CHANGE — «ثبت درخواست تغییر BOM». The three marked with the
  // source's own sentence are the refusals `BomEdit.txt` printed literally; the rest are
  // this phase's typed refusals, each mapped so no screen has to render a raw token.
  /** «اقلامی جهت تغییر ثبت نشده است!» — the source's submit gate, verbatim. */
  BOM_CHANGE_REQUEST_ITEMS_REQUIRED: 'اقلامی جهت تغییر ثبت نشده است!',
  /** «شما قبلا جزئیات این قطعه را تغییر و ثبت نموده اید» — the duplicate-detail refusal. */
  BOM_CHANGE_ITEM_DUPLICATE: 'شما قبلا جزئیات این قطعه را تغییر و ثبت نموده اید.',
  /** «حداقل یکی از فیلدهای افزایش ضریب مصرف … باید مقداردهی گردد». */
  BOM_CHANGE_ITEM_DELTA_REQUIRED:
    'برای تغییر موجودی، حداقل یکی از دو ضریب مصرف (در نقشه یا یدکی/تست) باید مقداردهی شود.',
  BOM_CHANGE_REQUEST_NOT_EDITABLE:
    'این درخواست تغییر در وضعیت قابل ویرایش نیست؛ فقط پیش‌نویس قابل تغییر است.',
  BOM_CHANGE_REQUEST_NOT_FOUND: 'درخواست تغییر مورد نظر یافت نشد.',
  BOM_CHANGE_REQUEST_BOM_NOT_FOUND: 'BOM مورد نظر یافت نشد.',
  BOM_CHANGE_ITEM_NOT_FOUND: 'قلم مورد نظر در این BOM یافت نشد.',
  BOM_CHANGE_ITEM_DELTA_INVALID: 'مقدار واردشده برای ضریب باید عدد صحیح باشد.',
  BOM_CHANGE_ITEM_TYPE_INVALID: 'نوع تغییر معتبر نیست.',
  BOM_CHANGE_REQUEST_FIELD_REQUIRED:
    'برخی فیلدهای اجباری خالی یا نامعتبر است؛ لطفاً مقادیر را کامل کنید.',
  BOM_CHANGE_REQUEST_PATCH_EMPTY: 'حداقل یک فیلد را برای تغییر مشخص کنید.',
  /**
   * The platform audit read refused (`AuditReadRejectionCode.AUDIT_READ_FAILED`, Phase
   * P-AUDIT-READ) — the one refusal the timeline route can surface. It is mapped here
   * rather than left to the server's English message because this map's own contract is
   * "every typed refusal this domain can produce", and a timeline failure is one. The
   * sentence says the history is UNAVAILABLE, never «رویدادی ثبت نشده»: the two states
   * mean opposite things and the screen shows the empty state for the other one.
   */
  AUDIT_READ_FAILED: 'تاریخچه رویدادها موقتاً در دسترس نیست.',
};

/**
 * The sentence to show for a refusal.
 *
 * `code` is the `error.code` the filter surfaced; `fallback` is the server's own message,
 * used verbatim when the code is unknown — so a new domain error degrades to an honest
 * message instead of a bare token.
 */
export function productionErrorMessage(code: string | undefined, fallback?: string): string {
  if (code && PRODUCTION_ERROR_MESSAGES[code]) return PRODUCTION_ERROR_MESSAGES[code];
  return fallback && fallback.length > 0 ? fallback : 'درخواست شما با خطا مواجه شد.';
}

/**
 * Extracts the typed code from a `CoreApiError`'s structured body.
 *
 * `core-http` puts the whole response in `details`, and `StandardExceptionFilter` shapes it
 * as `{ success: false, error: { code, message } }`. Returning `undefined` when that shape
 * is absent is what makes `productionErrorMessage`'s fallback the right answer for a 401 or
 * a proxy error rather than an undefined read.
 */
export function productionErrorCode(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const error = (details as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/** The same shape as `productionErrorCode`, but for the MESSAGE half. */
export function productionServerMessage(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const error = (details as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/** A date/time on the wire (ISO) as the Persian date the rest of Aria shows. */
export function productionDateLabel(iso: string | null): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('fa-IR');
}

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the audit VERB, rendered in Persian.
 *
 * A CONSERVATIVE MAPPING, AND THAT IS THE POINT.
 * --------------------------------------------
 * These labels name the OPERATION the trail recorded — they are translations of the audit
 * vocabulary, not a reinterpretation of it. Nothing here turns an internal token into a
 * business claim the backend never made: `submit` is «ارسال برای تایید» because that is
 * literally what the transition does, not because some workflow narrative was invented for
 * it. `changedFields` and `reason` carry the substance; this map only says WHAT KIND of act
 * the row is.
 *
 * `request_correction` is spelled with an underscore on the wire and with a space in
 * Persian; the KEY stays the wire value so a rename in the backend breaks the lookup
 * loudly (the fallback below) rather than silently changing the sentence.
 *
 * The item verbs (`delete`) and the three DETAIL verbs (`add_item`, `update_item`,
 * `remove_item`) are included even though the BOM header timeline never carries the item
 * ones: this is ONE vocabulary shared by every Production aggregate's audit resource, and a
 * map that covered only half of it would make the fallback the answer for a family that does
 * exist. The change request's timeline DOES carry its own three, because all nine of that
 * aggregate's families are recorded under its own `resourceId`.
 */
export const PRODUCTION_BOM_AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'ایجاد',
  update: 'ویرایش',
  submit: 'ارسال برای تایید',
  approve: 'تایید',
  reject: 'رد',
  request_correction: 'درخواست اصلاح',
  delete: 'حذف',
  add_item: 'افزودن قلم به درخواست تغییر',
  update_item: 'ویرایش قلم درخواست تغییر',
  remove_item: 'حذف قلم از درخواست تغییر',
};

/**
 * The Persian for one audit verb.
 *
 * AN UNKNOWN VERB FALLS BACK TO THE RAW TOKEN — never to a guess. The alternative (a
 * generic «رویداد») would hide that a new action exists, which is exactly the state a
 * reader needs to see; and inventing a sentence would attribute business meaning the trail
 * does not contain. The token is an internal identifier rather than a secret: it is the
 * same string the audit trail stores and the API returns, so showing it discloses nothing
 * that the event does not already say about itself.
 */
export function productionBomAuditActionLabel(action: string | null | undefined): string {
  if (!action) return '—';
  return PRODUCTION_BOM_AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * The stored write instants as a Persian DATE AND TIME.
 *
 * A timeline entry's instant is the point of the entry — two transitions of the same BOM
 * usually happen on the same day — so the date-only formatter above is not enough here.
 * The locale handles the Jalali calendar and the RTL digit shaping, and a value the
 * platform did not supply reads as «—» rather than as an invalid `Date`.
 */
export function productionAuditTimestampLabel(iso: string | null): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}


/**
 * Phase PRODUCTION-BOM-CHANGE: the source's `c_NoeaTaghir` radio, `تغییر موجودی;غیر فعال
 * سازی`, in that order — the two words a screen shows for the two code points the API stores.
 *
 * The tuple itself lives in `production-api.ts` (it is the WIRE vocabulary); this is the
 * Persian RENDERING of it, which is the split `production-labels.ts` states at its top: the
 * API returns the stored fact, a screen renders the label.
 */
export const PRODUCTION_BOM_CHANGE_TYPE_LABELS: Record<ProductionBomChangeType, string> = {
  QUANTITY_CHANGE: 'تغییر موجودی',
  DEACTIVATE: 'غیر فعال سازی',
};

export function productionBomChangeTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return PRODUCTION_BOM_CHANGE_TYPE_LABELS[type as ProductionBomChangeType] ?? type;
}

/**
 * The DERIVED `original + delta` figure the source showed in `c_totalZaribMasrafInMap`.
 *
 * DISPLAY ONLY, AND DELIBERATELY NOT STORED. `BomEdit.txt` computed it in a
 * `ValueChangeScript` and never wrote it anywhere, and its `< 0` branch was a WARNING whose
 * `//error = true` was commented out — so this function:
 *
 *   * treats a NULL delta as `0` ("nothing stated" contributes nothing), which is exactly
 *     what the source's `bb == "" → "0"` normalisation did;
 *   * returns the sum WHATEVER ITS SIGN. No floor at zero, no maximum, no refusal: a
 *     negative total is shown as a negative total, because the source never blocked it and
 *     this phase does not invent a rule the commented-out guard does not establish.
 *
 * It is a pure function of two numbers the row already holds, so two screens can never
 * disagree about it — and the row itself never has to carry a value that could drift.
 */
export function productionBomChangeTotal(original: number, delta: number | null): number {
  return original + (delta ?? 0);
}

