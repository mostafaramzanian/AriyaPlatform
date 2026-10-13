import { coreDelete, coreGet, corePatch, corePost, corePostForm } from './core-http';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the Financial (check request) client for apps/web.
 *
 * MIRRORS THE BACKEND CONTRACT EXACTLY — every route below was read off
 * `check-request.controller.ts` before it was written:
 *
 *   CHECK REQUEST (check-request.controller.ts / check-request.dto.ts)
 *     GET    /financial/check-requests                        (list)
 *     GET    /financial/check-requests/:id                    (one — with `process` + `stages`)
 *     GET    /financial/check-requests/:id/timeline           (audit trail, read-only)
 *     GET    /financial/check-requests/:id/available-actions  (the wizard's action source)
 *     POST   /financial/check-requests                        (create → state 0, 201)
 *     PATCH  /financial/check-requests/:id                    (edit while 0/1, 200)
 *     POST   /financial/check-requests/:id/submit             ({0,1} → 2, 200)
 *     POST   /financial/check-requests/:id/approve            (2 → 3, 200)
 *     POST   /financial/check-requests/:id/reject             (2 → 50, 200)
 *     POST   /financial/check-requests/:id/request-correction (2 → 1, 200)
 *     POST   /financial/check-requests/:id/allocate           (3 → 4, 200)
 *     POST   /financial/check-requests/:id/document-review    (4 → 5 | 1, 200)
 *     POST   /financial/check-requests/:id/executive-approval (5 → 6 | 50, 200)
 *     POST   /financial/check-requests/:id/issue              (6 → 7, 200)
 *     POST   /financial/check-requests/:id/delivery           (7 → 8, 200)
 *
 *   PROCESS DEFINITION (check-process.controller.ts)
 *     GET    /financial/check-process                         (the published definition)
 *
 *   ATTACHMENTS — sections 2 / 6 / 7 (config-driven windows)
 *     GET    /financial/check-requests/:id/attachments
 *     POST   /financial/check-requests/:id/attachments        (section 2, multipart, 201)
 *     PATCH  /financial/check-requests/:id/attachments/:attachmentId
 *     DELETE /financial/check-requests/:id/attachments/:attachmentId
 *     GET    /financial/check-requests/:id/attachments/:attachmentId/url
 *     POST   /financial/check-requests/:id/cheque-image       (section 6, multipart, 201)
 *     DELETE /financial/check-requests/:id/cheque-image/:attachmentId
 *     POST   /financial/check-requests/:id/delivery-receipt   (section 7, multipart, 201)
 *     DELETE /financial/check-requests/:id/delivery-receipt/:attachmentId
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY
 * ------------------------------------
 *  * NO `tenantId` ANYWHERE. The actor is derived server-side by
 *    `resolveFinancialActor(req)`, and the global `ValidationPipe` runs with
 *    `forbidNonWhitelisted`, so a request carrying one is refused rather than silently
 *    scoped.
 *  * NO `requesterUserId` on create — the server FORCES it from the authenticated actor
 *    (V6). No UI can raise a request in somebody else's name.
 *  * NO `status` / `nextState` on any write: the lifecycle is walked by the routes that
 *    own each transition; a body that could state `3` would be a way to approve your own
 *    request.
 *  * NO `requestDate` / `title`: both are SERVER-GENERATED (the source's `c_TarikhDarkhast`
 *    defaults to today and `c_Title` is `IsCalculated`), so no input exists for them.
 *  * NO cheque-instrument field (number, bank, IBAN, Sayad, due date): the source has
 *    none — Preflight §10 is `NOT ESTABLISHED` — and the backend has no column either.
 *  * NO allocation / document-review / issuance / delivery methods: states 3..7 are
 *    deferred, so a client method for them would be a fake endpoint by another name.
 *
 * `core-http` is used exclusively, so there is exactly one session mechanism, one error
 * mapping and one response-envelope rule for the whole admin surface.
 */

/** Mirrors `FINANCIAL_MAX_PAGE_SIZE` / `FINANCIAL_DEFAULT_PAGE_SIZE`. */
export const FINANCIAL_DEFAULT_PAGE_SIZE = 20;
export const FINANCIAL_MAX_PAGE_SIZE = 100;

/**
 * The stage ordinals, as the API states them — the source's own `c_status` vocabulary.
 * The NAMES are labels (`financial-labels.ts`), never a second wire vocabulary.
 * Phase CHECK-ISSUATION: the full source set {0..8, 50}.
 */
export type FinancialCheckRequestStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 50;

/** Mirrors `CheckIssueType` — the source's `خرید;تنخواه;حقوق`. */
export type FinancialCheckIssueType = 'PURCHASE' | 'PETTY_CASH' | 'SALARY';

/** Mirrors `CheckPurchaseType` — the source's `پروژه ای;غیر پروژه ای`. */
export type FinancialCheckPurchaseType = 'PROJECT' | 'NON_PROJECT';

/** Mirrors `ManagerDecision` — the source's `بله;خیر;نیازمند اصلاح است`. */
export type FinancialManagerDecision = 'APPROVE' | 'REJECT' | 'REQUEST_CORRECTION';

/** Mirrors `RequesterOpinion` — the source's `تایید و ادامه;لغو کامل گردش درخواست`. */
export type FinancialRequesterOpinion = 'CONTINUE' | 'CANCEL';

/** Mirrors `DocumentReviewDecision` — the source's `تایید;اصلاح` (no reject exists). */
export type FinancialDocumentReviewDecision = 'APPROVE' | 'CORRECTION';

/**
 * Mirrors `ExecutiveDecision` — the source's RESOLVED `تایید;رد`. The control's third
 * value («نیازمند اصلاح») is DEFERRED / SOURCE-CONFLICT and is deliberately UNREPRESENTABLE
 * on the wire — no spelling reaches a guessed transition.
 */
export type FinancialExecutiveDecision = 'APPROVE' | 'REJECT';

/** Mirrors `CheckDocumentType` — the source's eleven `c_NoeaSanad` values. */
export type FinancialCheckDocumentType =
  | 'DASTOOR_PARDAKHT'
  | 'PISH_FACTOR'
  | 'GOVAHI_EZAFAT'
  | 'KART_MELLI_TAMIN_KONANDE'
  | 'SOORATGHALME'
  | 'SOORATGHALME_KOMISION'
  | 'SOORATGHALME_FAZ_BANDI'
  | 'GARARDAD'
  | 'FACTOOR_MAHAR'
  | 'ENGLISH_FACTOR_TRANSLATION'
  | 'OTHER';

/** One check request as `CheckRequestView` returns it. */
export interface FinancialCheckRequest {
  id: string;
  title: string;
  checkIssueType: FinancialCheckIssueType;
  purchaseType: FinancialCheckPurchaseType | null;
  orderReference: string | null;
  projectReference: string | null;
  projectManagerUserId: string | null;
  requesterUserId: string;
  requestDate: string;
  requesterOpinion: FinancialRequesterOpinion;
  status: number;
  managerDecision: FinancialManagerDecision | null;
  managerComment: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * DETAIL-ONLY (Phase CHECK-ISSUATION): present on `GET …/:id`, absent on list items.
   * The process pin with the step the PINNED definition resolves for `status`.
   */
  process?: FinancialCheckProcessView;
  /** DETAIL-ONLY: the five stage records, `null` until the stage's action has run. */
  stages?: FinancialCheckStages;
}

/** The process pin + current step a detail response carries. */
export interface FinancialCheckProcessView {
  processKey: string;
  processVersion: number;
  terminal: boolean;
  step: { key: string; title: string; progressLabel: string; order: number } | null;
}

/** The five stage records on the wire. */
export interface FinancialCheckStages {
  allocation: {
    allocationPlace: string;
    balance: string | null;
    checkDate: string | null;
    checkDescription: string | null;
    checkAmount: string;
    payableTo: string | null;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  documentReview: {
    decision: FinancialDocumentReviewDecision;
    comment: string | null;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  executiveApproval: {
    decision: FinancialExecutiveDecision;
    comment: string | null;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  issue: {
    issuedCheckConfirmed: boolean;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  delivery: {
    deliveryCompleted: boolean;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
}

/** ONE action the wizard may render, as `GET …/available-actions` reports it. */
export interface FinancialCheckAvailableAction {
  action: string;
  label: string;
  permission: string;
  enabled: boolean;
  /** `null` when enabled; a stable refusal reason code otherwise. */
  reason: string | null;
}

export interface FinancialCheckAvailableActions {
  processKey: string;
  processVersion: number;
  state: number;
  terminal: boolean;
  step: { key: string; title: string; progressLabel: string; order: number } | null;
  actions: FinancialCheckAvailableAction[];
}

/**
 * A SLICE of the published `ProcessDefinition` the wizard renders — steps, actions,
 * document sections and terminal states. Typed structurally (the backend serializes the
 * frozen definition; this interface names what the SCREEN actually reads).
 */
export interface FinancialCheckProcessDefinition {
  processKey: string;
  version: number;
  status: 'draft' | 'published';
  title: string;
  steps: Array<{
    key: string;
    order: number;
    title: string;
    progressLabel: string;
    states: number[];
    active: boolean;
    visible: boolean;
    actions: string[];
    fields: Array<{ field: string; states: number[]; editableStates: number[] }>;
  }>;
  actions: Array<{
    key: string;
    label: string;
    permission: string;
    actorPolicy: string;
  }>;
  documentSections: Array<{
    section: number;
    key: string;
    title: string;
    states: number[];
    allowedDocumentTypes: string[] | null;
    requiredForActions: string[];
    permission: string;
  }>;
  terminalStates: number[];
}

export interface FinancialCheckRequestPage {
  items: FinancialCheckRequest[];
  total: number;
  page: number;
  pageSize: number;
}

/** One request/stage document (sections 2 / 6 / 7). NO `storageKey`. */
export interface FinancialCheckAttachment {
  id: string;
  checkRequestId: string;
  section: number;
  /** `null` for the stage sections (6/7) whose configuration declares no vocabulary. */
  documentType: FinancialCheckDocumentType | null;
  description: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One timeline entry — the platform audit projection, seven fields. */
export interface FinancialTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface FinancialTimelinePage {
  items: FinancialTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * The create payload — exactly the DTO's fields, nothing server-owned. `requesterUserId`,
 * `requestDate`, `title`, `status` and `tenantId` are absent BY DESIGN: sending one is a
 * typed 400 naming the field (the backend's `forbidNonWhitelisted` pipe), which is
 * precisely the behaviour the brief's §17 asks for.
 */
export interface CreateFinancialCheckRequestInput {
  checkIssueType: FinancialCheckIssueType;
  purchaseType?: FinancialCheckPurchaseType;
  orderReference?: string;
  projectReference?: string;
  projectManagerUserId?: string;
  requesterOpinion?: FinancialRequesterOpinion;
}

/** The patch payload — the same writable fields, all optional (states 0 and 1 only). */
export interface UpdateFinancialCheckRequestInput {
  checkIssueType?: FinancialCheckIssueType;
  purchaseType?: FinancialCheckPurchaseType;
  orderReference?: string;
  projectReference?: string;
  projectManagerUserId?: string;
  requesterOpinion?: FinancialRequesterOpinion;
}

/** The decision payload — the manager's OPTIONAL comment. The ROUTE states the decision. */
export interface DecideFinancialCheckRequestInput {
  comment?: string;
}

export interface FinancialCheckRequestListQuery {
  page?: number;
  pageSize?: number;
  status?: number;
  search?: string;
}

export interface FinancialTimelineQuery {
  page?: number;
  pageSize?: number;
}

function buildListQuery(query: FinancialCheckRequestListQuery): string {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  if (query.status !== undefined) params.set('status', String(query.status));
  if (query.search) params.set('search', query.search);
  const value = params.toString();
  return value ? `?${value}` : '';
}

function buildTimelineQuery(query: FinancialTimelineQuery): string {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const value = params.toString();
  return value ? `?${value}` : '';
}

/** One page of the tenant's check requests. */
export function fetchFinancialCheckRequests(
  query: FinancialCheckRequestListQuery = {}
): Promise<FinancialCheckRequestPage> {
  return coreGet<FinancialCheckRequestPage>(`/financial/check-requests${buildListQuery(query)}`);
}

/** One check request — 404 for an id this tenant does not hold. */
export function fetchFinancialCheckRequest(id: string): Promise<FinancialCheckRequest> {
  return coreGet<FinancialCheckRequest>(`/financial/check-requests/${encodeURIComponent(id)}`);
}

/** This request's audit history — chronological, read-only. An outage REJECTS (never []). */
export function fetchFinancialCheckRequestTimeline(
  id: string,
  query: FinancialTimelineQuery = {}
): Promise<FinancialTimelinePage> {
  return coreGet<FinancialTimelinePage>(
    `/financial/check-requests/${encodeURIComponent(id)}/timeline${buildTimelineQuery(query)}`
  );
}

/** Create a check request. It is created as a DRAFT (state 0); the requester is FORCED server-side. */
export function createFinancialCheckRequest(
  input: CreateFinancialCheckRequestInput
): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>('/financial/check-requests', input);
}

/** Change a request while the requester owns it (states 0 and 1). 409 once the manager does. */
export function updateFinancialCheckRequest(
  id: string,
  input: UpdateFinancialCheckRequestInput
): Promise<FinancialCheckRequest> {
  return corePatch<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}`,
    input
  );
}

/** Submit / re-submit for manager review: {0, 1} → 2, once. NO BODY. */
export function submitFinancialCheckRequest(id: string): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}/submit`
  );
}

/**
 * One of the three manager decisions. The ROUTE states which one — there is no `decision`
 * field on the wire, so a body cannot rewrite the meaning of the call.
 */
export function decideFinancialCheckRequest(
  id: string,
  outcome: 'approve' | 'reject' | 'request-correction',
  input: DecideFinancialCheckRequestInput = {}
): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}/${outcome}`,
    input
  );
}

/** The documents on this request, oldest first. A read — works in every state. */
export function fetchFinancialCheckAttachments(id: string): Promise<FinancialCheckAttachment[]> {
  return coreGet<FinancialCheckAttachment[]>(
    `/financial/check-requests/${encodeURIComponent(id)}/attachments`
  );
}

/**
 * Uploads ONE request-stage document (multipart, field `file`). `documentType` is the
 * source's own upload gate — «نوع سند انتخاب گردد.» — and is required; nothing ever is
 * required to EXIST for the lifecycle to continue.
 */
export function uploadFinancialCheckAttachment(
  id: string,
  file: File,
  documentType: FinancialCheckDocumentType,
  description?: string
): Promise<FinancialCheckAttachment> {
  const form = new FormData();
  form.append('file', file);
  form.append('documentType', documentType);
  if (description !== undefined) form.append('description', description);
  return corePostForm<FinancialCheckAttachment>(
    `/financial/check-requests/${encodeURIComponent(id)}/attachments`,
    form
  );
}

/** Edits ONE document's metadata (نوع سند / توضیحات) while the request is requester-owned. */
export function updateFinancialCheckAttachment(
  id: string,
  attachmentId: string,
  input: { documentType?: FinancialCheckDocumentType; description?: string }
): Promise<FinancialCheckAttachment> {
  return corePatch<FinancialCheckAttachment>(
    `/financial/check-requests/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
    input
  );
}

/** Removes ONE document — its row and its object — while the request is requester-owned. */
export function deleteFinancialCheckAttachment(
  id: string,
  attachmentId: string
): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(
    `/financial/check-requests/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`
  );
}

/** Resolves a short-lived download URL — the `storageKey` itself never leaves the server. */
export function fetchFinancialCheckAttachmentUrl(
  id: string,
  attachmentId: string
): Promise<{ url: string; fileName: string; mimeType: string }> {
  return coreGet<{ url: string; fileName: string; mimeType: string }>(
    `/financial/check-requests/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/url`
  );
}

/**
 * The PUBLISHED process definition the wizard renders from (brief §13/§14). A read of
 * MODULE configuration — tenant-independent — but still behind `financial.check.read`
 * like every other Financial surface.
 */
export function fetchFinancialCheckProcess(): Promise<FinancialCheckProcessDefinition> {
  return coreGet<FinancialCheckProcessDefinition>('/financial/check-process');
}

/**
 * What the PINNED process offers from THIS row's state (brief §15): labels, required
 * capabilities, and the actor-policy `enabled` flag. The UI renders ONLY these — an
 * action the state machine did not list can never appear as a button.
 */
export function fetchFinancialCheckAvailableActions(
  id: string
): Promise<FinancialCheckAvailableActions> {
  return coreGet<FinancialCheckAvailableActions>(
    `/financial/check-requests/${encodeURIComponent(id)}/available-actions`
  );
}

/** Stage 3 payload — the source's six allocation fields; money as digit strings. */
export interface AllocateFinancialCheckInput {
  allocationPlace: string;
  balance?: string;
  checkDate?: string;
  checkDescription?: string;
  checkAmount: string;
  payableTo?: string;
}

/** Stage 3 → 4. */
export function allocateFinancialCheckRequest(
  id: string,
  input: AllocateFinancialCheckInput
): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}/allocate`,
    input
  );
}

/** Stage 4 payload — `تایید` / `اصلاح`, verbatim from the source's `BarasiAsnad`. */
export function reviewFinancialCheckDocuments(
  id: string,
  input: { decision: FinancialDocumentReviewDecision; comment?: string }
): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}/document-review`,
    input
  );
}

