import { coreDelete, coreGet, corePatch, corePost, corePut, CoreApiError } from './core-http';

/**
 * PHASE UI-1 → UI-2: the Commerce (procurement) client for apps/web.
 *
 * MIRRORS THE BACKEND CONTRACT EXACTLY. UI-1 covered the register and the
 * commercial-approvals read; UI-2 adds — each one verified directly against its
 * controller, DTO and service before it was written:
 *
 *   PURCHASE   (purchase.controller.ts / purchase.dto.ts)
 *     GET    /commerce/purchase-documents/:id
 *     POST   /commerce/purchase-documents            (create → DRAFT, 201)
 *     PATCH  /commerce/purchase-documents/:id        (update while DRAFT, 200)
 *     POST   /commerce/purchase-documents/:id/submit (DRAFT → SUBMITTED, 200)
 *
 *   PAYMENTS   (payment-history.controller.ts / payment.dto.ts) — append-only
 *     GET    /commerce/purchase-documents/:id/payments
 *     POST   /commerce/purchase-documents/:id/payments
 *     POST   /commerce/purchase-documents/:id/payments/:paymentId/compensate
 *
 *   RECEIVING  (receiving-history.controller.ts / receiving.dto.ts) — event-based
 *     GET    /commerce/purchase-documents/:id/receipts
 *     POST   /commerce/purchase-documents/:id/receipts
 *     POST   /commerce/purchase-documents/:id/receipts/:receiptLineId/compensate
 *
 *   RETURNS    (return-history.controller.ts / return.dto.ts) — child lifecycle
 *     GET    /commerce/purchase-documents/:id/returns
 *     POST   /commerce/purchase-documents/:id/returns
 *     POST   /commerce/purchase-documents/:id/returns/:returnId/{approve,reject,receive-back,refund}
 *
 *   COMMERCIAL (commercial.controller.ts / commercial.dto.ts) — reads + the one
 *                manual assignment mutation UI-0/J6 assigns to the detail screen
 *     GET    /commerce/commercial-groups
 *     GET    /commerce/commercial-assignments?documentId=
 *     POST   /commerce/commercial-assignments
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY
 * ------------------------------------
 *  * NO `tenantId` ANYWHERE. The Commerce actor is derived server-side by
 *    `resolveCommerceActor(req)` from the authenticated principal, and the global
 *    `ValidationPipe` runs with `forbidNonWhitelisted`, so a request carrying one is
 *    refused rather than silently scoped. No code path in this client can ask for
 *    another tenant's documents.
 *  * NO workflow-execution route. C1/GAP-1 established that no HTTP
 *    workflow-instance endpoint exists; a client method for it would be a fake
 *    endpoint by another name.
 *  * NO PATCH/PUT/DELETE on payments, receipts or returns: those slices are
 *    append-only by contract, and compensation is its own POST.
 *
 * `core-http` is used exclusively, so there is exactly one session mechanism, one
 * error mapping and one response-envelope rule for the whole admin surface.
 */

/** Matches `COMMERCE_DEFAULT_PAGE_SIZE` / `COMMERCE_MAX_PAGE_SIZE` in commerce.constants.ts. */
export const COMMERCE_DEFAULT_PAGE_SIZE = 20;
export const COMMERCE_MAX_PAGE_SIZE = 100;

/**
 * The document lifecycle, verbatim from `purchase-status.ts` (§5.11) — six members, in the
 * schema's order. These are the ONLY values the register can return, so the filter select
 * is built from this tuple rather than from a hand-written list that could drift.
 */
export const COMMERCE_DOCUMENT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'CLOSED',
] as const;

export type CommerceDocumentStatus = (typeof COMMERCE_DOCUMENT_STATUSES)[number];

/** Closed at one member, exactly as `PURCHASE_DOCUMENT_KINDS` is. */
export type CommerceDocumentKind = 'PURCHASE_REQUEST';

/** The line vocabulary, verbatim from `PURCHASE_LINE_TYPES` (§5.2) — closed at three. */
export const COMMERCE_LINE_TYPES = ['STANDARD', 'NON_STANDARD', 'SERVICE'] as const;
export type CommerceLineType = (typeof COMMERCE_LINE_TYPES)[number];

/**
 * The commercial-approval lifecycle (`CommercialApprovalState`): its OWN lifecycle, not the
 * workflow's and not the document's (C1 step P).
 */
export type CommerceApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** The allowlisted person projection — identical to `DirectoryUserProfile`. */
export interface CommerceIdentity {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
}

/**
 * The requester as the wire states it: the id ALWAYS, and the profile ONLY when one
 * resolves. A `null` profile is data — a deleted identity, or an id from another tenant's
 * directory — and the screen decides how to show it rather than receiving a plausible
 * empty name.
 */
export interface CommerceRequesterRef {
  id: string;
  profile: CommerceIdentity | null;
}

/** One line as the wire states it. Money is the exact `Decimal(18,4)` STRING, or null. */
export interface CommercePurchaseLine {
  id: string;
  lineNumber: number;
  lineType: CommerceLineType;
  quantity: string;
  unit: string;
  unitPrice: string | null;
  tax: string | null;
  lineTotal: string | null;
  externalRef: string | null;
  itemReference: string | null;
  technicalDescription: string | null;
}

/** One purchase document as the register returns it (`PurchaseService.serialize`). */
export interface CommercePurchaseDocument {
  id: string;
  documentNumber: string;
  kind: CommerceDocumentKind;
  status: CommerceDocumentStatus;
  /** The same flag the PATCH guard uses — a client renders editability from it. */
  editable: boolean;
  /**
   * PHASE C4-R (C1 §29): the COMPLETION ACTOR and TIMESTAMP, `null` until the purchase
   * is completed — the two facts §29 requires to be recorded, projected by the same read
   * that answers every other question about the document.
   */
  completedByUserId: string | null;
  completedAt: string | null;
  requester: CommerceRequesterRef;
  supplierId: string | null;
  currency: string | null;
  subtotalAmount: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  lines: CommercePurchaseLine[];
  createdAt: string;
  updatedAt: string;
}

