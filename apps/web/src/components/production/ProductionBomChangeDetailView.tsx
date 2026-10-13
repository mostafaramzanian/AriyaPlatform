'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  PRODUCTION_BOM_CHANGE_TYPES,
  PRODUCTION_DEFAULT_PAGE_SIZE,
  createProductionBomChangeItem,
  decideProductionBomChange,
  deleteProductionBomChangeItem,
  fetchProductionBom,
  fetchProductionBomChangeRequest,
  fetchProductionBomItems,
  submitProductionBomChange,
  updateProductionBomChangeItem,
  type ProductionBom,
  type ProductionBomChangeDetail,
  type ProductionBomChangeItem,
  type ProductionBomChangeType,
  type ProductionBomItem,
  type ProductionBomStatus,
} from '@/lib/production-api';
import {
  productionBomChangeTypeLabel,
  productionBomChangeTotal,
  productionBomStatusLabel,
  productionDateLabel,
  productionErrorCode,
  productionErrorMessage,
  productionManagerOpinionLabel,
  productionPartTypeLabel,
  productionServerMessage,
} from '@/lib/production-labels';
import {
  ProductionBomStatusBadge,
  ProductionCard,
  ProductionEmptyState,
  ProductionPageHeading,
} from './production-ui';
import { ProductionBomChangeTimeline } from './ProductionBomChangeTimeline';

/**
 * Phase PRODUCTION-BOM-CHANGE: the change-request screen — `/admin/production/changes/[id]`.
 *
 * SIX FACTS, IN THE SOURCE'S OWN ORDER: the HEADER (§1 «ثبت درخواست»), the SEARCH (§2–3
 * «جست و جو بر اساس» / «نتایج جست و جو»), the SELECTED CHANGES (§4 «اقلام انتخاب شده»), the
 * APPROVAL (§5 «وضعیت تایید مافوق»), and the read-only TIMELINE below them.
 *
 * THE BACKEND IS THE SOURCE OF TRUTH. The status shown is the row's, every action is gated
 * on that status PLUS the caller's grants, and a refusal is rendered from its TYPED code —
 * so «اقلامی جهت تغییر ثبت نشده است!» and «شما قبلا جزئیات این قطعه را تغییر و ثبت نموده
 * اید» arrive as messages the screen never has to guess at.
 *
 * EVERY MUTATION SECTION IS FROZEN THE MOMENT THE ROW LEAVES `DRAFT` (S10), and a
 * correction puts it straight back: there is no separate "unfreeze" to forget, because the
 * whole gate is `status === 'DRAFT'` — the same predicate the server re-checks.
 *
 * THE DERIVED TOTAL IS SHOWN, NEVER STORED. `productionBomChangeTotal` computes
 * `original + delta` for display exactly as the source's `ValueChangeScript` did, with a
 * null delta counting as `0` and no floor at zero — the row itself carries only the two
 * pairs, and no screen writes a total back.
 *
 * NO FIELD THE BACKEND REFUSES IS RENDERED AS EDITABLE: there is no input for
 * `standardPartCode`, for an original coefficient, for a status or for a requester — each of
 * those is either read or absent.
 */
