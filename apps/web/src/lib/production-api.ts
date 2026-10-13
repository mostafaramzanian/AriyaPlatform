import { coreDelete, coreGet, corePatch, corePost } from './core-http';

/**
 * Phase PRODUCTION-BOM: the Production (BOM) client for apps/web.
 *
 * MIRRORS THE BACKEND CONTRACT EXACTLY — every route below was read off
 * `bom.controller.ts` and `bom-item.controller.ts` before it was written:
 *
 *   HEADER   (bom.controller.ts / bom.dto.ts)
 *     GET    /production/boms                       (list)
 *     GET    /production/boms/:id                   (one)
 *     POST   /production/boms                       (create → DRAFT, 201)
 *     PATCH  /production/boms/:id                   (update while DRAFT, 200)
 *     POST   /production/boms/:id/submit            (DRAFT → SUBMITTED, 200)
 *     POST   /production/boms/:id/approve           (200)
 *     POST   /production/boms/:id/reject            (200)
 *     POST   /production/boms/:id/request-correction(200)
 *
 *   TIMELINE (bom.controller.ts / bom.dto.ts) — a READ of the platform audit trail
 *     GET    /production/boms/:id/timeline          (200, chronological, read-only)
 *
 *   ITEM     (bom-item.controller.ts / bom-item.dto.ts) — a CHILD of one header
 *     GET    /production/boms/:bomId/items
 *     GET    /production/boms/:bomId/items/:itemId
 *     POST   /production/boms/:bomId/items          (201)
 *     PATCH  /production/boms/:bomId/items/:itemId  (200)
 *     DELETE /production/boms/:bomId/items/:itemId  (200)
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY
 * ------------------------------------
 *  * NO `tenantId` ANYWHERE. The actor is derived server-side by
 *    `resolveProductionActor(req)`, and the global `ValidationPipe` runs with
 *    `forbidNonWhitelisted`, so a request carrying one is refused rather than silently
 *    scoped. No code path here can ask for another tenant's BOM.
 *  * NO `standardPartCode` on any WRITE. `CodeStandardDarSanat` is a RESERVED, DEFERRED
 *    field: the Product Tree code source that would drive it is BLOCKED (RB-1-P), so the
 *    client cannot generate one, cannot send one (the DTO's whitelist would 400 it) and
 *    does not offer an input for it. The field is READ on an item — a migrated value may
 *    exist — and always `null` for a row this API created.
 *  * NO DELETE on a BOM HEADER. There is no such route (rule 8 of the item contract: a
 *    header delete is not permitted without a new policy), so a client method for it would
 *    be a fake endpoint by another name.
 *  * NO status field on any PATCH. The lifecycle is walked by the routes that own each
 *    transition; a body that could state `APPROVED` would be a way to approve your own BOM.
 *
 * `core-http` is used exclusively, so there is exactly one session mechanism, one error
 * mapping and one response-envelope rule for the whole admin surface.
 */

/** Mirrors `PRODUCTION_MAX_PAGE_SIZE` / `PRODUCTION_DEFAULT_PAGE_SIZE`. */
export const PRODUCTION_DEFAULT_PAGE_SIZE = 20;
export const PRODUCTION_MAX_PAGE_SIZE = 100;

/** Mirrors `BomStatus` in `bom-status.ts` — the four states, in the schema's order. */
export type ProductionBomStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

/** Mirrors `BOM_MANAGER_OPINIONS` — the three values the legacy radio offered. */
export type ProductionManagerOpinion = 'APPROVED' | 'REJECTED' | 'NEEDS_CORRECTION';

/** Mirrors `BomPartType` — the source's `ساختی;استاندارد`. */
export type ProductionPartType = 'STRUCTURAL' | 'STANDARD';

/** Mirrors `BomControlPlan` — the source's `دارد;ندارد`. Optional. */
export type ProductionControlPlan = 'PRESENT' | 'ABSENT';