/** One page of the register: `items` + the window the server resolved. */
export interface CommercePurchasePage {
  items: CommercePurchaseDocument[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * One commercial-approval record (`CommercialApproval`). The service returns repository
 * rows, so the row's own identity fields are present; `tenantId` is deliberately NOT
 * declared here — it is never rendered and never used, and a type that omits it makes
 * "the frontend does not depend on it" a property of the code rather than a promise.
 */
export interface CommerceApproval {
  id: string;
  purchaseLineId: string;
  purchaseDocumentId: string;
  status: CommerceApprovalStatus;
  approverUserId: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceApprovalsRead {
  documentId: string;
  approvals: CommerceApproval[];
}

/** The register filter — every field OPTIONAL, exactly the DTO's own shape. */
export interface CommercePurchaseQuery {
  page?: number;
  pageSize?: number;
  /** Matches `documentNumber` only (the backend says so; nothing narrower is implied). */
  search?: string;
  status?: CommerceDocumentStatus;
  requesterId?: string;
}

/** Trims a filter, and drops one that is blank rather than sending it empty. */
function text(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The one place `pageSize` is capped, using the constant the API declares. */
function cappedPageSize(pageSize: number | undefined): number | undefined {
  return pageSize === undefined ? undefined : Math.min(pageSize, COMMERCE_MAX_PAGE_SIZE);
}

function query(pairs: Array<[string, string | number | undefined | null]>): string {
  const params: string[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    params.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return params.length > 0 ? `?${params.join('&')}` : '';
}

/** `{ search: 'PR-1405' }` → `?search=PR-1405`. Persian filters are encoded, never raw. */
export function buildPurchaseDocumentQuery(input: CommercePurchaseQuery = {}): string {
  return query([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
    ['search', text(input.search)],
    ['status', input.status],
    ['requesterId', text(input.requesterId)],
  ]);
}

/** One page of the tenant's purchase documents, newest first. `commerce.read`. */
export function fetchCommercePurchaseDocuments(
  query: CommercePurchaseQuery = {}
): Promise<CommercePurchasePage> {
  return coreGet<CommercePurchasePage>(
    `/commerce/purchase-documents${buildPurchaseDocumentQuery(query)}`
  );
}

/** A document's commercial approvals — their OWN lifecycle, not the workflow's. */
export function fetchCommerceCommercialApprovals(documentId: string): Promise<CommerceApprovalsRead> {
  return coreGet<CommerceApprovalsRead>(
    `/commerce/commercial-approvals?documentId=${encodeURIComponent(documentId)}`
  );
}

/**
 * UI-1 Option A (from the UI-0 contract §8.1): the PENDING approvals the backend already
 * assigned to THIS user — the actor check the decision route enforces, applied as a
 * DISPLAY filter so the task workspace shows only rows this person can decide.
 *
 * IT IS A FILTER, NOT A RULE: nothing here computes who SHOULD approve; it reads
 * `approverUserId` the activation stored and compares it to the session's own id. The
 * server remains the authority (a decision still runs the full check). A `null` user id
 * yields an empty list rather than matching rows whose approver is unknown.
 */
export function pendingApprovalsForUser(
  approvals: readonly CommerceApproval[],
  userId: string | null
): CommerceApproval[] {
  if (!userId) return [];
  return approvals.filter(
    (approval) => approval.status === 'PENDING' && approval.approverUserId === userId
  );
}

// =============================================================================
// PHASE UI-2 — PURCHASE: one-document read, create, update-while-draft, submit
// =============================================================================

/** One line as the WRITE contract states it — `PurchaseLineInputDto`, field for field. */
export interface CommercePurchaseLineInput {
  lineType: CommerceLineType;
  /** Positive, at most 4 decimals; `Decimal(18,4)` bound enforced server-side. */
  quantity: number;
  unit?: string;
  unitPrice?: number;
  /** An AMOUNT, never a rate (the DTO says so explicitly). */
  tax?: number;
  externalRef?: string;
  itemReference?: string;
  technicalDescription?: string;
}

/**
 * One line as the CREATE/EDIT FORM holds it — every number a STRING, because a
 * controlled numeric input that stores a `number` loses the user's half-typed
 * «12.» mid-edit. `serializePurchaseLine` converts to the wire shape below.
 *
 * `key` is client-only (React identity for the editable row) and is NEVER sent.
 */
export interface CommercePurchaseLineDraft {
  key: string;
  lineType: CommerceLineType;
  quantity: string;
  unit: string;
  unitPrice: string;
  tax: string;
  externalRef: string;
  itemReference: string;
  technicalDescription: string;
}

/** A fresh empty draft — the form's initial line, with STANDARD preselected (its first member). */
export function emptyPurchaseLineDraft(key: string): CommercePurchaseLineDraft {
  return {
    key,
    lineType: 'STANDARD',
    quantity: '',
    unit: '',
    unitPrice: '',
    tax: '',
    externalRef: '',
    itemReference: '',
    technicalDescription: '',
  };
}

/** Trims a form string and yields `undefined` for blank — never `''`, never `null`. */
function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Parses a form decimal; blank → `undefined` (the DTO's "not stated"). */
function optionalAmount(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Draft → wire line. Optional fields are OMITTED when blank, which is exactly the
 * DTO's `@IsOptional()` semantics: an unstated price is "not priced yet", never 0.
 * Numbers are `Number()` values — validation (range, decimal places) happens in the
 * form before this is called; the backend re-validates and remains authoritative.
 */
export function serializePurchaseLine(draft: CommercePurchaseLineDraft): CommercePurchaseLineInput {
  const input: CommercePurchaseLineInput = {
    lineType: draft.lineType,
    quantity: Number(draft.quantity.trim()),
  };
  const unit = optionalText(draft.unit);
  const unitPrice = optionalAmount(draft.unitPrice);
  const tax = optionalAmount(draft.tax);
  const externalRef = optionalText(draft.externalRef);
  const itemReference = optionalText(draft.itemReference);
  const technicalDescription = optionalText(draft.technicalDescription);
  if (unit !== undefined) input.unit = unit;
  if (unitPrice !== undefined) input.unitPrice = unitPrice;
  if (tax !== undefined) input.tax = tax;
  if (externalRef !== undefined) input.externalRef = externalRef;
  if (itemReference !== undefined) input.itemReference = itemReference;
  if (technicalDescription !== undefined) input.technicalDescription = technicalDescription;
  return input;
}

/** `POST /commerce/purchase-documents` — `CreatePurchaseDocumentDto`, no `status`, no number. */
export interface CommerceCreatePurchaseInput {
  requesterId: string;
  supplierId?: string;
  currency?: string;
  lines: CommercePurchaseLineInput[];
}

/**
 * `PATCH /commerce/purchase-documents/:id` — `UpdatePurchaseDocumentDto`.
 * `undefined` = leave untouched, `null` = clear. The view sends `null` only when
 * the user actually cleared a field.
 */
export interface CommerceUpdatePurchaseInput {
  requesterId?: string;
  supplierId?: string | null;
  currency?: string | null;
  lines?: CommercePurchaseLineInput[];
}

/** One document with its lines and requester profile — `PurchaseService.serialize`. */
export function fetchCommercePurchaseDocument(id: string): Promise<CommercePurchaseDocument> {
  return coreGet<CommercePurchaseDocument>(
    `/commerce/purchase-documents/${encodeURIComponent(id)}`
  );
}

/** Raise a purchase request as a DRAFT (201). The document number is minted server-side. */
export function createCommercePurchaseDocument(
  input: CommerceCreatePurchaseInput
): Promise<CommercePurchaseDocument> {
  return corePost<CommercePurchaseDocument>('/commerce/purchase-documents', input);
}

/** Change a DRAFT (200). 409 once the document is submitted — the route's own refusal. */
export function updateCommercePurchaseDocument(
  id: string,
  input: CommerceUpdatePurchaseInput
): Promise<CommercePurchaseDocument> {
  return corePatch<CommercePurchaseDocument>(
    `/commerce/purchase-documents/${encodeURIComponent(id)}`,
    input
  );
}

/**
 * `POST …/submit` — DRAFT → SUBMITTED, once (200, not 201: nothing is created).
 * NO body: the route declares none, and a retry after success is a 409 the UI
 * surfaces rather than a silent double-routing.
 */
export function submitCommercePurchaseDocument(id: string): Promise<CommercePurchaseDocument> {
  return corePost<CommercePurchaseDocument>(
    `/commerce/purchase-documents/${encodeURIComponent(id)}/submit`
  );
}

/**
 * PHASE C4-R (GAP-3): COMPLETE the purchase — `POST …/close` (200), the document's own
 * status moving to `CLOSED` and ONLY when the tenant's published Purchase Completion
 * Policy permits it.
 *
 * NO BODY: the action IS the route. What the document's state permits is the published
 * policy's answer on the server (an unconfigured tenant answers the named 409
 * `PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED`), and no client may state an actor, a
 * tenant or a timestamp — all three are server-derived and recorded by the act.
 *
 * NOTE FOR UI AUTHORS: §29 requires the eventual control to confirm with a warning
 * before calling this (the shared `CommerceConfirmDialog`), and the C4-R brief leaves
 * that control to an explicit later task — this client method exists so the contract is
 * complete, not so a button appears.
 */
export function closeCommercePurchaseDocument(
  id: string
): Promise<CommercePurchaseDocument> {
  return corePost<CommercePurchaseDocument>(
    `/commerce/purchase-documents/${encodeURIComponent(id)}/close`
  );
}

// =============================================================================
// PHASE UI-2 — PAYMENTS: append-only history + full-negation compensation (C1-Q)
// =============================================================================

/** `PAYMENT_METHODS`, verbatim — closed at three; CHECK is a METHOD, never an entity. */
export const COMMERCE_PAYMENT_METHODS = ['CASH', 'PETTY_CASH', 'CHECK'] as const;
export type CommercePaymentMethod = (typeof COMMERCE_PAYMENT_METHODS)[number];

/** `PAYMENT_STATUSES`, verbatim — the read-time projection over the WHOLE history. */
export const COMMERCE_PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID'] as const;
export type CommercePaymentStatus = (typeof COMMERCE_PAYMENT_STATUSES)[number];

/** One stored payment row — `PaymentHistoryService.view`. Money is the exact wire STRING. */
export interface CommercePaymentRecord {
  id: string;
  amount: string;
  currency: string;
  method: CommercePaymentMethod;
  paymentDate: string | null;
  payerRef: string | null;
  payeeRef: string | null;
  invoiceRef: string | null;
  externalReference: string | null;
  /** Non-null marks a COMPENSATING row; the row it reverses names it back. */
  reversesPaymentId: string | null;
  recordedByUserId: string | null;
  createdAt: string;
}

/**
 * The projection beside the page — computed server-side over ALL rows. `status`
 * may be `null` ("no total stated"): that is NOT `UNPAID` and is never rendered as it.
 */
export interface CommercePaymentStatusProjection {
  status: CommercePaymentStatus | null;
  paidAmount: string;
  totalAmount: string | null;
  currency: string | null;
}

export interface CommercePaymentsRead {
  items: CommercePaymentRecord[];
  page: number;
  pageSize: number;
  total: number;
  paymentStatus: CommercePaymentStatusProjection;
}

/** `CreatePaymentDto` — no `currency` (snapshotted server-side), no `reversesPaymentId`. */
export interface CommerceAppendPaymentInput {
  amount: number;
  method: CommercePaymentMethod;
  paymentDate?: string;
  payerRef?: string;
  payeeRef?: string;
  invoiceRef?: string;
  externalReference?: string;
}

/** `CompensatePaymentDto` — everything optional; the server negates the target exactly. */
export interface CommerceCompensatePaymentInput {
  paymentDate?: string;
  externalReference?: string;
  reason?: string;
}

/** One page of the history, oldest first, beside the whole-history projection (`commerce.read`). */
export function fetchCommercePayments(
  documentId: string,
  options: { page?: number; pageSize?: number; method?: CommercePaymentMethod } = {}
): Promise<CommercePaymentsRead> {
  const params = query([
    ['page', options.page],
    ['pageSize', cappedPageSize(options.pageSize)],
    ['method', options.method],
  ]);
  return coreGet<CommercePaymentsRead>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/payments${params}`
  );
}

/** Append one payment event (201). No optimistic update ever — refetch after success. */
export function appendCommercePayment(
  documentId: string,
  input: CommerceAppendPaymentInput
): Promise<CommercePaymentRecord> {
  return corePost<CommercePaymentRecord>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/payments`,
    input
  );
}

/**
 * Append the compensating row (201). The target lives in the PATH — a payload
 * cannot point the reversal at another row, which is why `paymentId` never appears
 * in the body.
 */
export function compensateCommercePayment(
  documentId: string,
  paymentId: string,
  input: CommerceCompensatePaymentInput = {}
): Promise<CommercePaymentRecord> {
  return corePost<CommercePaymentRecord>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/payments/${encodeURIComponent(
      paymentId
    )}/compensate`,
    input
  );
}

// =============================================================================
// PHASE UI-2 — RECEIVING: append-only events + partial compensation (C1-R)
// =============================================================================

/** `RECEIVING_STATUSES`, verbatim — the per-line projection over the whole history. */
export const COMMERCE_RECEIVING_STATUSES = [
  'NOT_RECEIVED',
  'PARTIALLY_RECEIVED',
  'FULLY_RECEIVED',
] as const;
export type CommerceReceivingStatus = (typeof COMMERCE_RECEIVING_STATUSES)[number];

/** One stored receipt-line event — a correction is a NEGATIVE quantity, never an edit. */
export interface CommerceReceiptLine {
  id: string;
  purchaseLineId: string;
  quantity: string;
  reversesReceiptLineId: string | null;
  createdAt: string;
}

/** One receiving event (header + its lines) — `receiptView` in the receiving service. */
export interface CommerceReceipt {
  id: string;
  receivedAt: string;
  receiverId: string | null;
  createdAt: string;
  lines: CommerceReceiptLine[];
}

/** Per-line projection: EVERY line appears, including one with no events at all. */
export interface CommerceReceivingLineProjection {
  purchaseLineId: string;
  orderedQuantity: string;
  receivedQuantity: string;
  receivingStatus: CommerceReceivingStatus;
}

export interface CommerceReceiptsRead {
  receipts: CommerceReceipt[];
  lines: CommerceReceivingLineProjection[];
}

/** `CreateReceiptDto` — one operation; the same purchase line may appear more than once. */
export interface CommerceAppendReceiptInput {
  receivedAt?: string;
  lines: Array<{ purchaseLineId: string; quantity: number }>;
}

/** `CompensateReceiptLineDto` — a POSITIVE magnitude; the service derives the sign. */
export interface CommerceCompensateReceiptInput {
  quantity: number;
  receivedAt?: string;
  reason?: string;
}

/** The document's whole receipt history + per-line projection (`commerce.read`). */
export function fetchCommerceReceipts(documentId: string): Promise<CommerceReceiptsRead> {
  return coreGet<CommerceReceiptsRead>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/receipts`
  );
}

/** Append one receiving event (201). Over-receipt is a 409 the backend refuses under lock. */
export function appendCommerceReceipt(
  documentId: string,
  input: CommerceAppendReceiptInput
): Promise<CommerceReceipt> {
  return corePost<CommerceReceipt>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/receipts`,
    input
  );
}

/** Append the COMPENSATING event for one receipt line (201). The original row is untouched. */
export function compensateCommerceReceiptLine(
  documentId: string,
  receiptLineId: string,
  input: CommerceCompensateReceiptInput
): Promise<CommerceReceipt> {
  return corePost<CommerceReceipt>(
    `/commerce/purchase-documents/${encodeURIComponent(
      documentId
    )}/receipts/${encodeURIComponent(receiptLineId)}/compensate`,
    input
  );
}

// =============================================================================
// PHASE UI-2 — RETURNS: a child lifecycle with its OWN state machine (C1-S)
// =============================================================================

/** `RETURN_STATES`, verbatim — five members; REJECTED and REFUNDED are terminal. */
export const COMMERCE_RETURN_STATES = [
  'REQUESTED',
  'APPROVED',
  'RECEIVED_BACK',
  'REFUNDED',
  'REJECTED',
] as const;
export type CommerceReturnState = (typeof COMMERCE_RETURN_STATES)[number];

/** One returned quantity: which purchase line, against WHICH arrival, how much. */
export interface CommerceReturnLine {
  id: string;
  purchaseLineId: string;
  receiptLineId: string;
  quantity: string;
  createdAt: string;
}

/** One append-only transition row — `state` is a projection of this chain, never a column. */
export interface CommerceReturnTransition {
  id: string;
  state: CommerceReturnState;
  actorUserId: string | null;
  reason: string | null;
  createdAt: string;
}

/** One return document as the wire states it — `returnView`. */
export interface CommerceReturn {
  id: string;
  reason: string;
  replacementRequired: boolean;
  requestedByUserId: string | null;
  createdAt: string;
  state: CommerceReturnState;
  lines: CommerceReturnLine[];
  transitions: CommerceReturnTransition[];
}

export interface CommerceReturnsRead {
  returns: CommerceReturn[];
}

/** `CreateReturnDto` — reason 1…500 non-empty, `replacementRequired` REQUIRED (no default). */
export interface CommerceCreateReturnInput {
  reason: string;
  replacementRequired: boolean;
  lines: Array<{ purchaseLineId: string; receiptLineId: string; quantity: number }>;
}

/** `ReturnDecisionDto` — approve and reject share it: an optional stated why. */
export interface CommerceReturnDecisionInput {
  reason?: string;
}

/** `RefundReturnDto` — Q's compensation target; the amount is never stated. */
export interface CommerceRefundReturnInput {
  paymentId: string;
  reason?: string;
}

/** The document's whole return history with lines and transitions, oldest first. */
export function fetchCommerceReturns(documentId: string): Promise<CommerceReturnsRead> {
  return coreGet<CommerceReturnsRead>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/returns`
  );
}

/** Append one return (201) — starts at REQUESTED with its initial transition. */
export function createCommerceReturn(
  documentId: string,
  input: CommerceCreateReturnInput
): Promise<CommerceReturn> {
  return corePost<CommerceReturn>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/returns`,
    input
  );
}

/** `REQUESTED → APPROVED` (201). An illegal source state is a 409 `invalid_transition`. */
export function approveCommerceReturn(
  documentId: string,
  returnId: string,
  input: CommerceReturnDecisionInput = {}
): Promise<CommerceReturn> {
  return corePost<CommerceReturn>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/returns/${encodeURIComponent(
      returnId
    )}/approve`,
    input
  );
}

/** `REQUESTED → REJECTED` (201) — the return's own state; the parent is untouched. */
export function rejectCommerceReturn(
  documentId: string,
  returnId: string,
  input: CommerceReturnDecisionInput = {}
): Promise<CommerceReturn> {
  return corePost<CommerceReturn>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/returns/${encodeURIComponent(
      returnId
    )}/reject`,
    input
  );
}

/**
 * `APPROVED → RECEIVED_BACK` (201). NO BODY, deliberately: `ReceiveBackReturnDto`
 * accepts no statable field, and C1-J9 fixes "the UI sends no body" as the contract.
 */
export function receiveBackCommerceReturn(
  documentId: string,
  returnId: string
): Promise<CommerceReturn> {
  return corePost<CommerceReturn>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/returns/${encodeURIComponent(
      returnId
    )}/receive-back`
  );
}

/**
 * `RECEIVED_BACK → REFUNDED` (201) through Q's compensation. A Q refusal arrives
 * as 409 `refund_compensation_failed` with NO REFUNDED transition written.
 */
export function refundCommerceReturn(
  documentId: string,
  returnId: string,
  input: CommerceRefundReturnInput
): Promise<CommerceReturn> {
  return corePost<CommerceReturn>(
    `/commerce/purchase-documents/${encodeURIComponent(documentId)}/returns/${encodeURIComponent(
      returnId
    )}/refund`,
    input
  );
}

// =============================================================================
// PHASE UI-2 — COMMERCIAL: reads + the ONE manual assignment mutation (C1-P, J6)
// =============================================================================

export type CommerceAssignmentState = 'ASSIGNED' | 'UNASSIGNED';

/**
 * Provenance of an assignment row — `CommercialAssignmentSource`, verbatim. The first two
 * are workflow trigger events; `MANUAL` names the explicit API operation.
 */
export const COMMERCE_ASSIGNMENT_SOURCES = [
  'PURCHASE_SUBMITTED',
  'AFTER_DOCUMENT_WORKFLOW_APPROVED',
  'MANUAL',
] as const;
export type CommerceAssignmentSource = (typeof COMMERCE_ASSIGNMENT_SOURCES)[number];

/**
 * One CURRENT assignment row (line-scoped, one per line). The backend read returns the
 * stored row; `tenantId` exists in the raw row but is deliberately NOT declared here —
 * the client never reads it back out and never sends it anywhere.
 */
export interface CommerceAssignment {
  id: string;
  purchaseLineId: string;
  purchaseDocumentId: string;
  commercialGroupId: string | null;
  status: CommerceAssignmentState;
  source: CommerceAssignmentSource;
  resolvedUserId: string | null;
  matchedRuleLabel: string | null;
  configurationVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One APPEND-ONLY history entry — the previous state stays readable forever. */
export interface CommerceAssignmentHistoryEntry {
  id: string;
  purchaseLineId: string;
  commercialGroupId: string | null;
  status: CommerceAssignmentState;
  source: CommerceAssignmentSource;
  resolvedUserId: string | null;
  matchedRuleLabel: string | null;
  configurationVersionId: string | null;
  actorUserId: string | null;
  reason: string | null;
  changedAt: string;
}

export interface CommerceAssignmentsRead {
  documentId: string;
  assignments: CommerceAssignment[];
  history: CommerceAssignmentHistoryEntry[];
}

/** One tenant commercial group — the assign dialog's candidate list. */
export interface CommerceCommercialGroup {
  id: string;
  code: string;
  name: string;
  liaisonUserId: string | null;
}

export interface CommerceCommercialGroupsPage {
  items: CommerceCommercialGroup[];
  page: number;
  pageSize: number;
  total: number;
}

/** `CreateCommercialAssignmentDto` — line-first; no documentId, no tenant, no actor. */
export interface CommerceAssignLineInput {
  lineId: string;
  groupId: string;
  reason?: string;
}

/** A document's current assignments plus its append-only history (`commerce.read`). */
export function fetchCommerceAssignments(documentId: string): Promise<CommerceAssignmentsRead> {
  return coreGet<CommerceAssignmentsRead>(
    `/commerce/commercial-assignments?documentId=${encodeURIComponent(documentId)}`
  );
}

/** One page of the tenant's commercial groups — candidates for a manual assignment. */
export function fetchCommerceCommercialGroups(
  options: { page?: number; pageSize?: number } = {}
): Promise<CommerceCommercialGroupsPage> {
  const params = query([
    ['page', options.page],
    ['pageSize', cappedPageSize(options.pageSize)],
  ]);
  return coreGet<CommerceCommercialGroupsPage>(`/commerce/commercial-groups${params}`);
}

/**
 * Manual assignment / reassignment of ONE line (201, `commerce.manage`). Refused on a
 * terminal document and for an identical re-assignment — both arrive as 409 codes the
 * section renders; the caller refetches the read afterwards rather than trusting the row.
 */
export function assignCommerceLine(input: CommerceAssignLineInput): Promise<CommerceAssignment> {
  return corePost<CommerceAssignment>('/commerce/commercial-assignments', input);
}

// =============================================================================
// PHASE UI-3 — COMMERCIAL DECISION (C1-P §9, `commerce.approve`)
// =============================================================================

/**
 * The ONLY decision vocabulary — `COMMERCIAL_APPROVAL_DECISIONS` verbatim from
 * `commercial-status.ts` (closed at these two members; `APPROVED`/`REJECTED`, never an
 * invented `CONFIRM`/`DECLINE`). The DTO validates against exactly this tuple.
 */
export const COMMERCE_APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type CommerceApprovalDecision = (typeof COMMERCE_APPROVAL_DECISIONS)[number];

/**
 * `CommercialApprovalDecisionDto` — exactly two fields. NO actor identity of any kind:
 * who decides is derived from the session server-side (`resolveCommerceActor`), and the
 * server compares it with the approver stored at activation.
 */
export interface CommerceApprovalDecisionInput {
  decision: CommerceApprovalDecision;
  /** Optional, ≤1000 chars; omitted (not sent) when blank → stored as `null`. */
  comment?: string;
}

/**
 * `POST /commerce/commercial-approvals/:id/decision` — 200 with the DECIDED record.
 *
 * The response is the RAW stored row, so the return type declares ONLY the fields this
 * client consumes (never `tenantId` or other storage metadata) — the whitelist rule
 * UI-3 §13: an unconsumed field is not typed, not rendered and never sent anywhere.
 */
export function submitCommerceCommercialDecision(
  approvalId: string,
  input: CommerceApprovalDecisionInput
): Promise<CommerceApproval> {
  return corePost<CommerceApproval>(
    `/commerce/commercial-approvals/${encodeURIComponent(approvalId)}/decision`,
    input
  );
}

// =============================================================================
// PHASE UI-4 — CONFIGURATION (C1-M workflow configuration, C1-P commercial)
// =============================================================================

/**
 * The workflow VERSION lifecycle, verbatim from `workflow-status.ts`: exactly the four
 * members `WorkflowDefinitionVersionStatus` declares, in the schema's order. The
 * commercial configuration version REUSES this same tuple (§6), which is why there is
 * one constant and not two — a second spelling of "what a version may be" is the drift
 * the backend's own comment forbids.
 */
export const COMMERCE_WORKFLOW_VERSION_STATUSES = [
  'DRAFT',
  'VALIDATED',
  'PUBLISHED',
  'ARCHIVED',
] as const;

export type CommerceWorkflowVersionStatus = (typeof COMMERCE_WORKFLOW_VERSION_STATUSES)[number];

/** `WORKFLOW_STEP_EXECUTION_MODES` — how a step executes. */
export const COMMERCE_WORKFLOW_STEP_EXECUTION_MODES = [
  'SEQUENTIAL',
  'PARALLEL',
  'CONDITIONAL',
] as const;

export type CommerceWorkflowStepExecutionMode =
  (typeof COMMERCE_WORKFLOW_STEP_EXECUTION_MODES)[number];

/**
 * `WORKFLOW_ACTOR_SOURCES` — HOW an approver is resolved (§5.8). The full modelled
 * vocabulary: a DRAFT may state any of them (planning), and the list is closed.
 */
export const COMMERCE_WORKFLOW_ACTOR_SOURCES = [
  'REQUESTER_MANAGER',
  'GROUP_MANAGER',
  'COMMERCIAL_LIAISON',
  'CONFIGURED_USER',
  'CONFIGURED_ROLE',
  'RULE_RESOLVER',
] as const;

export type CommerceWorkflowActorSource = (typeof COMMERCE_WORKFLOW_ACTOR_SOURCES)[number];

/**
 * `WORKFLOW_EXECUTABLE_ACTOR_SOURCES` — what publication ACCEPTS. The stored vocabulary
 * is wider than this on purpose; only a source in this list may appear in a published
 * version (everything else is refused with `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED`). The UI
 * states this in helper text rather than inventing executability.
 */
export const COMMERCE_WORKFLOW_EXECUTABLE_ACTOR_SOURCES = ['CONFIGURED_USER'] as const;

/** `WORKFLOW_CONDITION_FALSE_BEHAVIORS` — a step's configured false path (§4). */
export const COMMERCE_WORKFLOW_CONDITION_FALSE_BEHAVIORS = [
  'SKIPPED',
  'BLOCKED',
  'TERMINATED',
] as const;

export type CommerceWorkflowConditionFalseBehavior =
  (typeof COMMERCE_WORKFLOW_CONDITION_FALSE_BEHAVIORS)[number];

/** `WORKFLOW_PARALLEL_JOIN_POLICIES` — how a group of parallel branches completes. */
export const COMMERCE_WORKFLOW_PARALLEL_JOIN_POLICIES = ['ALL', 'ANY'] as const;

export type CommerceWorkflowParallelJoinPolicy =
  (typeof COMMERCE_WORKFLOW_PARALLEL_JOIN_POLICIES)[number];

/** `WORKFLOW_TRIGGER_EVENTS` — the closed trigger vocabulary (two members). */
export const COMMERCE_WORKFLOW_TRIGGER_EVENTS = [
  'PURCHASE_SUBMITTED',
  'AFTER_DOCUMENT_WORKFLOW_APPROVED',
] as const;

export type CommerceWorkflowTriggerEvent = (typeof COMMERCE_WORKFLOW_TRIGGER_EVENTS)[number];

/**
 * DTO bounds, mirrored — every one is the `VARCHAR(n)` the value lands in
 * (`workflow-configuration.dto.ts` states the same rule). They bound the CLIENT's inputs
 * so an over-long value is a field error before a request; the backend bound stays the
 * contract.
 */
export const COMMERCE_WORKFLOW_MAX_DEFINITION_CODE_LENGTH = 64;
export const COMMERCE_WORKFLOW_MAX_DEFINITION_NAME_LENGTH = 200;
export const COMMERCE_WORKFLOW_MAX_VERSION_LABEL_LENGTH = 64;
export const COMMERCE_WORKFLOW_MAX_STEP_KEY_LENGTH = 64;
export const COMMERCE_WORKFLOW_MAX_DISPLAY_NAME_LENGTH = 200;
export const COMMERCE_WORKFLOW_MAX_PARALLEL_GROUP_LENGTH = 64;

/**
 * The COMMERCIAL side's vocabulary mirrors — each tuple is the backend's own, verbatim
 * from `commercial-status.ts` (`commercial.dto.ts` validates against exactly these).
 */
export const COMMERCE_COMMERCIAL_ASSIGNMENT_TRIGGERS = [
  'PURCHASE_SUBMITTED',
  'AFTER_DOCUMENT_WORKFLOW_APPROVED',
] as const;

export type CommerceCommercialAssignmentTrigger =
  (typeof COMMERCE_COMMERCIAL_ASSIGNMENT_TRIGGERS)[number];

export const COMMERCE_COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS = [
  'REJECT_OPERATION',
  'LEAVE_UNASSIGNED',
] as const;

export type CommerceCommercialNoAssignmentBehavior =
  (typeof COMMERCE_COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS)[number];

export const COMMERCE_COMMERCIAL_MATCH_BEHAVIORS = [
  'HIGHEST_PRIORITY',
  'AMBIGUOUS_ERROR',
] as const;

export type CommerceCommercialMatchBehavior = (typeof COMMERCE_COMMERCIAL_MATCH_BEHAVIORS)[number];

export const COMMERCE_COMMERCIAL_APPROVAL_ACTIVATIONS = [
  'NOT_REQUIRED',
  ...COMMERCE_COMMERCIAL_ASSIGNMENT_TRIGGERS,
] as const;

export type CommerceCommercialApprovalActivation =
  (typeof COMMERCE_COMMERCIAL_APPROVAL_ACTIVATIONS)[number];

export const COMMERCE_COMMERCIAL_APPROVAL_APPROVERS = [
  'LINE_COMMERCIAL_LIAISON',
  'CONFIGURED_USER',
] as const;

export type CommerceCommercialApprovalApprover =
  (typeof COMMERCE_COMMERCIAL_APPROVAL_APPROVERS)[number];

export const COMMERCE_COMMERCIAL_PROJECTION_POLICIES = [
  'DOCUMENT_WORKFLOW',
  'ALL_LINES',
  'DOCUMENT_WORKFLOW_AND_COMMERCIAL',
  'ALL_LINES_AND_COMMERCIAL',
] as const;

export type CommerceCommercialProjectionPolicy =
  (typeof COMMERCE_COMMERCIAL_PROJECTION_POLICIES)[number];

/** Mirrors `MAX_COMMERCIAL_GROUP_CODE_LENGTH` / `MAX_COMMERCIAL_GROUP_NAME_LENGTH`. */
export const COMMERCE_COMMERCIAL_MAX_GROUP_CODE_LENGTH = 64;
export const COMMERCE_COMMERCIAL_MAX_GROUP_NAME_LENGTH = 128;

/** Mirrors `MAX_COMMERCIAL_VERSION_LABEL_LENGTH`. */
export const COMMERCE_COMMERCIAL_MAX_VERSION_LABEL_LENGTH = 64;

/**
 * Mirrors `MAX_COMMERCIAL_RULE_LABEL_LENGTH`, DERIVED the same way the DTO derives it:
 * `RULE_LIMITS.maxIdentifierLength` (128) − `'commercial-assign:'` (18) − uuid (36) − 1.
 */
export const COMMERCE_COMMERCIAL_MAX_RULE_LABEL_LENGTH = 73;

/** Mirrors `RULE_LIMITS.minPriority` / `maxPriority` — the engine's own bounds. */
export const COMMERCE_COMMERCIAL_MIN_PRIORITY = -1_000_000;
export const COMMERCE_COMMERCIAL_MAX_PRIORITY = 1_000_000;

// -----------------------------------------------------------------------------
// The frozen fact catalogues and the SIMPLE condition the UI may author
// -----------------------------------------------------------------------------

/**
 * One frozen fact, as `workflow-facts.ts` declares it (`RuleFieldCatalogue`). This is a
 * MIRROR of data the engine owns: the condition editor offers only these names, so a
 * field the engine's validator would refuse at publish cannot be picked. Nothing here
 * evaluates anything — the backend remains the only evaluator.
 */
export interface CommerceRuleFact {
  name: string;
  type: 'enum' | 'string' | 'number';
  enumValues?: readonly string[];
}

/** `COMMERCE_WORKFLOW_FACT_CATALOGUE` — the DOCUMENT facts (activation/selection). */
export const COMMERCE_WORKFLOW_DOCUMENT_FACTS: readonly CommerceRuleFact[] = [
  { name: 'kind', type: 'enum', enumValues: ['PURCHASE_REQUEST'] },
  { name: 'currency', type: 'string' },
  { name: 'supplierId', type: 'string' },
  { name: 'requesterId', type: 'string' },
  { name: 'subtotalAmount', type: 'number' },
  { name: 'taxAmount', type: 'number' },
  { name: 'totalAmount', type: 'number' },
  { name: 'lineCount', type: 'number' },
  { name: 'maxLineTotal', type: 'number' },
];

/** `COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE` — the LINE facts (assignment rules). */
export const COMMERCE_WORKFLOW_LINE_FACTS: readonly CommerceRuleFact[] = [
  { name: 'lineType', type: 'enum', enumValues: ['STANDARD', 'NON_STANDARD', 'SERVICE'] },
  { name: 'lineNumber', type: 'number' },
  { name: 'quantity', type: 'number' },
  { name: 'unit', type: 'string' },
  { name: 'unitPrice', type: 'number' },
  { name: 'tax', type: 'number' },
  { name: 'lineTotal', type: 'number' },
  { name: 'itemReference', type: 'string' },
  { name: 'externalRef', type: 'string' },
  { name: 'technicalDescription', type: 'string' },
];

/**
 * The scalar comparison operators the SIMPLE-condition editor can author, per fact type.
 * The engine's full operator set is wider (`in`/`notIn` take arrays, `dateBetween` takes
 * a range, the date operators take calendar days) and those shapes are deliberately NOT
 * authorable here: the editor authors only `{ field, op, value }` leaves whose operand is
 * one scalar — a bounded subset of the frozen grammar, never a new one. The engine stays
 * the authority on validity.
 */
const SCALAR_OPERATORS_BY_TYPE: Record<CommerceRuleFact['type'], readonly string[]> = Object.freeze({
  enum: ['equals', 'notEquals'],
  string: ['equals', 'notEquals', 'isEmpty', 'isNotEmpty'],
  number: ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'],
});

/** The operators this editor offers for one fact — type-paired, never free-form. */
export function commerceRuleOperatorsFor(fact: CommerceRuleFact): readonly string[] {
  return SCALAR_OPERATORS_BY_TYPE[fact.type] ?? [];
}

/** Operators that carry NO operand (the engine's `FORBIDDEN` shape). */
const OPERATORS_WITHOUT_VALUE: readonly string[] = ['isEmpty', 'isNotEmpty'];

/** The editor's own model of an authored leaf: `{ field, op, value }`. */
export interface CommerceSimpleConditionDraft {
  field: string;
  op: string;
  /** Absent exactly for `isEmpty`/`isNotEmpty` (the operator's own shape). */
  value?: string | number;
}

/**
 * Read a STORED condition through the same shape the editor authors. Returns the draft
 * when the stored value is a simple leaf this UI can faithfully round-trip
 * (`{field, op, value}` with a string `op`), and `null` for anything else — a composite
 * tree (`all`/`any`/`not`/`count`), an array operand, or a value this client does not
 * know. `null` means "present but not authorable here", which the UI renders read-only
 * rather than rewriting.
 */
export function readCommerceSimpleCondition(value: unknown): CommerceSimpleConditionDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.field !== 'string' || typeof record.op !== 'string') return null;

  if (OPERATORS_WITHOUT_VALUE.includes(record.op)) {
    return Object.prototype.hasOwnProperty.call(record, 'value')
      ? null
      : { field: record.field, op: record.op };
  }

  const operand = record.value;
  if (typeof operand === 'string' || (typeof operand === 'number' && Number.isFinite(operand))) {
    return { field: record.field, op: record.op, value: operand };
  }
  return null;
}

/**
 * Build the wire node for a simple condition — `{ field, op, value }`, and no `value` key
 * at all for an operator whose shape forbids one. The shape is the engine's own leaf; no
 * transformation, no evaluation, no client-side semantics.
 */
export function buildCommerceSimpleCondition(
  draft: CommerceSimpleConditionDraft
): Record<string, unknown> {
  if (OPERATORS_WITHOUT_VALUE.includes(draft.op)) {
    return { field: draft.field, op: draft.op };
  }
  return { field: draft.field, op: draft.op, value: draft.value };
}

// -----------------------------------------------------------------------------
// WORKFLOW CONFIGURATION types (C1-M wire projections)
// -----------------------------------------------------------------------------

/** One definition — `serializeDefinition`: identity, name, and the version COUNT. */
export interface CommerceWorkflowDefinition {
  id: string;
  code: string;
  name: string;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceWorkflowDefinitionsPage {
  items: CommerceWorkflowDefinition[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * One version's own fields, as both the list and the detail state them
 * (`serializeVersion`). `triggerEvent`/`parallelJoinPolicy` are `string | null`
 * deliberately: the columns are nullable while a DRAFT is incomplete, and a value this
 * client does not know must still render as itself rather than crash a cast.
 */
export interface CommerceWorkflowVersionRecord {
  id: string;
  workflowDefinitionId: string;
  versionLabel: string;
  status: CommerceWorkflowVersionStatus;
  triggerEvent: string | null;
  parallelJoinPolicy: string | null;
  selectionPriority: number | null;
  selectionCondition: unknown;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A list row: the version's fields plus its step COUNT (read in one snapshot). */
export interface CommerceWorkflowVersionSummary extends CommerceWorkflowVersionRecord {
  stepCount: number;
}

export interface CommerceWorkflowVersionsPage {
  items: CommerceWorkflowVersionSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** One step — `serializeStep`, field for field. Payload columns are passed through. */
export interface CommerceWorkflowStep {
  id: string;
  stepKey: string;
  displayName: string;
  mandatory: boolean;
  executionMode: string;
  ordering: number;
  parallelGroup: string | null;
  condition: unknown;
  onConditionFalse: string | null;
  actorSource: string | null;
  actorUserId: string | null;
  actorRoleCode: string | null;
  actorRule: unknown;
  thresholds: unknown;
  lineFilters: unknown;
  configuration: unknown;
  createdAt: string;
  updatedAt: string;
}

/** `GET workflow-versions/:id` — the version WITH its steps, in the stated order. */
export interface CommerceWorkflowVersion extends CommerceWorkflowVersionRecord {
  steps: CommerceWorkflowStep[];
}


/** `CreateWorkflowDefinitionDto` — exactly `{ code, name }`. */
export interface CommerceWorkflowDefinitionInput {
  code: string;
  name: string;
}

/** `RenameWorkflowDefinitionDto` — exactly `{ name }`. */
export interface CommerceWorkflowDefinitionRenameInput {
  name: string;
}

/**
 * `CreateWorkflowVersionDto` — `versionLabel` required; the routing columns optional
 * (absent = not stated yet, which is legal on a DRAFT; publication judges completeness).
 */
export interface CommerceWorkflowVersionInput {
  versionLabel: string;
  triggerEvent?: CommerceWorkflowTriggerEvent;
}

/**
 * `UpdateWorkflowVersionDto` — `undefined` leaves a column alone, `null` CLEARS it (the
 * two-kinds-of-absence rule the DTO states). No `versionLabel` and no `status`: a
 * version's label is its identity to the tenant, and the lifecycle is walked by the
 * routes that own each transition.
 */
export interface CommerceWorkflowVersionPatch {
  triggerEvent?: CommerceWorkflowTriggerEvent | null;
  parallelJoinPolicy?: CommerceWorkflowParallelJoinPolicy | null;
  selectionPriority?: number | null;
}

/** `CreateWorkflowStepDto` / `WorkflowStepInputDto` — every field the UI may state. */
export interface CommerceWorkflowStepInput {
  stepKey: string;
  displayName: string;
  ordering: number;
  mandatory?: boolean;
  executionMode?: CommerceWorkflowStepExecutionMode;
  parallelGroup?: string | null;
  condition?: Record<string, unknown> | null;
  onConditionFalse?: CommerceWorkflowConditionFalseBehavior | null;
  actorSource?: CommerceWorkflowActorSource | null;
  actorUserId?: string | null;
  actorRoleCode?: string | null;
}

/**
 * `UpdateWorkflowStepDto` — the same fields, every one optional, with the SAME
 * `undefined` = keep / `null` = clear semantics. The UI sends exactly this shape.
 */
export interface CommerceWorkflowStepPatch {
  stepKey?: string;
  displayName?: string;
  ordering?: number;
  mandatory?: boolean;
  executionMode?: CommerceWorkflowStepExecutionMode;
  parallelGroup?: string | null;
  condition?: Record<string, unknown> | null;
  onConditionFalse?: CommerceWorkflowConditionFalseBehavior | null;
  actorSource?: CommerceWorkflowActorSource | null;
  actorUserId?: string | null;
  actorRoleCode?: string | null;
}

/** `DELETE workflow-versions/:versionId/steps/:stepId` — the removed id, named. */
export interface CommerceWorkflowStepDeletion {
  deleted: true;
  stepId: string;
}

/**
 * One finding of a configuration report, as `workflow-configuration.service.ts` answers
 * a refusal with it: `{ message, level, issues, truncated }` beside the HTTP status. The
 * message says something is wrong; `refusal` says WHAT, `stepKey` says WHICH step, and
 * `path` locates it — which is the whole reason a UI can help an administrator fix a
 * version without a deployment.
 */
export interface CommerceWorkflowValidationIssue {
  refusal: string;
  stepKey?: string;
  path?: string;
  detail?: string;
}

export interface CommerceWorkflowValidationReport {
  level?: string;
  issues: CommerceWorkflowValidationIssue[];
  truncated?: boolean;
}

/**
 * Read the structured report off a failed validate/publish, or `null` when the refusal
 * carried none (a plain lifecycle 409, a network failure, a different shape). A PURE
 * READER: it validates nothing and hides nothing — an issue member without a string
 * `refusal` is dropped because it could not be named, not because it was judged.
 */
export function readCommerceWorkflowValidationReport(
  error: unknown
): CommerceWorkflowValidationReport | null {
  const details = error instanceof CoreApiError ? error.details : null;
  if (!details || typeof details !== 'object') return null;
  const record = details as { issues?: unknown; level?: unknown; truncated?: unknown };
  if (!Array.isArray(record.issues)) return null;

  const issues = record.issues
    .filter(
      (issue): issue is CommerceWorkflowValidationIssue =>
        Boolean(issue) &&
        typeof issue === 'object' &&
        typeof (issue as { refusal?: unknown }).refusal === 'string'
    )
    .map((issue) => ({ ...issue }));

  return {
    ...(typeof record.level === 'string' ? { level: record.level } : {}),
    issues,
    ...(typeof record.truncated === 'boolean' ? { truncated: record.truncated } : {}),
  };
}

// -----------------------------------------------------------------------------
// WORKFLOW CONFIGURATION routes (C1-M) — exact paths, exact methods
// -----------------------------------------------------------------------------

/** The definitions list's query: the shared page window plus its `search` filter. */
export function buildCommerceWorkflowDefinitionsQuery(
  input: { page?: number; pageSize?: number; search?: string } = {}
): string {
  return query([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
    ['search', text(input.search)],
  ]);
}

/** One page of the tenant's workflow definitions, newest first (`commerce.read`). */
export function fetchCommerceWorkflowDefinitions(
  input: { page?: number; pageSize?: number; search?: string } = {}
): Promise<CommerceWorkflowDefinitionsPage> {
  return coreGet<CommerceWorkflowDefinitionsPage>(
    `/commerce/workflow-definitions${buildCommerceWorkflowDefinitionsQuery(input)}`
  );
}

/** One definition with its version count (`commerce.read`). */
export function fetchCommerceWorkflowDefinition(
  definitionId: string
): Promise<CommerceWorkflowDefinition> {
  return coreGet<CommerceWorkflowDefinition>(
    `/commerce/workflow-definitions/${encodeURIComponent(definitionId)}`
  );
}

/** Create a definition — 201 with the created row (`commerce.configure`). */
export function createCommerceWorkflowDefinition(
  input: CommerceWorkflowDefinitionInput
): Promise<CommerceWorkflowDefinition> {
  return corePost<CommerceWorkflowDefinition>('/commerce/workflow-definitions', input);
}

/** Rename a definition — a label edit that opens no version (`commerce.configure`). */
export function renameCommerceWorkflowDefinition(
  definitionId: string,
  input: CommerceWorkflowDefinitionRenameInput
): Promise<CommerceWorkflowDefinition> {
  return corePatch<CommerceWorkflowDefinition>(
    `/commerce/workflow-definitions/${encodeURIComponent(definitionId)}`,
    input
  );
}

/** The versions list's query: the shared page window plus its `status` filter. */
export function buildCommerceWorkflowVersionsQuery(
  input: { page?: number; pageSize?: number; status?: CommerceWorkflowVersionStatus } = {}
): string {
  return query([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
    ['status', input.status],
  ]);
}

/** One page of a definition's versions, newest first; `status` narrows WITHIN it. */
export function fetchCommerceWorkflowVersions(
  definitionId: string,
  input: { page?: number; pageSize?: number; status?: CommerceWorkflowVersionStatus } = {}
): Promise<CommerceWorkflowVersionsPage> {
  return coreGet<CommerceWorkflowVersionsPage>(
    `/commerce/workflow-definitions/${encodeURIComponent(
      definitionId
    )}/versions${buildCommerceWorkflowVersionsQuery(input)}`
  );
}

/** Open a new version — always born DRAFT; 201 with the version SUMMARY. */
export function createCommerceWorkflowVersion(
  definitionId: string,
  input: CommerceWorkflowVersionInput
): Promise<CommerceWorkflowVersionSummary> {
  return corePost<CommerceWorkflowVersionSummary>(
    `/commerce/workflow-definitions/${encodeURIComponent(definitionId)}/versions`,
    input
  );
}

/** One version WITH its steps, in the stated order (`commerce.read`). */
export function fetchCommerceWorkflowVersion(versionId: string): Promise<CommerceWorkflowVersion> {
  return coreGet<CommerceWorkflowVersion>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}`
  );
}

/**
 * Change a DRAFT version's own routing columns (200 with the version + steps). Refused
 * with a 409 once the version is no longer a DRAFT — a change to a published
 * configuration is a NEW version, never an edit.
 */
export function updateCommerceWorkflowVersion(
  versionId: string,
  patch: CommerceWorkflowVersionPatch
): Promise<CommerceWorkflowVersion> {
  return corePatch<CommerceWorkflowVersion>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}`,
    patch
  );
}

/**
 * Walk DRAFT → VALIDATED (200 with the version). A refusal is 400/409 and carries the
 * structured `{level, issues, truncated}` report — read it with
 * `readCommerceWorkflowValidationReport`.
 */
export function validateCommerceWorkflowVersion(
  versionId: string
): Promise<CommerceWorkflowVersion> {
  return corePost<CommerceWorkflowVersion>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}/validate`
  );
}

/** Walk VALIDATED → PUBLISHED (200). Only a VALIDATED version may be published. */
export function publishCommerceWorkflowVersion(
  versionId: string
): Promise<CommerceWorkflowVersion> {
  return corePost<CommerceWorkflowVersion>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}/publish`
  );
}

/** Walk PUBLISHED → ARCHIVED (200). One way, like every other edge. */
export function archiveCommerceWorkflowVersion(
  versionId: string
): Promise<CommerceWorkflowVersion> {
  return corePost<CommerceWorkflowVersion>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}/archive`
  );
}

/** Add one step to a DRAFT version — 201 with the created STEP (not the version). */
export function addCommerceWorkflowStep(
  versionId: string,
  input: CommerceWorkflowStepInput
): Promise<CommerceWorkflowStep> {
  return corePost<CommerceWorkflowStep>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}/steps`,
    input
  );
}