export function ProductionBomChangeDetailView({ requestId }: { requestId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('production.bom.read');
  const canManage = enforcePermissions && rbac.permissions.includes('production.bom.manage');
  const canApprove = enforcePermissions && rbac.permissions.includes('production.bom.approve');

  const [change, setChange] = React.useState<ProductionBomChangeDetail | null>(null);
  const [header, setHeader] = React.useState<ProductionBom | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  // Search section — scoped to this request's OWN BOM, never to an arbitrary one.
  const [searchInput, setSearchInput] = React.useState('');
  const [results, setResults] = React.useState<ProductionBomItem[]>([]);
  const [isSearching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  // The detail form: a chosen BOM item plus the type and the two deltas.
  const [picked, setPicked] = React.useState<ProductionBomItem | null>(null);
  const [editingItemId, setEditingItemId] = React.useState<string | null>(null);
  const [changeType, setChangeType] = React.useState<ProductionBomChangeType>('QUANTITY_CHANGE');
  const [drawingDelta, setDrawingDelta] = React.useState('');
  const [spareDelta, setSpareDelta] = React.useState('');

  const load = React.useCallback(async () => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await fetchProductionBomChangeRequest(requestId);
      setChange(detail);
      // The BOM the request points at, for the header's project / product-tree display and
      // for the search scope. A 404 here is the request's own refusal path, already shown.
      try {
        const bom = await fetchProductionBom(detail.bomId);
        setHeader(bom);
      } catch {
        setHeader(null);
      }
    } catch (err: unknown) {
      const details = err instanceof CoreApiError ? err.details : undefined;
      setError(
        productionErrorMessage(
          productionErrorCode(details),
          productionServerMessage(details) ?? 'دریافت درخواست تغییر با خطا مواجه شد.'
        )
      );
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, rbac.isLoading, canRead, requestId]);

  React.useEffect(() => {
    // Deferred to a microtask so the loader's own `setLoading(true)`/`setError(null)`
    // arm does not run synchronously inside the effect body
    // (`react-hooks/set-state-in-effect`); the flag cancels an unmount.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load, reloadToken]);

  const isDraft = change !== null && change.status === 'DRAFT';
  const isSubmitted = change !== null && change.status === 'SUBMITTED';
  /** Editable only while DRAFT — S10's `c_status == "0"` guard, restated once here. */
  const canEdit = isDraft && canManage;
  /** The approver on the row decides; the screen cannot tell the server who is who. */
  const mayDecide = isSubmitted && canApprove;

  const fail = (err: unknown, fallback: string) => {
    const details = err instanceof CoreApiError ? err.details : undefined;
    setActionError(
      productionErrorMessage(productionErrorCode(details), productionServerMessage(details) ?? fallback)
    );
  };

  const resetForm = () => {
    setPicked(null);
    setEditingItemId(null);
    setChangeType('QUANTITY_CHANGE');
    setDrawingDelta('');
    setSpareDelta('');
  };

  /**
   * Searches THIS REQUEST'S BOM for eligible items — server-side, through the EXISTING
   * `/production/boms/:bomId/items?search=` route. The scope is `change.bomId`, so the
   * screen cannot search a BOM it was not pointed at, and the keyword is matched against
   * the part name exactly as that route's own contract states.
   */
  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!change) return;
    setSearching(true);
    setSearchError(null);
    try {
      const page = await fetchProductionBomItems(change.bomId, {
        search: searchInput,
        page: 1,
        pageSize: PRODUCTION_DEFAULT_PAGE_SIZE,
      });
      setResults(page.items);
      if (page.items.length === 0) {
        setSearchError('قلی مناسبی با این عبارت در این BOM یافت نشد.');
      }
    } catch (err: unknown) {
      const details = err instanceof CoreApiError ? err.details : undefined;
      setSearchError(
        productionErrorMessage(
          productionErrorCode(details),
          productionServerMessage(details) ?? 'جستجو با خطا مواجه شد.'
        )
      );
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const pick = (item: ProductionBomItem) => {
    setPicked(item);
    setEditingItemId(null);
    setActionError(null);
  };

  const startEdit = (detail: ProductionBomChangeItem) => {
    setEditingItemId(detail.id);
    setPicked(null);
    setChangeType(detail.changeType as ProductionBomChangeType);
    setDrawingDelta(
      detail.drawingCoefficientDelta === null ? '' : String(detail.drawingCoefficientDelta)
    );
    setSpareDelta(detail.spareCoefficientDelta === null ? '' : String(detail.spareCoefficientDelta));
    setActionError(null);
  };

  /** `''` → `null` ("not stated"); anything else → the parsed integer the DTO accepts. */
  const parseDelta = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };

  const saveDetail = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!change) return;

    if (editingItemId === null && picked === null) {
      setActionError('یک قلم از نتایج جستجو انتخاب کنید.');
      return;
    }

    setBusy(true);
    setActionError(null);
    const payload = {
      changeType,
      drawingCoefficientDelta: parseDelta(drawingDelta),
      spareCoefficientDelta: parseDelta(spareDelta),
    };
    try {
      const next =
        editingItemId === null
          ? await createProductionBomChangeItem(change.id, {
              bomItemId: picked!.id,
              changeType,
              drawingCoefficientDelta: payload.drawingCoefficientDelta,
              spareCoefficientDelta: payload.spareCoefficientDelta,
            })
          : await updateProductionBomChangeItem(change.id, editingItemId, payload);
      setChange(next);
      resetForm();
    } catch (err: unknown) {
      fail(err, 'ثبت جزئیات تغییر با خطا مواجه شد.');
    } finally {
      setBusy(false);
    }
  };

  const removeDetail = async (itemId: string) => {
    if (!change) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteProductionBomChangeItem(change.id, itemId);
      if (editingItemId === itemId) resetForm();
      await load();
    } catch (err: unknown) {
      fail(err, 'حذف جزئیات تغییر با خطا مواجه شد.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: () => Promise<ProductionBomChangeDetail>, fallback: string) => {
    setBusy(true);
    setActionError(null);
    try {
      setChange(await action());
    } catch (err: unknown) {
      fail(err, fallback);
    } finally {
      setBusy(false);
    }
  };


  if (!enforcePermissions && rbac.isLoading) return <CoreLoading lines={6} />;
  if (enforcePermissions && !canRead) {
    return (
      <CoreForbidden message="برای مشاهدهٔ درخواست تغییر BOM به مجوز production.bom.read نیاز دارید." />
    );
  }
  if (isLoading) return <CoreLoading lines={6} />;
  if (error || !change) {
    return (
      <div data-testid="production-change-detail">
        <CoreError
          message={error ?? 'درخواست تغییر مورد نظر یافت نشد.'}
          onRetry={() => setReloadToken((value) => value + 1)}
        />
      </div>
    );
  }

  const inputClass =
    'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring';

  return (
    <div data-testid="production-change-detail">
      <ProductionPageHeading
        title={change.title}
        description="درخواست تغییر BOM"
        testId="production-change-detail-heading"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/production/changes"
              data-testid="production-change-back"
              className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
            >
              بازگشت به فهرست
            </Link>
            {canEdit && (
              <button
                type="button"
                data-testid="production-change-submit"
                disabled={busy}
                onClick={() =>
                  run(() => submitProductionBomChange(change.id), 'ارسال درخواست با خطا مواجه شد.')
                }
                className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                تایید و ذخیره (ارجاع برای تایید)
              </button>
            )}
          </div>
        }
      />

      {actionError && (
        <div className="mb-6" data-testid="production-change-action-error">
          <CoreError message={actionError} onRetry={() => setActionError(null)} />
        </div>
      )}

      {/* §1 — «ثبت درخواست». Every field here is READ-ONLY: the backend accepts a PATCH of
          title / approver / notes only while DRAFT, and none of these is a control the
          source let an operator rewrite after routing. */}
      <ProductionCard className="mb-6" testId="production-change-header">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="عنوان درخواست" value={change.title} testId="production-change-title" />
          <Field
            label="پروژه"
            value={change.projectRef}
            testId="production-change-project"
          />
          <Field
            label="درخت محصول"
            value={change.productTreeRef}
            testId="production-change-tree"
          />
          <Field
            label="BOM"
            value={
              <Link
                href={`/admin/production/${change.bomId}`}
                data-testid="production-change-bom-link"
                className="underline underline-offset-4"
              >
                {header?.title ?? change.bomId}
              </Link>
            }
            testId="production-change-bom"
          />
          <Field
            label="درخواست‌کننده"
            value={change.requesterUserId}
            testId="production-change-requester"
          />
          <Field
            label="مدیر تاییدکننده"
            value={change.approverUserId ?? '—'}
            testId="production-change-approver"
          />
          <Field
            label="تاریخ درخواست"
            value={productionDateLabel(change.requestDate)}
            testId="production-change-date"
          />
          <div data-testid="production-change-status-field">
            <p className="text-xs text-muted-foreground">وضعیت</p>
            <div className="mt-1">
              <ProductionBomStatusBadge status={change.status as ProductionBomStatus} />
            </div>
          </div>
          <Field
            label="نظر مدیر"
            value={productionManagerOpinionLabel(change.managerOpinion) ?? '—'}
            testId="production-change-opinion"
          />
          <Field label="توضیحات" value={change.notes ?? '—'} testId="production-change-notes" />
        </div>
      </ProductionCard>


      {/* §2–§3 — «جست و جو بر اساس» / «نتایج جست و جو». The search is SCOPED TO THIS
          REQUEST'S BOM and to nothing else; it is hidden entirely once the row is no longer
          editable, because a result set the caller cannot act on is noise (S10). */}
      {canEdit && (
        <ProductionCard className="mb-6" testId="production-change-search">
          <h2 className="mb-4 text-base font-semibold text-foreground">جست و جوی اقلام BOM</h2>

          <form onSubmit={runSearch} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
              <label htmlFor="production-change-item-search" className="text-xs text-muted-foreground">
                نام قطعه
              </label>
              <input
                id="production-change-item-search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              data-testid="production-change-item-search-submit"
              disabled={isSearching}
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              جستجو
            </button>
          </form>

          {searchError && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="production-change-search-note">
              {searchError}
            </p>
          )}

          {results.length > 0 && (
            <div className="mt-4 overflow-x-auto" data-testid="production-change-search-results">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-right text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">نام قطعه</th>
                    <th className="px-3 py-2 font-medium">نام قطعه در صنعت</th>
                    <th className="px-3 py-2 font-medium">کد استاندارد</th>
                    <th className="px-3 py-2 font-medium">نوع قطعه</th>
                    <th className="px-3 py-2 font-medium">مشخصات</th>
                    <th className="px-3 py-2 font-medium">سازنده</th>
                    <th className="px-3 py-2 font-medium">جنس</th>
                    <th className="px-3 py-2 font-medium">واحد</th>
                    <th className="px-3 py-2 font-medium">ضریب نقشه</th>
                    <th className="px-3 py-2 font-medium">ضریب یدکی/تست</th>
                    <th className="px-3 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {results.map((item) => (
                    <tr
                      key={item.id}
                      data-testid="production-change-search-row"
                      className="border-b border-border/60 last:border-b-0"
                    >
                      <td className="px-3 py-2 font-medium text-foreground">{item.partName}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {item.industryPartName ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {item.standardPartCode ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {productionPartTypeLabel(item.partType)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {item.specifications ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {item.manufacturer ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{item.material}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.measurementUnit}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {toPersianDigits(String(item.drawingConsumptionCoefficient))}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {toPersianDigits(String(item.spareConsumptionCoefficient))}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          data-testid={`production-change-pick-${item.id}`}
                          onClick={() => pick(item)}
                          className="text-xs font-medium text-foreground underline underline-offset-4"
                        >
                          انتخاب
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ProductionCard>
      )}


      {/* §4 — «اقلام انتخاب شده». The two coefficient PAIRS are shown, and the DERIVED total
          is computed here for display only — the source's `ValueChangeScript` did exactly
          that and never stored the result (S8). */}
      <ProductionCard className="mb-6" testId="production-change-items">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">اقلام انتخاب شده</h2>
          <span data-testid="production-change-item-count" className="text-xs text-muted-foreground">
            {toPersianDigits(String(change.items.length))} قلم
          </span>
        </div>

        {change.items.length === 0 ? (
          <ProductionEmptyState
            message="هنوز قلمی برای تغییر انتخاب نشده است."
            testId="production-change-items-empty"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">نام قطعه</th>
                  <th className="px-3 py-2 font-medium">نوع تغییر</th>
                  <th className="px-3 py-2 font-medium">میزان اولیه (نقشه)</th>
                  <th className="px-3 py-2 font-medium">افزایش/کاهش (نقشه)</th>
                  <th className="px-3 py-2 font-medium">میزان کل (نقشه)</th>
                  <th className="px-3 py-2 font-medium">میزان اولیه (یدکی/تست)</th>
                  <th className="px-3 py-2 font-medium">افزایش/کاهش (یدکی/تست)</th>
                  <th className="px-3 py-2 font-medium">میزان کل (یدکی/تست)</th>
                  {canEdit && <th className="px-3 py-2 font-medium" />}
                </tr>
              </thead>
              <tbody aria-busy={busy}>
                {change.items.map((item) => (
                  <tr
                    key={item.id}
                    data-testid="production-change-item-row"
                    data-change-type={item.changeType}
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3 font-medium text-foreground">{item.partName}</td>
                    <td
                      className="px-3 py-3 text-muted-foreground"
                      data-testid={`production-change-item-type-${item.id}`}
                    >
                      {productionBomChangeTypeLabel(item.changeType)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {toPersianDigits(String(item.originalDrawingCoefficient))}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {item.drawingCoefficientDelta === null
                        ? '—'
                        : toPersianDigits(String(item.drawingCoefficientDelta))}
                    </td>
                    <td
                      className="px-3 py-3 font-medium text-foreground"
                      data-testid={`production-change-item-total-drawing-${item.id}`}
                    >
                      {toPersianDigits(
                        String(
                          productionBomChangeTotal(
                            item.originalDrawingCoefficient,
                            item.drawingCoefficientDelta
                          )
                        )
                      )}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {toPersianDigits(String(item.originalSpareCoefficient))}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {item.spareCoefficientDelta === null
                        ? '—'
                        : toPersianDigits(String(item.spareCoefficientDelta))}
                    </td>
                    <td
                      className="px-3 py-3 font-medium text-foreground"
                      data-testid={`production-change-item-total-spare-${item.id}`}
                    >
                      {toPersianDigits(
                        String(
                          productionBomChangeTotal(
                            item.originalSpareCoefficient,
                            item.spareCoefficientDelta
                          )
                        )
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            data-testid={`production-change-item-edit-${item.id}`}
                            onClick={() => startEdit(item)}
                            className="text-xs font-medium text-foreground underline underline-offset-4"
                          >
                            ویرایش
                          </button>
                          <button
                            type="button"
                            data-testid={`production-change-item-delete-${item.id}`}
                            disabled={busy}
                            onClick={() => void removeDetail(item.id)}
                            className="text-xs font-medium text-destructive underline underline-offset-4 disabled:opacity-50"
                          >
                            حذف
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ProductionCard>


      {/* §4 continued — the ADD/EDIT form. The two deltas are the ONLY numeric inputs, and
          neither carries a `min`/`max`: the source's own `> 0` guards are commented out and a
          decrease is what the field is FOR. `type="number"` with `step="1"` mirrors the
          legacy `NumberTextBox` (`Decimals=0`, `Step=1`), while the server re-asserts
          integrality — the HTML attribute is convenience, never the rule. */}
      {canEdit && (
        <ProductionCard className="mb-6" testId="production-change-detail-form">
          <h2 className="mb-4 text-base font-semibold text-foreground">
            {editingItemId === null ? 'افزودن قلم به درخواست' : 'ویرایش قلم درخواست'}
          </h2>

          <p
            className="mb-4 text-xs text-muted-foreground"
            data-testid="production-change-form-target"
          >
            {editingItemId === null
              ? picked
                ? `قلم انتخاب‌شده: ${picked.partName}`
                : 'برای افزودن، ابتدا از نتایج جستجو یک قلم انتخاب کنید.'
              : 'مقادیر این قلم در حال ویرایش است.'}
          </p>

          <form onSubmit={saveDetail} className="grid gap-4 md:grid-cols-3">
            <fieldset className="flex flex-col gap-2 md:col-span-3">
              <legend className="mb-1 text-xs text-muted-foreground">نوع تغییر *</legend>
              <div className="flex flex-wrap items-center gap-4">
                {PRODUCTION_BOM_CHANGE_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name="changeType"
                      value={type}
                      data-testid={`production-change-type-${type}`}
                      checked={changeType === type}
                      onChange={() => setChangeType(type)}
                    />
                    {productionBomChangeTypeLabel(type)}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-1">
              <label htmlFor="production-change-drawing" className="text-xs text-muted-foreground">
                افزایش/کاهش ضریب مصرف (در نقشه)
              </label>
              <input
                id="production-change-drawing"
                type="number"
                step="1"
                value={drawingDelta}
                onChange={(event) => setDrawingDelta(event.target.value)}
                dir="ltr"
                disabled={changeType !== 'QUANTITY_CHANGE'}
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="production-change-spare" className="text-xs text-muted-foreground">
                افزایش/کاهش ضریب مصرف (یدکی/تست)
              </label>
              <input
                id="production-change-spare"
                type="number"
                step="1"
                value={spareDelta}
                onChange={(event) => setSpareDelta(event.target.value)}
                dir="ltr"
                disabled={changeType !== 'QUANTITY_CHANGE'}
                className={inputClass}
              />
            </div>

            <p className="text-xs text-muted-foreground md:col-span-3">
              برای نوع «تغییر موجودی» حداقل یکی از دو مقدار بالا باید وارد شود؛ برای «غیر فعال
              سازی» هیچ‌کدام لازم نیست.
            </p>

            <div className="flex flex-wrap items-center gap-2 md:col-span-3">
              <button
                type="submit"
                data-testid="production-change-detail-submit"
                disabled={busy}
                className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {editingItemId === null ? 'ثبت' : 'ذخیرهٔ تغییر'}
              </button>
              <button
                type="button"
                data-testid="production-change-detail-reset"
                onClick={resetForm}
                className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
              >
                پاک‌کردن فرم
              </button>
            </div>
          </form>
        </ProductionCard>
      )}


      {/* §5 — «وضعیت تایید مافوق». READ-ONLY here, exactly as the source's item controls were:
          `IsEnabled="False"` on the request form, because the opinion is written only from
          the approval task. The ACTIONS are shown to a `production.bom.approve` holder on a
          SUBMITTED row, and the server independently refuses anybody else. */}
      <ProductionCard className="mb-6" testId="production-change-approval">
        <h2 className="mb-2 text-base font-semibold text-foreground">وضعیت تایید مافوق</h2>
        <p
          className="text-sm text-muted-foreground"
          data-testid="production-change-approval-state"
        >
          {productionBomStatusLabel(change.status as ProductionBomStatus)}
          {change.managerOpinion
            ? ` — ${productionManagerOpinionLabel(change.managerOpinion)}`
            : ' — هنوز نظری ثبت نشده است.'}
        </p>
        {change.decidedAt && (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="production-change-decided-at"
          >
            تاریخ تصمیم: {productionDateLabel(change.decidedAt)}
          </p>
        )}

        {mayDecide && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="production-change-approve"
              disabled={busy}
              onClick={() =>
                run(
                  () => decideProductionBomChange(change.id, 'approve'),
                  'ثبت تایید با خطا مواجه شد.'
                )
              }
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              تایید
            </button>
            <button
              type="button"
              data-testid="production-change-reject"
              disabled={busy}
              onClick={() =>
                run(
                  () => decideProductionBomChange(change.id, 'reject'),
                  'ثبت رد با خطا مواجه شد.'
                )
              }
              className="inline-flex h-10 items-center rounded-xl border border-destructive/40 px-4 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              رد
            </button>
            <button
              type="button"
              data-testid="production-change-correction"
              disabled={busy}
              onClick={() =>
                run(
                  () => decideProductionBomChange(change.id, 'request-correction'),
                  'ثبت درخواست اصلاح با خطا مواجه شد.'
                )
              }
              className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              نیاز به اصلاح
            </button>
          </div>
        )}

        <p
          className="mt-4 text-xs text-muted-foreground"
          data-testid="production-change-apply-note"
        >
          تایید این درخواست فقط تصمیم را ثبت می‌کند؛ اعمال خودکار تغییر روی اقلام BOM تا تعیین
          قرارداد پیاده‌سازی نشده است.
        </p>
      </ProductionCard>

      {canRead && <ProductionBomChangeTimeline requestId={change.id} />}
    </div>
  );
}

/** A read-only header cell: a label and its value, with a test id for QA selectors. */
function Field({
  label,
  value,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm text-foreground">{value}</p>
    </div>
  );
}