/** One BOM header as `BomHeaderView` returns it — the stored fact, no derived field. */
export interface ProductionBom {
  id: string;
  title: string;
  projectRef: string;
  productTreeRef: string;
  requesterUserId: string;
  approverUserId: string | null;
  status: ProductionBomStatus;
  managerOpinion: ProductionManagerOpinion | null;
  comments: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One page of headers — the exact envelope the list route answers with. */
export interface ProductionBomPage {
  items: ProductionBom[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One BOM item as `BomItemView` returns it — the DOMAIN half only.
 *
 * `standardPartCode` is typed as nullable on purpose (the DEFERRED field), and the five
 * derived coefficients plus the legacy `state` / `NazarModir` are absent: they are stored
 * for migration, and a screen must not render an artefact as a live fact.
 */
export interface ProductionBomItem {
  id: string;
  bomId: string;
  projectRef: string;
  productTreeRef: string;
  partName: string;
  industryPartName: string | null;
  /** `CodeStandardDarSanat`. READ-ONLY and DEFERRED — nothing in this client writes it. */
  standardPartCode: string | null;
  partType: ProductionPartType;
  specifications: string | null;
  manufacturer: string | null;
  material: string;
  measurementUnit: string;
  drawingConsumptionCoefficient: number;
  spareConsumptionCoefficient: number;
  suggestedSupplier: string | null;
  /** A `Decimal` on the wire, so it crosses as a STRING — never a lossy binary float. */
  suggestedSupplierPrice: string | null;
  controlPlan: ProductionControlPlan | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionBomItemPage {
  items: ProductionBomItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: one entry of a BOM's audit timeline.
 *
 * THE SEVEN FIELDS THE API PROJECTS, AND NOTHING ELSE. `action` is the RAW audit
 * vocabulary (`create`, `submit`, `approve`, `reject`, `request_correction` …) — the
 * Persian rendering is `production-labels.ts`'s job, never the wire's. `actorId` is a
 * plain platform user id (an opaque reference, not a display name — resolving it to a
 * person is a directory read this client deliberately does not make). `changedFields`
 * carries field NAMES only; no value, no snapshot and no payload crosses this type.
 */
export interface ProductionBomTimelineEntry {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

/**
 * One page of the timeline — the same `{ items, page, pageSize, total }` envelope every
 * Production list returns, with `total` supplied by the platform's own count for this
 * resource binding.
 */
export interface ProductionBomTimelinePage {
  items: ProductionBomTimelineEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The timeline's query — ONLY a page window.
 *
 * The scope (`tenantId`, `resource`, `resourceId`) is bound server-side from the session
 * and the path, and the backend's DTO REFUSES these three as query parameters rather than
 * ignoring them. There is therefore no way to express a timeline read of another BOM or
 * another tenant through this client.
 */
export interface ProductionBomTimelineQuery {
  page?: number;
  pageSize?: number;
}

/** The header list filter — every field OPTIONAL, exactly the DTO's own shape. */
export interface ProductionBomQuery {
  page?: number;
  pageSize?: number;
  /** Matches the BOM TITLE only (the backend says so; nothing narrower is implied). */
  search?: string;
  status?: ProductionBomStatus;
}

/** The item list filter — `page` / `pageSize` / `search` (against the PART NAME). */
export interface ProductionBomItemQuery {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface CreateProductionBomInput {
  title: string;
  projectRef: string;
  productTreeRef: string;
  requesterUserId: string;
  approverUserId: string;
  comments?: string;
}

/** The PATCH payload — every field optional, and NO `status` / `managerOpinion`. */
export interface UpdateProductionBomInput {
  title?: string;
  projectRef?: string;
  productTreeRef?: string;
  approverUserId?: string;
  comments?: string;
}

/**
 * The CREATE payload for an item.
 *
 * `projectRef` / `productTreeRef` are DELIBERATELY absent: the backend copies the scope
 * snapshot off the header, so a payload that could claim a project would defeat the very
 * uniqueness scope the source validates against (§6.3).
 */
export interface CreateProductionBomItemInput {
  partName: string;
  industryPartName?: string;
  partType: ProductionPartType;
  specifications?: string;
  manufacturer?: string;
  material: string;
  measurementUnit: string;
  drawingConsumptionCoefficient: number;
  spareConsumptionCoefficient: number;
  suggestedSupplier?: string;
  suggestedSupplierPrice?: number;
  controlPlan?: ProductionControlPlan;
  notes?: string;
}

/** The PATCH payload for an item — every field optional, still no scope, no code. */
export interface UpdateProductionBomItemInput {
  partName?: string;
  industryPartName?: string;
  partType?: ProductionPartType;
  specifications?: string;
  manufacturer?: string;
  material?: string;
  measurementUnit?: string;
  drawingConsumptionCoefficient?: number;
  spareConsumptionCoefficient?: number;
  suggestedSupplier?: string;
  suggestedSupplierPrice?: number;
  controlPlan?: ProductionControlPlan;
  notes?: string;
}

/**
 * The DECISION payload. The outcome is fixed by the ROUTE — `approve`, `reject` and
 * `request-correction` each send their own opinion — and the backend refuses a body that
 * states a different one, so a client cannot obtain an APPROVED row from the reject route.
 */
export interface ProductionBomDecisionInput {
  opinion: ProductionManagerOpinion;
  comments?: string;
}

/** Trims a filter, and drops one that is blank rather than sending it empty. */
function text(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The one place `pageSize` is capped, using the constant the API declares. */
function cappedPageSize(pageSize: number | undefined): number | undefined {
  return pageSize === undefined ? undefined : Math.min(pageSize, PRODUCTION_MAX_PAGE_SIZE);
}

function queryString(pairs: Array<[string, string | number | undefined | null]>): string {
  const params: string[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    params.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return params.length > 0 ? `?${params.join('&')}` : '';
}

// =============================================================================
// HEADER
// =============================================================================

/** `{ search: 'سازه' }` → `?search=...`; Persian filters are encoded, never raw. */
export function buildProductionBomQuery(input: ProductionBomQuery = {}): string {
  return queryString([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
    ['search', text(input.search)],
    ['status', input.status],
  ]);
}

/** One page of the tenant's BOM headers, most recently touched first. `production.bom.read`. */
export function fetchProductionBoms(
  query: ProductionBomQuery = {}
): Promise<ProductionBomPage> {
  return coreGet<ProductionBomPage>(`/production/boms${buildProductionBomQuery(query)}`);
}

/** One BOM header, or 404 when the id is not this tenant's. */
export function fetchProductionBom(id: string): Promise<ProductionBom> {
  return coreGet<ProductionBom>(`/production/boms/${encodeURIComponent(id)}`);
}

/** Author a BOM header. It is created as a DRAFT. `production.bom.manage`. */
export function createProductionBom(
  input: CreateProductionBomInput
): Promise<ProductionBom> {
  return corePost<ProductionBom>('/production/boms', input);
}

/** Change a BOM while it is still a DRAFT. 409 once it has been submitted. */
export function updateProductionBom(
  id: string,
  input: UpdateProductionBomInput
): Promise<ProductionBom> {
  return corePatch<ProductionBom>(`/production/boms/${encodeURIComponent(id)}`, input);
}

/** DRAFT → SUBMITTED. The route takes NO body: the approver is the row's own snapshot. */
export function submitProductionBom(id: string): Promise<ProductionBom> {
  return corePost<ProductionBom>(`/production/boms/${encodeURIComponent(id)}/submit`);
}

/**
 * The three decision acts, each through its OWN route.
 *
 * `action` is the route; `input.opinion` is the confirmation the endpoint demands, and a
 * mismatch is a 400 rather than a body field that silently rewrites the meaning of the
 * call — which is what stops the reject endpoint producing an APPROVED row.
 */
export function decideProductionBom(
  id: string,
  action: 'approve' | 'reject' | 'request-correction',
  input: ProductionBomDecisionInput
): Promise<ProductionBom> {
  return corePost<ProductionBom>(
    `/production/boms/${encodeURIComponent(id)}/${action}`,
    input
  );
}

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the BOM's audit timeline, one page at a time.
 *
 * ONLY `page` / `pageSize` ARE SERIALISED. The scope is the path plus the session, so no
 * query parameter this client could emit asks for another BOM, another resource type or
 * another tenant — and the backend's DTO would refuse one anyway (its whitelist rejects
 * `resource`, `resourceId`, `tenantId` and `action`).
 *
 * THE ORDER IS THE PLATFORM'S (`createdAt ASC, id ASC`) AND IS NOT REVERSED HERE. The
 * entries are rendered in the order the trail recorded them; a screen that wants
 * newest-first reverses the array it was given rather than asking for a second order the
 * route does not have.
 *
 * An audit outage is NOT an empty timeline: the backend answers 503 `AUDIT_READ_FAILED`
 * and this function lets that error reach the caller, so a screen can tell "nothing was
 * recorded" apart from "we could not ask".
 */
export function buildProductionBomTimelineQuery(
  input: ProductionBomTimelineQuery = {}
): string {
  return queryString([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
  ]);
}

/** One page of the BOM's audit history. `production.bom.read`. */
export function fetchProductionBomTimeline(
  bomId: string,
  query: ProductionBomTimelineQuery = {}
): Promise<ProductionBomTimelinePage> {
  return coreGet<ProductionBomTimelinePage>(
    `/production/boms/${encodeURIComponent(bomId)}/timeline${buildProductionBomTimelineQuery(query)}`
  );
}

// =============================================================================
// ITEM — a CHILD of one header. Every call carries `bomId`, because the path is the
// scope: the backend resolves the header tenant-scoped from it, so an id that belongs
// to another tenant is a 404 rather than a widening of the caller's view.
// =============================================================================

/** `{ search: 'پیچ' }` → `?search=...`, matched against the PART NAME. */
export function buildProductionBomItemQuery(input: ProductionBomItemQuery = {}): string {
  return queryString([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
    ['search', text(input.search)],
  ]);
}

/** One page of a BOM's items, in the order they were added. */
export function fetchProductionBomItems(
  bomId: string,
  query: ProductionBomItemQuery = {}
): Promise<ProductionBomItemPage> {
  return coreGet<ProductionBomItemPage>(
    `/production/boms/${encodeURIComponent(bomId)}/items${buildProductionBomItemQuery(query)}`
  );
}

/** One item of this BOM, or 404 — including when it belongs to a different BOM. */
export function fetchProductionBomItem(bomId: string, itemId: string): Promise<ProductionBomItem> {
  return coreGet<ProductionBomItem>(
    `/production/boms/${encodeURIComponent(bomId)}/items/${encodeURIComponent(itemId)}`
  );
}

/** Add an item to a DRAFT BOM. 409 once the header has been submitted. */
export function createProductionBomItem(
  bomId: string,
  input: CreateProductionBomItemInput
): Promise<ProductionBomItem> {
  return corePost<ProductionBomItem>(
    `/production/boms/${encodeURIComponent(bomId)}/items`,
    input
  );
}

/** Change an item while its BOM is a DRAFT. 409 once it is submitted. */
export function updateProductionBomItem(
  bomId: string,
  itemId: string,
  input: UpdateProductionBomItemInput
): Promise<ProductionBomItem> {
  return corePatch<ProductionBomItem>(
    `/production/boms/${encodeURIComponent(bomId)}/items/${encodeURIComponent(itemId)}`,
    input
  );
}

/** Delete an item from a DRAFT BOM. Returns the id that was removed. */
export function deleteProductionBomItem(bomId: string, itemId: string): Promise<{ id: string }> {
  return coreDelete<{ id: string }>(
    `/production/boms/${encodeURIComponent(bomId)}/items/${encodeURIComponent(itemId)}`
  );
}



// =============================================================================
// BOM CHANGE REQUEST — Phase PRODUCTION-BOM-CHANGE («ثبت درخواست تغییر BOM»)
// =============================================================================
//
// MIRRORS THE BACKEND CONTRACT EXACTLY — every route below was read off
// `bom-change.controller.ts` before it was written:
//
//   GET    /production/bom-change-requests                    (register)
//   GET    /production/bom-change-requests/:id                (one, WITH its detail rows)
//   GET    /production/bom-change-requests/:id/timeline       (audit history)
//   POST   /production/bom-change-requests                    (create → DRAFT, 201)
//   PATCH  /production/bom-change-requests/:id                (update while DRAFT, 200)
//   POST   /production/bom-change-requests/:id/items          (add a detail, 201)
//   PATCH  /production/bom-change-requests/:id/items/:itemId  (edit a detail, 200)
//   DELETE /production/bom-change-requests/:id/items/:itemId  (remove a detail, 200)
//   POST   /production/bom-change-requests/:id/submit         (DRAFT → SUBMITTED, 200)
//   POST   /production/bom-change-requests/:id/approve        (200)
//   POST   /production/bom-change-requests/:id/reject         (200)
//   POST   /production/bom-change-requests/:id/request-correction (200)
//
// THE ITEM SEARCH IS NOT HERE, DELIBERATELY. Which BOM items are eligible is answered by
// the EXISTING `fetchProductionBomItems(bomId, { search })` — server-side, tenant-scoped
// and gated by `production.bom.read`. A second client method for the same read would be a
// second place for its filters to drift.
//
// NO `tenantId`, NO `requesterUserId`, NO `original*`, NO `total`, NO `status` on any
// WRITE — the actor is resolved server-side, the requester comes from the session, the
// snapshot comes from the item, the total is derived on screen (S8) and the lifecycle is
// walked by the routes that own each transition.

/** Mirrors `BomChangeType` — the source's `تغییر موجودی;غیر فعال سازی`, in that order. */
export const PRODUCTION_BOM_CHANGE_TYPES = ['QUANTITY_CHANGE', 'DEACTIVATE'] as const;
export type ProductionBomChangeType = (typeof PRODUCTION_BOM_CHANGE_TYPES)[number];

/** One change request as `BomChangeRequestView` returns it — the stored fact only. */
export interface ProductionBomChange {
  id: string;
  bomId: string;
  title: string;
  projectRef: string;
  productTreeRef: string;
  requesterUserId: string;
  approverUserId: string | null;
  status: string;
  managerOpinion: string | null;
  notes: string | null;
  requestDate: string;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One detail row.
 *
 * BOTH coefficient PAIRS are on the wire and NEITHER is derived here: the total a screen
 * shows is `original + delta` computed where it is rendered, exactly as the legacy form's
 * `ValueChangeScript` did — never a field of this type, because the row does not hold one.
 */
export interface ProductionBomChangeItem {
  id: string;
  changeRequestId: string;
  bomItemId: string;
  partName: string;
  changeType: string;
  originalDrawingCoefficient: number;
  originalSpareCoefficient: number;
  drawingCoefficientDelta: number | null;
  spareCoefficientDelta: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The DETAIL response: the header and ALL of its detail rows in one read. */
export interface ProductionBomChangeDetail extends ProductionBomChange {
  items: ProductionBomChangeItem[];
}

/** The register envelope — `{ items, page, pageSize, total }`, as every Production list. */
export interface ProductionBomChangePage {
  items: ProductionBomChange[];
  page: number;
  pageSize: number;
  total: number;
}

/** The register's server-side filters. `tenantId` is not one of them and never will be. */
export interface ProductionBomChangeQuery {
  page?: number;
  pageSize?: number;
  bomId?: string;
  projectRef?: string;
  status?: string;
  search?: string;
}

/** `{ search: 'پیچ' }` → `?search=...`, in a STABLE key order. */
export function buildProductionBomChangeQuery(input: ProductionBomChangeQuery = {}): string {
  return queryString([
    ['page', input.page],
    ['pageSize', cappedPageSize(input.pageSize)],
    ['bomId', input.bomId],
    ['projectRef', text(input.projectRef)],
    ['status', input.status],
    ['search', text(input.search)],
  ]);
}

/** One page of this tenant's change requests. `production.bom.read`. */
export function fetchProductionBomChangeRequests(
  query: ProductionBomChangeQuery = {}
): Promise<ProductionBomChangePage> {
  return coreGet<ProductionBomChangePage>(
    `/production/bom-change-requests${buildProductionBomChangeQuery(query)}`
  );
}

/** One change request with ALL of its detail rows, or 404 — never a partial read. */
export function fetchProductionBomChangeRequest(id: string): Promise<ProductionBomChangeDetail> {
  return coreGet<ProductionBomChangeDetail>(
    `/production/bom-change-requests/${encodeURIComponent(id)}`
  );
}


/** The CREATE payload. `projectRef` / `productTreeRef` are NOT here: they come off the BOM. */
export interface CreateProductionBomChangeInput {
  bomId: string;
  title: string;
  approverUserId: string;
  notes?: string;
}

/** The header PATCH — draft fields only, and only while the request is a DRAFT. */
export interface UpdateProductionBomChangeInput {
  title?: string;
  approverUserId?: string;
  notes?: string;
}

/**
 * One detail row as an ADD states it.
 *
 * NEITHER original belongs to this type: the snapshot is taken from the ITEM server-side
 * (S6), so a screen cannot send a history that disagrees with what it claims to snapshot.
 */
export interface CreateProductionBomChangeItemInput {
  bomItemId: string;
  changeType: ProductionBomChangeType;
  drawingCoefficientDelta?: number | null;
  spareCoefficientDelta?: number | null;
}

/**
 * The detail PATCH. THREE DISTINCT ANSWERS are expressible, and the difference matters:
 * a key ABSENT leaves the stored value alone, `null` CLEARS it, a number SETS it.
 */
export interface UpdateProductionBomChangeItemInput {
  changeType?: ProductionBomChangeType;
  drawingCoefficientDelta?: number | null;
  spareCoefficientDelta?: number | null;
}

/** Create a change request. It is created as a DRAFT with no detail rows. 201. */
export function createProductionBomChange(
  input: CreateProductionBomChangeInput
): Promise<ProductionBomChangeDetail> {
  return corePost<ProductionBomChangeDetail>('/production/bom-change-requests', input);
}

/** Change a DRAFT request's own fields. 409 once it is submitted. */
export function updateProductionBomChange(
  id: string,
  input: UpdateProductionBomChangeInput
): Promise<ProductionBomChangeDetail> {
  return corePatch<ProductionBomChangeDetail>(
    `/production/bom-change-requests/${encodeURIComponent(id)}`,
    input
  );
}

/** Add one detail row to a DRAFT request. 201. */
export function createProductionBomChangeItem(
  id: string,
  input: CreateProductionBomChangeItemInput
): Promise<ProductionBomChangeDetail> {
  return corePost<ProductionBomChangeDetail>(
    `/production/bom-change-requests/${encodeURIComponent(id)}/items`,
    input
  );
}

/** Change one detail row while the request is a DRAFT. 409 once it is submitted. */
export function updateProductionBomChangeItem(
  id: string,
  itemId: string,
  input: UpdateProductionBomChangeItemInput
): Promise<ProductionBomChangeDetail> {
  return corePatch<ProductionBomChangeDetail>(
    `/production/bom-change-requests/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
    input
  );
}

/** Remove one detail row from a DRAFT request. ONLY the detail — the BOM item is untouched. */
export function deleteProductionBomChangeItem(
  id: string,
  itemId: string
): Promise<{ id: string }> {
  return coreDelete<{ id: string }>(
    `/production/bom-change-requests/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`
  );
}

/**
 * Submit for decision: DRAFT → SUBMITTED, once, and only with at least one detail row —
 * the source's «اقلامی جهت تغییر ثبت نشده است!» arrives as `BOM_CHANGE_REQUEST_ITEMS_REQUIRED`.
 * NO BODY: the approver is the row's own frozen snapshot.
 */
export function submitProductionBomChange(id: string): Promise<ProductionBomChangeDetail> {
  return corePost<ProductionBomChangeDetail>(
    `/production/bom-change-requests/${encodeURIComponent(id)}/submit`
  );
}

/**
 * One of the three decision acts. The ROUTE states the opinion, so there is no `opinion`
 * field for a payload to rewrite — only an optional note the approver may attach.
 */
export function decideProductionBomChange(
  id: string,
  outcome: 'approve' | 'reject' | 'request-correction',
  input: { notes?: string } = {}
): Promise<ProductionBomChangeDetail> {
  return corePost<ProductionBomChangeDetail>(
    `/production/bom-change-requests/${encodeURIComponent(id)}/${outcome}`,
    input
  );
}

/**
 * This request's audit history — the SAME page shape the BOM timeline returns, because it
 * is the same platform read bound to a different server-owned resource.
 *
 * An audit outage REJECTS rather than resolving to an empty page: "nothing was recorded"
 * and "we could not ask" must not be the same outcome for a caller.
 */
export function fetchProductionBomChangeTimeline(
  id: string,
  query: ProductionBomTimelineQuery = {}
): Promise<ProductionBomTimelinePage> {
  return coreGet<ProductionBomTimelinePage>(
    `/production/bom-change-requests/${encodeURIComponent(id)}/timeline${buildProductionBomTimelineQuery(query)}`
  );
}