/** Change one step of a DRAFT version — 200 with the updated STEP. */
export function updateCommerceWorkflowStep(
  versionId: string,
  stepId: string,
  patch: CommerceWorkflowStepPatch
): Promise<CommerceWorkflowStep> {
  return corePatch<CommerceWorkflowStep>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}/steps/${encodeURIComponent(stepId)}`,
    patch
  );
}

/** Remove one step from a DRAFT version — 200 with the removed id. */
export function deleteCommerceWorkflowStep(
  versionId: string,
  stepId: string
): Promise<CommerceWorkflowStepDeletion> {
  return coreDelete<CommerceWorkflowStepDeletion>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}/steps/${encodeURIComponent(stepId)}`
  );
}

/**
 * State the version's step order IN FULL — every step id, in the order it should
 * execute (PUT, because the body REPLACES the order). Answers with the version detail,
 * whose `steps` are in the new order.
 */
export function reorderCommerceWorkflowSteps(
  versionId: string,
  order: readonly string[]
): Promise<CommerceWorkflowVersion> {
  return corePut<CommerceWorkflowVersion>(
    `/commerce/workflow-versions/${encodeURIComponent(versionId)}/steps/order`,
    { order }
  );
}

// -----------------------------------------------------------------------------
// COMMERCIAL CONFIGURATION types (C1-P wire rows)
// -----------------------------------------------------------------------------