/** Stage 5 payload — the RESOLVED `تایید` / `رد` (the third source value has no route). */
export function decideFinancialExecutiveApproval(
  id: string,
  input: { decision: FinancialExecutiveDecision; comment?: string }
): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}/executive-approval`,
    input
  );
}

/** Stage 6 — the source's `TaedCheckSaderShode` checkbox. */
export function issueFinancialCheck(
  id: string,
  input: { confirmed: boolean }
): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}/issue`,
    input
  );
}

/** Stage 7 — the source's `KhatemeSodoorCheck` checkbox; lands terminal state 8. */
export function completeFinancialCheckDelivery(
  id: string,
  input: { completed: boolean }
): Promise<FinancialCheckRequest> {
  return corePost<FinancialCheckRequest>(
    `/financial/check-requests/${encodeURIComponent(id)}/delivery`,
    input
  );
}

/** Stage-section upload (section 6) — no document type: the source grid never asked. */
export function uploadFinancialCheckChequeImage(
  id: string,
  file: File,
  description?: string
): Promise<FinancialCheckAttachment> {
  const form = new FormData();
  form.append('file', file);
  if (description !== undefined) form.append('description', description);
  return corePostForm<FinancialCheckAttachment>(
    `/financial/check-requests/${encodeURIComponent(id)}/cheque-image`,
    form
  );
}

/** Stage-section upload (section 7) — the delivery receipt. */
export function uploadFinancialCheckDeliveryReceipt(
  id: string,
  file: File,
  description?: string
): Promise<FinancialCheckAttachment> {
  const form = new FormData();
  form.append('file', file);
  if (description !== undefined) form.append('description', description);
  return corePostForm<FinancialCheckAttachment>(
    `/financial/check-requests/${encodeURIComponent(id)}/delivery-receipt`,
    form
  );
}

/** Removes ONE cheque image while the request sits in state 6. */
export function deleteFinancialCheckChequeImage(
  id: string,
  attachmentId: string
): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(
    `/financial/check-requests/${encodeURIComponent(id)}/cheque-image/${encodeURIComponent(attachmentId)}`
  );
}

/** Removes ONE delivery receipt while the request sits in state 7. */
export function deleteFinancialCheckDeliveryReceipt(
  id: string,
  attachmentId: string
): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(
    `/financial/check-requests/${encodeURIComponent(id)}/delivery-receipt/${encodeURIComponent(attachmentId)}`
  );
}
