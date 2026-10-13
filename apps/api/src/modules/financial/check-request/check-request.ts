/**
 * Phase F1 — FINANCIAL FOUNDATION: the CheckRequest slice's shared domain vocabulary —
 * title construction, the typed refusal codes, the audit action names and the document
 * type list. Pure data and pure functions, same rule as `check-request-status.ts`: no
 * NestJS, no Prisma, no repository, no clock, no HTTP.
 *
 * WHY THESE FOUR THINGS LIVE TOGETHER
 * -----------------------------------
 * Each is needed by more than one of {DTO, service, attachment service, tests, web
 * mirrors}, and none of them needs a database or a framework to be decided. Splitting
 * them across four files would make "what are the codes again?" a grep of five modules.
 */

import {
  CHECK_ISSUE_TYPE_LABELS,
  CHECK_PURCHASE_TYPE_LABELS,
  type CheckIssueType,
  type CheckPurchaseType,
} from './check-request-status';

/**
 * The source's `c_NoeaSanad` list, verbatim (Preflight §9.2) — the eleven request-stage
 * document types the upload grid offered, in the source's own order. The Persian labels
 * below are the source's own words; the schema's enum carries the code points.
 *
 * REQUIRED ON UPLOAD, NEVER REQUIRED FOR A TRANSITION. The source's `pf.UploadValues`
 * cancelled any upload whose type was empty («نوع سند انتخاب گردد.»), so `documentType`
 * is a required field of the UPLOAD act — but Preflight §9.3 established that no
 * attachment requirement blocks any state transition, so nothing in the lifecycle asks
 * whether a request HAS documents.
 */