/**
 * One commercial configuration version, as the service returns the stored ROW. ONLY the
 * fields this client consumes are declared (the UI-3 §13 whitelist rule): `tenantId` and
 * other storage metadata are never typed, never rendered and never sent anywhere.
 *
 * NOTE WHAT IS ABSENT: there is no `publishedAt` column on this model, so none is
 * declared — the wire does not carry one and the UI does not invent one.
 */
export interface CommerceCommercialConfigurationRecord {
  id: string;
  versionLabel: string;
  status: CommerceWorkflowVersionStatus;
  assignmentTrigger: string;
  noAssignmentBehavior: string;
  matchBehavior: string;
  assignmentRules: unknown;
  approvalActivation: string;
  approvalApprover: string | null;
  approverUserId: string | null;
  applicabilityCondition: unknown;
  projectionPolicy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceCommercialConfigurationPage {
  items: CommerceCommercialConfigurationRecord[];
  page: number;
  pageSize: number;
  total: number;
}

/** One stored assignment candidate — `{ label, priority, condition, commercialGroupId }`. */
export interface CommerceCommercialConfigurationRule {
  label: string;
  priority: number;
  commercialGroupId: string;
  condition?: Record<string, unknown> | null;
}

/**
 * Read a stored `assignmentRules` payload through the shape the planner writes. Members
 * that are not objects with a string label and a group id are dropped — the STORED rows
 * were validated at publish, and this reader renders what is there rather than guessing.
 */
export function readCommerceCommercialAssignmentRules(
  raw: unknown
): CommerceCommercialConfigurationRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (rule): rule is Record<string, unknown> =>
        Boolean(rule) &&
        typeof rule === 'object' &&
        typeof (rule as { label?: unknown }).label === 'string' &&
        typeof (rule as { commercialGroupId?: unknown }).commercialGroupId === 'string'
    )
    .map((rule) => ({
      label: rule.label as string,
      priority: typeof rule.priority === 'number' ? rule.priority : 0,
      commercialGroupId: rule.commercialGroupId as string,
      ...(rule.condition && typeof rule.condition === 'object'
        ? { condition: rule.condition as Record<string, unknown> }
        : {}),
    }));
}

/**
 * `CreateCommercialConfigurationDto` — every member the backend requires, typed with the
 * closed vocabularies. `assignmentRules` carries at least one entry (`ArrayMinSize(1)`),
 * which is why the create form cannot start empty.
 */
export interface CommerceCommercialConfigurationInput {
  versionLabel: string;
  assignmentTrigger: CommerceCommercialAssignmentTrigger;
  noAssignmentBehavior: CommerceCommercialNoAssignmentBehavior;
  matchBehavior: CommerceCommercialMatchBehavior;
  assignmentRules: CommerceCommercialConfigurationRule[];
  approvalActivation: CommerceCommercialApprovalActivation;
  approvalApprover?: CommerceCommercialApprovalApprover | null;
  approverUserId?: string | null;
  applicabilityCondition?: Record<string, unknown> | null;
  projectionPolicy: CommerceCommercialProjectionPolicy;
}

/** `UpdateCommercialConfigurationDto` — every field optional; absent = untouched. */
export interface CommerceCommercialConfigurationPatch {
  versionLabel?: string;
  assignmentTrigger?: CommerceCommercialAssignmentTrigger;
  noAssignmentBehavior?: CommerceCommercialNoAssignmentBehavior;
  matchBehavior?: CommerceCommercialMatchBehavior;
  assignmentRules?: CommerceCommercialConfigurationRule[];
  approvalActivation?: CommerceCommercialApprovalActivation;
  approvalApprover?: CommerceCommercialApprovalApprover | null;
  approverUserId?: string | null;
  applicabilityCondition?: Record<string, unknown> | null;
  projectionPolicy?: CommerceCommercialProjectionPolicy;
}