export const CHECK_DOCUMENT_TYPES = [
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

export type CheckDocumentType = (typeof CHECK_DOCUMENT_TYPES)[number];

/** The source's own labels for the eleven document types, in the source's order. */
export const CHECK_DOCUMENT_TYPE_LABELS: Record<CheckDocumentType, string> = {
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

/**
 * The audit `action` values this slice records. Lowercase verbs, like Production's,
 * HR's and Commerce's — the `resource` is `financial.check-request` and the platform
 * timeline renders the pair.
 */
export const CHECK_REQUEST_AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  SUBMIT: 'submit',
  APPROVE: 'approve',
  REJECT: 'reject',
  REQUEST_CORRECTION: 'request_correction',
  // Phase CHECK-ISSUATION — one event per stage act, lowercase to match the F1 verbs
  // above (and Production's/HR's convention). The wizard timeline renders these verbatim.
  ALLOCATE: 'allocate',
  DOCUMENT_REVIEW: 'document_review',
  DOCUMENT_REVIEW_CORRECTION: 'document_review_correction',
  EXECUTIVE_APPROVE: 'executive_approve',
  EXECUTIVE_REJECT: 'executive_reject',
  ISSUE: 'issue',
  DELIVER: 'deliver',
  ATTACHMENT_UPLOAD: 'attachment_upload',
  ATTACHMENT_UPDATE: 'attachment_update',
  ATTACHMENT_DELETE: 'attachment_delete',
} as const;

/**
 * Every typed refusal this slice can produce, as stable machine codes. The web mirror
 * (`apps/web/src/lib/financial-labels.ts`) maps these to Persian sentences BY CODE, never
 * by message — an English sentence may be reworded; a code may not.
 *
 * WHY THESE AND NOT HUNDREDS: each code names a refusal a CLIENT can act on, and each is
 * produced by exactly one guard in the service. A code with no route that can produce it
 * would be decoration.
 */
export const CHECK_REQUEST_ERROR_CODES = {
  /** V1 — the issue type is empty. Source: «نوع صدور چک انتخاب کنید!» */
  ISSUE_TYPE_REQUIRED: 'CHECK_REQUEST_ISSUE_TYPE_REQUIRED',
  /** V2 — a خرید with no purchase type. Source: «نوع خرید را انتخاب کنید!» */
  PURCHASE_TYPE_REQUIRED: 'CHECK_REQUEST_PURCHASE_TYPE_REQUIRED',
  /** V3 — a project purchase with no project. Source: «عنوان پروژه را انتخاب کنید!» */
  PROJECT_REQUIRED: 'CHECK_REQUEST_PROJECT_REQUIRED',
  /** V4 — a خرید with no order reference. Source: «شناسه شماره سفارش ثبت گردد!» */
  ORDER_REFERENCE_REQUIRED: 'CHECK_REQUEST_ORDER_REFERENCE_REQUIRED',
  /** V5 — a project purchase with no manager. Source: «مدیر پروژه انتخاب گردد!» */
  PROJECT_MANAGER_REQUIRED: 'CHECK_REQUEST_PROJECT_MANAGER_REQUIRED',
  /** V6 — no authenticated requester to force. Source: «درخواست کننده انتخاب گردد!» */
  REQUESTER_REQUIRED: 'CHECK_REQUEST_REQUESTER_REQUIRED',
  /** A project-manager id that is not a member of the acting tenant. */
  PROJECT_MANAGER_NOT_MEMBER: 'CHECK_REQUEST_PROJECT_MANAGER_NOT_MEMBER',
  /** A transition attempted from a status that does not permit it. */
  STATE_CONFLICT: 'CHECK_REQUEST_STATE_CONFLICT',
  /** The actor is the request's own requester — self-approval is refused (fail-closed). */
  SELF_APPROVAL: 'CHECK_REQUEST_SELF_APPROVAL',
  /** A decision route reached with no authenticated human actor. */
  DECIDER_REQUIRED: 'CHECK_REQUEST_DECIDER_REQUIRED',
  /** Attachments (or edits) attempted while the request is not requester-owned. */
  NOT_EDITABLE: 'CHECK_REQUEST_NOT_EDITABLE',
  /** An upload with no document type. Source: «نوع سند انتخاب گردد.» */
  DOCUMENT_TYPE_REQUIRED: 'CHECK_REQUEST_DOCUMENT_TYPE_REQUIRED',
  /** An unknown document type. */
  DOCUMENT_TYPE_INVALID: 'CHECK_REQUEST_DOCUMENT_TYPE_INVALID',
  /** No file was attached to the upload request. */
  FILE_REQUIRED: 'CHECK_REQUEST_FILE_REQUIRED',
  /** The file's MIME type is outside the allowlist. */
  FILE_TYPE_NOT_ALLOWED: 'CHECK_REQUEST_FILE_TYPE_NOT_ALLOWED',
  /** The file exceeds the 10 MiB cap. */
  FILE_TOO_LARGE: 'CHECK_REQUEST_FILE_TOO_LARGE',
  /** The storage provider refused the object write. */
  STORAGE_UPLOAD_FAILED: 'CHECK_REQUEST_STORAGE_UPLOAD_FAILED',
  /** The storage provider refused to remove an object (the metadata row is deleted). */
  STORAGE_DELETE_FAILED: 'CHECK_REQUEST_STORAGE_DELETE_FAILED',
  // -- Phase CHECK-ISSUATION stage codes -----------------------------------------------
  /** Stage 3: the source's «محل تخصیص نمی تواند خالی باشد.». */
  ALLOCATION_PLACE_REQUIRED: 'CHECK_REQUEST_ALLOCATION_PLACE_REQUIRED',
  /** Stage 3: the source's «مبلغ چک نمی تواند خالی باشد.». */
  ALLOCATION_AMOUNT_REQUIRED: 'CHECK_REQUEST_ALLOCATION_AMOUNT_REQUIRED',
  /** Stage 3: the source's «مبلغ چک از مانده موجودی نمی تواند بیشتر باشد.» (V11). */
  ALLOCATION_AMOUNT_EXCEEDS_BALANCE: 'CHECK_REQUEST_ALLOCATION_AMOUNT_EXCEEDS_BALANCE',
  /** Stage 6: the source's «تصویر چک صادر شده بارگذاری نشده است!». */
  ISSUE_IMAGE_REQUIRED: 'CHECK_REQUEST_ISSUE_IMAGE_REQUIRED',
  /** Stage 6: the source's «گزینه تایید چک صادر شده انتخاب نشده است!». */
  ISSUE_CONFIRMATION_REQUIRED: 'CHECK_REQUEST_ISSUE_CONFIRMATION_REQUIRED',
  /** Stage 7: the source's «تصویر رسید تحویل بارگذاری نشده است!». */
  DELIVERY_RECEIPT_REQUIRED: 'CHECK_REQUEST_DELIVERY_RECEIPT_REQUIRED',
  /** Stage 7: the source's «گزینه خاتمه صدور چک انتخاب نشده است!». */
  DELIVERY_CONFIRMATION_REQUIRED: 'CHECK_REQUEST_DELIVERY_CONFIRMATION_REQUIRED',
  /** A document section key the process configuration does not declare. */
  SECTION_UNKNOWN: 'CHECK_REQUEST_SECTION_UNKNOWN',
  /** The section is not MANAGED in the row's current state (config: section.states). */
  SECTION_UNAVAILABLE: 'CHECK_REQUEST_SECTION_UNAVAILABLE',
  /** The attachment belongs to a section this route does not manage. */
  SECTION_ROUTE_MISMATCH: 'CHECK_REQUEST_SECTION_ROUTE_MISMATCH',
  /** A document type was supplied for a section that declares no type vocabulary. */
  DOCUMENT_TYPE_NOT_ALLOWED: 'CHECK_REQUEST_DOCUMENT_TYPE_NOT_ALLOWED',
  /** A document type outside the section's configured vocabulary. */
  DOCUMENT_TYPE_NOT_IN_SECTION: 'CHECK_REQUEST_DOCUMENT_TYPE_NOT_IN_SECTION',
} as const;

/**
 * Builds the SERVER-GENERATED title, following the source's own construction rules
 * (`c_Title` is `IsCalculated`, required and read-only; Preflight §5/§10):
 *
 *   حقوق                       → «صدور چک برای حقوق»                    (exact)
 *   خرید/تنخواه + غیر پروژه ای  → «صدور چک برای {نوع} غیر پروژه ای»       (exact)
 *   خرید/تنخواه + پروژه ای      → «صدور چک برای {نوع} پروژه ای»           (PARTIAL)
 *
 * THE PROJECT BRANCH IS PARTIAL, DELIBERATELY AND EXPLICITLY. The source's rules read
 * `cc = "صدور چک برای " + NoeaSodoorCheck + " " + noeaKahrid + " - " + title_Project`,
 * where `title_Project` is the project's NAME read from SharePoint's «لیست پروژه ها».
 * Ariya has NO project-name contract (Preflight §18; the reference is opaque), so the
 * ` - {name}` suffix cannot be reproduced and is OMITTED rather than faked with a
 * reference id or an empty string. When a Project contract lands, this function gains
 * the suffix and this comment is the record of why it was missing.
 *
 * The clearing rules (V7) run BEFORE this is called, so a salary row never has a purchase
 * type to branch on and a تنخواه/حقوق row never has an order reference.
 */
export function buildCheckRequestTitle(
  issueType: CheckIssueType,
  purchaseType: CheckPurchaseType | null
): string {
  if (issueType === 'SALARY') {
    return 'صدور چک برای حقوق';
  }

  const issueLabel = CHECK_ISSUE_TYPE_LABELS[issueType];
  if (purchaseType === 'PROJECT') {
    // Source: `صدور چک برای خرید پروژه ای - {project name}` — suffix omitted (see above).
    return `صدور چک برای ${issueLabel} ${CHECK_PURCHASE_TYPE_LABELS.PROJECT}`;
  }
  if (purchaseType === 'NON_PROJECT') {
    return `صدور چک برای ${issueLabel} ${CHECK_PURCHASE_TYPE_LABELS.NON_PROJECT}`;
  }
  // تنخواه with no purchase type chosen yet: the source's own field was optional for
  // تنخواه, so the title states only what is known — the issue type.
  return `صدور چک برای ${issueLabel}`;
}