/** `CreateCommercialGroupDto` — `code` + `name`; `liaisonUserId` is optional. */
export interface CommerceCommercialGroupInput {
  code: string;
  name: string;
  liaisonUserId?: string;
}

/**
 * `UpdateCommercialGroupDto` — `name` and/or `liaisonUserId`; `null` CLEARS the liaison
 * on purpose (a modelled state), `undefined` leaves it. `code` is not editable.
 */
export interface CommerceCommercialGroupPatch {
  name?: string;
  liaisonUserId?: string | null;
}

// -----------------------------------------------------------------------------
// COMMERCIAL CONFIGURATION routes (C1-P) — exact paths, exact methods
// -----------------------------------------------------------------------------

/** One page of the tenant's commercial configuration versions, newest first. */
export function fetchCommerceCommercialConfigurations(
  input: { page?: number; pageSize?: number } = {}
): Promise<CommerceCommercialConfigurationPage> {
  const params = query([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
  return coreGet<CommerceCommercialConfigurationPage>(`/commerce/commercial-configurations${params}`);
}

/** One version — the read carries the whole row, rules and conditions included. */
export function fetchCommerceCommercialConfiguration(
  configurationId: string
): Promise<CommerceCommercialConfigurationRecord> {
  return coreGet<CommerceCommercialConfigurationRecord>(
    `/commerce/commercial-configurations/${encodeURIComponent(configurationId)}`
  );
}

/** Create a DRAFT version — 201 with the row (`commerce.configure`). */
export function createCommerceCommercialConfiguration(
  input: CommerceCommercialConfigurationInput
): Promise<CommerceCommercialConfigurationRecord> {
  return corePost<CommerceCommercialConfigurationRecord>('/commerce/commercial-configurations', input);
}

/** Edit a DRAFT — 200 with the row; a non-DRAFT is refused (409) before anything moves. */
export function updateCommerceCommercialConfiguration(
  configurationId: string,
  patch: CommerceCommercialConfigurationPatch
): Promise<CommerceCommercialConfigurationRecord> {
  return corePatch<CommerceCommercialConfigurationRecord>(
    `/commerce/commercial-configurations/${encodeURIComponent(configurationId)}`,
    patch
  );
}

/** Run the §7 checklist and walk DRAFT → VALIDATED (200). */
export function validateCommerceCommercialConfiguration(
  configurationId: string
): Promise<CommerceCommercialConfigurationRecord> {
  return corePost<CommerceCommercialConfigurationRecord>(
    `/commerce/commercial-configurations/${encodeURIComponent(configurationId)}/validate`
  );
}

/**
 * Validate + publish + archive the previously published version, atomically (200).
 * Reachable from a DRAFT (which is validated in the same act) or a VALIDATED version;
 * a PUBLISHED or ARCHIVED version is refused with its status named.
 */
export function publishCommerceCommercialConfiguration(
  configurationId: string
): Promise<CommerceCommercialConfigurationRecord> {
  return corePost<CommerceCommercialConfigurationRecord>(
    `/commerce/commercial-configurations/${encodeURIComponent(configurationId)}/publish`
  );
}

/** Archive a version — including the published one, which retires the policy (200). */
export function archiveCommerceCommercialConfiguration(
  configurationId: string
): Promise<CommerceCommercialConfigurationRecord> {
  return corePost<CommerceCommercialConfigurationRecord>(
    `/commerce/commercial-configurations/${encodeURIComponent(configurationId)}/archive`
  );
}

// -----------------------------------------------------------------------------
// COMMERCIAL GROUP write routes (C1-P §9) — the reads already exist above
// -----------------------------------------------------------------------------

/** One group, or 404 for an id this tenant does not hold (`commerce.read`). */
export function fetchCommerceCommercialGroup(groupId: string): Promise<CommerceCommercialGroup> {
  return coreGet<CommerceCommercialGroup>(
    `/commerce/commercial-groups/${encodeURIComponent(groupId)}`
  );
}

/** Create a group — 201; a taken `code` is the contract's own 409 (`commerce.configure`). */
export function createCommerceCommercialGroup(
  input: CommerceCommercialGroupInput
): Promise<CommerceCommercialGroup> {
  return corePost<CommerceCommercialGroup>('/commerce/commercial-groups', input);
}

/** Rename a group and/or swap its liaison (`commerce.configure`). */
export function updateCommerceCommercialGroup(
  groupId: string,
  patch: CommerceCommercialGroupPatch
): Promise<CommerceCommercialGroup> {
  return corePatch<CommerceCommercialGroup>(
    `/commerce/commercial-groups/${encodeURIComponent(groupId)}`,
    patch
  );
}

// -----------------------------------------------------------------------------
// PURCHASE COMPLETION POLICY routes (PHASE C4-R / GAP-3) — exact paths, exact methods
//
//   GET    /commerce/completion-policies             (list, commerce.read)
//   GET    /commerce/completion-policies/:id         (read one, commerce.read)
//   POST   /commerce/completion-policies             (open a DRAFT, commerce.configure)
//   PATCH  /commerce/completion-policies/:id         (edit a DRAFT, commerce.configure)
//   POST   /commerce/completion-policies/:id/validate
//   POST   /commerce/completion-policies/:id/publish
//   POST   /commerce/completion-policies/:id/archive
//
// The COMPLETION ACT itself is `POST /commerce/purchase-documents/:id/close`
// (commerce.manage) — see `closeCommercePurchaseDocument` below.
//
// WHAT IS DELIBERATELY ABSENT: no `tenantId` (the actor is server-resolved), no
// client-writable `status` (the routes that own each transition are the ones above), and
// NO prerequisite field of any kind — the model has none, because C1 §29 keeps payment,
// receiving, workflow and return state out of completion and no source makes any of them
// a precondition. A client asking for one is asking for a field the pipe refuses.
// -----------------------------------------------------------------------------

/**
 * The statuses a completion policy may name, verbatim from `purchase-status.ts` — the
 * document's own lifecycle minus its destination (`CLOSED`). THIS IS THE WHOLE
 * CONFIGURABLE SURFACE of the completion rule: which of these a tenant allows is the
 * product's choice, and the backend contains no preference among them.
 */
export const COMMERCE_COMPLETION_SOURCE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

export type CommerceCompletionSourceStatus = (typeof COMMERCE_COMPLETION_SOURCE_STATUSES)[number];

/** One completion policy version, as the configuration routes return it. */
export interface CommerceCompletionPolicyRecord {
  id: string;
  status: CommerceWorkflowVersionStatus;
  versionLabel: string;
  allowedFromStatuses: CommerceCompletionSourceStatus[];
  createdAt: string;
  updatedAt: string;
}

export interface CommerceCompletionPolicyPage {
  items: CommerceCompletionPolicyRecord[];
  page: number;
  pageSize: number;
  total: number;
}

/** Create payload — a label and the set; nothing else exists to state. */
export interface CommerceCompletionPolicyInput {
  versionLabel: string;
  allowedFromStatuses: CommerceCompletionSourceStatus[];
}

/** A DRAFT's editable half: the status set (the label is the row's identity). */
export interface CommerceCompletionPolicyPatch {
  allowedFromStatuses: CommerceCompletionSourceStatus[];
}

/** One page of the tenant's completion policies, newest first (`commerce.read`). */
export function fetchCommerceCompletionPolicies(
  input: { page?: number; pageSize?: number; search?: string } = {}
): Promise<CommerceCompletionPolicyPage> {
  const params = query([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
    ['search', text(input.search)],
  ]);
  return coreGet<CommerceCompletionPolicyPage>(`/commerce/completion-policies${params}`);
}

/** One policy version — including the statuses completion is permitted from. */
export function fetchCommerceCompletionPolicy(
  policyId: string
): Promise<CommerceCompletionPolicyRecord> {
  return coreGet<CommerceCompletionPolicyRecord>(
    `/commerce/completion-policies/${encodeURIComponent(policyId)}`
  );
}

/** Open a DRAFT — 201 with the row; a label this tenant already uses is its own 409. */
export function createCommerceCompletionPolicy(
  input: CommerceCompletionPolicyInput
): Promise<CommerceCompletionPolicyRecord> {
  return corePost<CommerceCompletionPolicyRecord>('/commerce/completion-policies', input);
}

/** Edit a DRAFT's status set — 200; a validated or published row is refused (409). */
export function updateCommerceCompletionPolicy(
  policyId: string,
  patch: CommerceCompletionPolicyPatch
): Promise<CommerceCompletionPolicyRecord> {
  return corePatch<CommerceCompletionPolicyRecord>(
    `/commerce/completion-policies/${encodeURIComponent(policyId)}`,
    patch
  );
}

/** Run the checklist against the stored row and walk DRAFT → VALIDATED (200). */
export function validateCommerceCompletionPolicy(
  policyId: string
): Promise<CommerceCompletionPolicyRecord> {
  return corePost<CommerceCompletionPolicyRecord>(
    `/commerce/completion-policies/${encodeURIComponent(policyId)}/validate`
  );
}

/**
 * Validate if needed, publish, and archive the previously published policy — one act, so
 * the tenant always has EXACTLY ONE published policy: the one the close route reads.
 * A PUBLISHED or ARCHIVED row is refused with its status named (409).
 */
export function publishCommerceCompletionPolicy(
  policyId: string
): Promise<CommerceCompletionPolicyRecord> {
  return corePost<CommerceCompletionPolicyRecord>(
    `/commerce/completion-policies/${encodeURIComponent(policyId)}/publish`
  );
}

/** Archive a version — including the published one, which RETIRES completion (200). */
export function archiveCommerceCompletionPolicy(
  policyId: string
): Promise<CommerceCompletionPolicyRecord> {
  return corePost<CommerceCompletionPolicyRecord>(
    `/commerce/completion-policies/${encodeURIComponent(policyId)}/archive`
  );
}
